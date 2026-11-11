// Opt-in: uses the existing configured provider, never installs/changes settings.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { RpcProcess } from '../rpc.ts';

const model = process.env.MINI_SUBAGENTS_LIVE_MODEL;
if (!model) throw new Error('Opt in with MINI_SUBAGENTS_LIVE_MODEL=provider/model node scripts/probe-live.ts (consumes tokens).');
await mkdir('tmp', { recursive: true });
const root = await mkdtemp(resolve('tmp/live-probe-'));
const previous = process.env.PI_CODING_AGENT_SESSION_DIR;
process.env.PI_CODING_AGENT_SESSION_DIR = resolve(root, 'sessions');
const token = `COBALT_${randomBytes(4).toString('hex')}`;
const events: any[] = [], failures: string[] = [];
const cli = process.env.MINI_SUBAGENTS_PI_CLI;
const command = cli ? process.execPath : 'pi';
const prefix = cli ? [resolve(cli)] : [];
const extension = resolve(process.env.MINI_SUBAGENTS_EXTENSION ?? './index.ts');
const version = execFileSync(command, [...prefix, '--version'], { encoding: 'utf8' }).trim();
const rpc = new RpcProcess({ command, args: [...prefix, '--mode', 'rpc', '--no-session', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '-e', extension, '--model', model, '--thinking', 'off', '--tools', 'subagent'], cwd: process.cwd() }, e => events.push(e), e => failures.push(e.message));
const settled = () => events.filter(e => e.type === 'agent_settled').length;
const toolResults = () => events.filter(e => e.type === 'tool_execution_end');
const notifications = () => events.filter(e => e.type === 'message_end' && e.message?.role === 'custom');
async function until(fn: () => boolean, label: string) {
  const start = Date.now();
  while (Date.now() - start < 120000) {
    if (fn()) return;
    if (failures.length) throw new Error(failures.join('\n'));
    const error = events.findLast(e => e.type === 'message_end' && e.message?.stopReason === 'error');
    if (error) throw new Error(error.message.errorMessage);
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`Probe deadline: ${label}`);
}
const prompt = (message: string) => rpc.request('prompt', { message, streamingBehavior: 'steer' });
try {
  const state = await rpc.request('get_state');
  assert.equal(`${state.model.provider}/${state.model.id}`, model);
  const marker = resolve(root, 'child-bash-marker');
  console.log(`Real-model smoke: ${model}; Pi ${version}; uid=${process.getuid?.()}; scratch under ${root}`);
  await prompt(`This is a tiny extension smoke test, not a coding task. Use ONLY the subagent tool. First spawn exactly one child with this exact task brief: "Do not read or change files, delegate, or use network. Remember the word ${token}. Use bash exactly once with command: printf CHILD_TOOL_OK; sleep 2; printf CHILD_TOOL_DONE > ${marker} . Then reply CHILD_READY. Preserve your conversation for later follow-up." After spawn, reply PARENT_CONTINUES. Do not list/read/send/stop yet. For any later system-notification, reply NOTICE_SEEN only; never automatically retrieve a child result. Wait for an explicit human request to read or follow up.`);
  await until(() => toolResults().some(e => /j\d+-[a-z0-9]+ starting/.test(JSON.stringify(e.result))), 'spawn accepted');
  const childId = /(j\d+-[a-z0-9]+) starting/.exec(JSON.stringify(toolResults()))?.[1];
  assert.ok(childId, 'spawn reply contains a timestamped child id');
  const children = execFileSync('ps', ['-o', 'pid=,args=', '--ppid', String(rpc.pid)], { encoding: 'utf8' }).trim();
  if (cli) assert.ok(children.includes(resolve(cli)), 'child uses pinned Pi CLI');
  console.log('Spawn returned; waiting for child completion.');
  await until(() => notifications().length === 1 && settled() >= 1, 'completion and parent wake');
  await until(() => events.some(e => e.type === 'message_end' && JSON.stringify(e.message).includes('NOTICE_SEEN')), 'notice consumed');
  assert.ok(!toolResults().some(e => JSON.stringify(e.result).includes('CHILD_READY')), 'no automatic read');
  assert.ok(!JSON.stringify(notifications()).includes('CHILD_READY'));
  assert.ok(events.findIndex(e => e.type === 'agent_settled') < events.findIndex(e => e.type === 'message_end' && e.message?.role === 'custom'), 'parent was idle before completion');
  console.log('Completion-only notice consumed; explicitly reading result.');
  const count = settled(), beforeFirstRead = toolResults().length;
  await prompt(`Now explicitly call subagent read for ${childId}. Then reply READ_OK.`);
  await until(() => settled() > count && toolResults().slice(beforeFirstRead).some(e => JSON.stringify(e.result).includes('CHILD_READY')), 'explicit read');
  console.log('Initial result verified; sending context-retention follow-up.');
  const beforeSend = notifications().length;
  await prompt(`Call subagent send for ${childId} with message: "Without tools, reply with the word I asked you to remember in your first task." Then reply SENT. On its completion notice reply NOTICE_SEEN, do not read automatically.`);
  await until(() => notifications().length > beforeSend, 'same-child follow-up completion');
  const beforeRead = settled(), beforeSecondRead = toolResults().length;
  await prompt(`Explicitly call subagent read for ${childId} now. Then reply READ_OK.`);
  await until(() => settled() > beforeRead && toolResults().slice(beforeSecondRead).some(e => JSON.stringify(e.result).includes(token)), 'retained child context');
  console.log('Retained context verified; stopping child.');
  const beforeStop = toolResults().length, beforeStopSettled = settled();
  await prompt(`Call subagent stop for ${childId}. Then reply STOP_OK.`);
  await until(() => toolResults().slice(beforeStop).some(e => JSON.stringify(e.result).includes(`${childId} stopped`)), 'explicit stop');
  await until(() => settled() > beforeStopSettled, 'parent settled after stop');
  await rpc.closeInput();
  const files = (await readdir(resolve(root, 'sessions'), { recursive: true }).catch(() => [])).filter(f => String(f).endsWith('.jsonl'));
  assert.equal(files.length, 0, 'children keep no resume-visible session');
  assert.match(await readFile(marker, 'utf8'), /CHILD_TOOL_OKCHILD_TOOL_DONE/, 'actual child bash result');
  const assistants = events.filter(e => e.type === 'message_end' && e.message?.role === 'assistant').map(e => e.message);
  const tokens = assistants.reduce((sum, m) => sum + (m.usage?.totalTokens ?? 0), 0);
  console.log(`PASS real-model: spawn, actual bash result, completion-only notice/idle wake, explicit read, context-preserving follow-up, stop. Parent assistant tokens (including cache): ${tokens}.`);
  await writeFile(`${root}/summary.json`, JSON.stringify({ model, version, uid: process.getuid?.(), cli: cli ?? 'pi on PATH', extension, children, token, parentAssistantMessages: assistants.length, parentTokensIncludingCache: tokens, notifications: notifications().map(e => e.message.content) }, null, 2));
} finally {
  await rpc.stop();
  await writeFile(`${root}/events.json`, JSON.stringify(events, null, 2));
  if (previous === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR; else process.env.PI_CODING_AGENT_SESSION_DIR = previous;
  console.log(`Probe evidence: ${root}`);
}
