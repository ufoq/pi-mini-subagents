import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RpcProcess } from './rpc.ts';
import { mockProvider, isolatedEnvironment } from './fixtures/mock-provider.ts';

function ownedTree(root: number): number[] {
  const rows = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const owned = new Set([root]);
  for (let size = 0; size !== owned.size;) {
    size = owned.size;
    for (const [pid, ppid] of rows) if (owned.has(ppid)) owned.add(pid);
  }
  return [...owned].filter(pid => pid !== root);
}
function alive(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
  } catch { return false; }
}
/** True once any child transcript persisted the given text, so no fixed sleep is needed. */
function childWrote(root: string, needle: string) {
  const dir = resolve(root, 'sessions');
  try {
    for (const file of readdirSync(dir, { recursive: true }) as string[]) {
      if (file.endsWith('.jsonl') && readFileSync(resolve(dir, file), 'utf8').includes(needle)) return true;
    }
  } catch { /* session dir not created yet */ }
  return false;
}
async function until(fn: () => boolean, label: string) {
  for (let i = 0; i < 1000; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); }
  assert.fail(`Timed out: ${label}`);
}

test('native RPC parent: immediate launch, idle wake, explicit read, busy follow-up and shutdown', async () => {
  const mock = await mockProvider();
  const { root, env } = await isolatedEnvironment(mock.url);
  const oldEnv = { ...process.env };
  Object.assign(process.env, env);
  const events: any[] = [];
  const failures: Error[] = [];
  const rpc = new RpcProcess({ command: 'pi', args: ['--mode', 'rpc', '--no-session', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '-e', './index.ts', '--model', 'mock/mock', '--thinking', 'off', '--tools', 'subagent'], cwd: process.cwd() }, e => events.push(e), e => failures.push(e));
  const text = (e: any) => JSON.stringify(e);
  const settled = () => events.filter(e => e.type === 'agent_settled').length;
  const notifications = () => events.filter(e => e.type === 'message_end' && e.message?.role === 'custom');
  const prompt = (message: string) => rpc.request('prompt', { message, streamingBehavior: 'steer' });
  try {
    assert.ok((await rpc.request('get_state')).sessionId);
    await prompt('/agents');
    assert.ok(events.some(e => e.type === 'extension_ui_request' && e.method === 'notify'));
    assert.equal(events.filter(e => e.type === 'extension_ui_request' && e.method !== 'notify').length, 0);
    await prompt('DELEGATE');
    await until(() => settled() === 1 && mock.childPending.length === 1, 'parent continues before child finishes');
    assert.equal(notifications().length, 0);
    assert.ok(events.some(e => e.type === 'tool_execution_end' && text(e).includes('j1 starting')));
    assert.ok(events.some(e => e.type === 'message_end' && text(e).includes('PARENT_CONTINUES')));
    mock.releaseChild(); // Child uses real native bash.
    await until(() => mock.childPending.length === 1, 'child tool completed');
    mock.releaseChild();
    await until(() => settled() === 2, 'idle parent woke on completion');
    assert.equal(notifications().length, 1);
    const notice = notifications()[0].message;
    assert.equal(notice.customType, 'mini-subagent-completion');
    assert.match(notice.content, /<system-notification>.*j1 finished.*available/s);
    assert.ok(!notice.content.includes('CHILD_SECRET_RESULT'));
    assert.ok(events.some(e => e.type === 'message_end' && text(e).includes('NOTICE_SEEN')));
    assert.ok(!events.some(e => text(e).includes('CHILD_SECRET_RESULT')), 'no automatic result/transcript injected');
    const beforeRead = settled();
    await prompt('READ');
    await until(() => settled() > beforeRead, 'explicit result retrieval');
    assert.ok(events.some(e => e.type === 'tool_execution_end' && text(e).includes('CHILD_SECRET_RESULT cobalt')));

    await prompt('SEND');
    await until(() => mock.childPending.length === 1, 'follow-up child request');
    await until(() => settled() === beforeRead + 2, 'send parent settled');
    const beforeBusy = settled();
    await prompt('BUSY');
    await until(() => mock.busyPending.length === 1, 'parent busy');
    mock.releaseChild();
    // Hold the parent provider response across a real child completion instead of
    // sleeping: the child's own transcript is the completion evidence.
    await until(() => childWrote(root, 'follow-up recall color'), 'child finished while parent busy');
    assert.equal((await rpc.request('get_state')).isStreaming, true, 'parent still busy');
    assert.equal(notifications().length, 1, 'custom follow-up not inserted mid-response');
    assert.equal(settled(), beforeBusy, 'busy parent not interrupted');
    mock.releaseBusy();
    await until(() => settled() > beforeBusy, 'busy follow-up delivered');
    assert.equal(notifications().length, 2);
    const childRequests = mock.requests.filter(r => !r.tools?.some((t: any) => t.function?.name === 'subagent'));
    const followup = childRequests.at(-1);
    assert.match(JSON.stringify(followup.messages), /MOCK_CHILD remember cobalt/);
    assert.match(JSON.stringify(followup.messages), /follow-up recall color/);
    const shell = process.platform === 'win32' ? 'powershell' : 'bash';
    assert.deepEqual(followup.tools.map((t: any) => t.function.name).sort(), [shell, 'edit', 'find', 'grep', 'ls', 'read', 'write'].sort());
    assert.ok(!followup.tools.some((t: any) => t.function.name === 'subagent'), 'child cannot delegate');
    const count = settled();
    await prompt('STOP'); await until(() => settled() > count, 'explicit stop');
    assert.ok(events.some(e => e.type === 'tool_execution_end' && text(e).includes('j1 stopped')));
    assert.deepEqual(failures, []);
    // Leave a second child running, then close only parent stdin. This proves
    // session_shutdown cleanup, rather than the harness killing the whole tree.
    const beforeShutdown = settled();
    await prompt('DELEGATE again');
    await until(() => settled() > beforeShutdown && mock.childPending.length === 1, 'second child live');
    mock.releaseChild(); // Start the second child's real bash/sleep descendants.
    await until(() => ownedTree(rpc.pid!).length >= 3, 'active native bash descendants');
    const owned = ownedTree(rpc.pid!);
    assert.ok(owned.length >= 3 && owned.every(pid => pid > 0));
    await rpc.closeInput();
    await until(() => owned.every(pid => !alive(pid)), 'shutdown released children and active bash descendants');
  } finally {
    // EOF lets Pi run session_shutdown, unlike killing its outer process group.
    // RpcProcess.stop also provides bounded owned-tree cleanup as a final guard.
    await rpc.stop(); await mock.close();
    for (const key of Object.keys(env)) {
      if (oldEnv[key] === undefined) delete process.env[key]; else process.env[key] = oldEnv[key];
    }
  }
});
