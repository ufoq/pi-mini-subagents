import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';
import { mockProvider, isolatedEnvironment } from '../fixtures/mock-provider.ts';

const mock = await mockProvider();
const { root, env } = await isolatedEnvironment(mock.url);
const bridge = spawn('python3', ['fixtures/terminal-bridge.py', 'pi', '--no-session', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '-e', './index.ts', '--model', 'mock/mock', '--thinking', 'off', '--tools', 'subagent', '--tui-mode', 'fullscreen'], { env: { ...process.env, ...env, TERM: 'xterm-256color' }, stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '', raw = '', diagnostic = '', exit: any;
bridge.stderr.on('data', c => { diagnostic += c; });
bridge.stdout.setEncoding('utf8');
bridge.stdout.on('data', c => {
  buffer += c;
  let n;
  while ((n = buffer.indexOf('\n')) >= 0) {
    const event = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1);
    if (event.type === 'output') raw += event.text;
    if (event.type === 'exit') exit = event;
  }
});
const command = (c: any) => bridge.stdin.write(JSON.stringify(c) + '\n');
const input = (text: string) => command({ type: 'input', text });
const output = () => stripVTControlCharacters(raw);
async function closeViewer() {
  input('\u001b'); await new Promise(r => setTimeout(r, 40));
  input('\u001b'); await new Promise(r => setTimeout(r, 100));
}
async function until(fn: () => boolean, label: string) {
  for (let i = 0; i < 1500; i++) {
    if (fn()) return;
    if (exit) throw new Error(`Pi exited before ${label}: ${exit.code}\n${diagnostic}\n${output().slice(-2000)}`);
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`Timed out: ${label}\n${diagnostic}\n${output().slice(-2000)}`);
}
try {
  await until(() => raw.includes('π - work'), 'native TUI startup title');
  await new Promise(r => setTimeout(r, 100));
  input('DELEGATE\r');
  await until(() => mock.childPending.length === 1 && output().includes('PARENT_CONTINUES'), 'parent continued');
  input('/agents\r');
  await until(() => output().includes('existing conversations'), 'child list');
  input('\r');
  await until(() => output().includes('Enter sends to this child'), 'existing conversation');
  mock.releaseChild();
  await until(() => output().includes('TOOL_STARTED'), 'live bash output in viewer');
  assert.ok(output().includes('MOCK_CHILD'), 'preceding task is visible');
  input('human correction: keep cobalt\r');
  await until(() => mock.childPending.length === 1, 'native bash completed and steer reached next request');
  assert.match(JSON.stringify(mock.requests.at(-1).messages), /human correction: keep cobalt/);
  // Closing the observer must not finish/stop the held child request.
  await closeViewer();
  assert.equal(mock.childPending.length, 1);
  const beforeReopen = raw.length;
  input('/agents j1\r');
  await until(() => stripVTControlCharacters(raw.slice(beforeReopen)).includes('Enter sends to this child'), 'reopen same child');
  command({ type: 'resize', rows: 24, columns: 40 });
  input('\u001b[5~'); input('\u001b[6~');
  await new Promise(r => setTimeout(r, 100));
  command({ type: 'resize', rows: 32, columns: 100 });
  mock.releaseChild();
  await until(() => mock.requests.some(r => JSON.stringify(r.messages).includes('<system-notification>')), 'idle TUI parent woke');
  const parentRequests = JSON.stringify(mock.requests.filter(r => r.tools?.some((t: any) => t.function?.name === 'subagent')));
  assert.ok(!parentRequests.includes('CHILD_SECRET_RESULT'), 'observation and completion did not inject result');
  assert.ok(!parentRequests.includes('human correction'), 'human steering stayed out of parent context');
  await closeViewer();
  input('READ\r');
  await until(() => output().includes('CHILD_SECRET_RESULT'), 'explicit read');
  input('SEND\r');
  await until(() => mock.childPending.length === 1, 'follow-up retained live child');
  assert.match(JSON.stringify(mock.requests.at(-1).messages), /MOCK_CHILD.*human correction.*follow-up recall color/s);
  const beforeFollowup = raw.length;
  mock.releaseChild();
  await until(() => stripVTControlCharacters(raw.slice(beforeFollowup)).includes('NOTICE_SEEN'), 'follow-up completion');
  input('/agents j1\r');
  const beforeStop = raw.length;
  await until(() => stripVTControlCharacters(raw.slice(beforeStop)).includes('Enter sends to this child'), 'open to stop');
  input('\u0018');
  await until(() => output().includes('j1 stopped'), 'human explicit stop');
  await closeViewer(); input('/quit\r');
  await until(() => !!exit, 'TUI orderly exit');
  assert.equal(exit.code, 0);
  console.log('PASS native TUI: list, existing/live tools, same-child steering, close/reopen, resize/scroll, idle wake, explicit read, follow-up, stop.');
} finally {
  if (!exit) command({ type: 'stop' });
  await writeFile(`${root}/tui.ansi.log`, raw);
  await writeFile(`${root}/requests.json`, JSON.stringify(mock.requests, null, 2));
  bridge.stdin.end();
  await mock.close();
  console.log(`Synthetic probe logs: ${root}`);
}
