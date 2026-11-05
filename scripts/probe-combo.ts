// Opt-in: real model + the worker's installed third-party extensions
// (powerline footer, mini-magic-context, agent-terminal bundle) alongside ours.
// Uses a temp agent dir with symlinks to installed packages/config; no writes to
// the live agent dir, sessions or config.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';

const model = process.env.MINI_SUBAGENTS_LIVE_MODEL;
if (!model) throw new Error('Opt in with MINI_SUBAGENTS_LIVE_MODEL=provider/model node scripts/probe-combo.ts (consumes tokens).');
await mkdir('tmp', { recursive: true });
const root = await mkdtemp(resolve('tmp/combo-probe-'));
const agent = resolve(root, 'agent');
await mkdir(agent, { recursive: true });
const live = resolve(homedir(), '.pi/agent');
for (const f of ['npm', 'models.json', 'models-store.json', 'auth.json']) {
  await symlink(resolve(live, f), resolve(agent, f));
}
const liveSettings = JSON.parse(await readFile(resolve(live, 'settings.json'), 'utf8'));
await writeFile(resolve(agent, 'settings.json'), JSON.stringify({ ...liveSettings, cacheWarming: 'off', retry: { enabled: false } }));
const token = `COBALT_${randomBytes(4).toString('hex')}`;
const env = {
  ...process.env,
  HOME: root,
  PI_CODING_AGENT_DIR: agent,
  PI_CODING_AGENT_SESSION_DIR: resolve(root, 'sessions'),
  XDG_DATA_HOME: resolve(root, 'data'),
  XDG_CONFIG_HOME: resolve(root, 'config'),
  XDG_CACHE_HOME: resolve(root, 'cache'),
  PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
  TERM: 'xterm-256color',
};
const bridge = spawn('python3', ['fixtures/terminal-bridge.py', 'pi', '--no-session', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '-e', './index.ts', '--model', model, '--thinking', 'off', '--tools', 'subagent', '--no-lsp', '--tui-mode', 'fullscreen'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
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
const screen = () => stripVTControlCharacters(raw);
const tail = (chars = 4000) => screen().slice(-chars);
async function until(fn: () => boolean, label: string, ms = 240000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    if (exit) throw new Error(`Pi exited before ${label}: ${exit.code}\n${diagnostic}\n${tail()}`);
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`Timed out: ${label}\n${diagnostic}\n${tail(6000)}`);
}
async function closeViewer() {
  input('\u001b'); await new Promise(r => setTimeout(r, 60));
  input('\u001b'); await new Promise(r => setTimeout(r, 150));
}
const notices = () => (screen().match(/Subagent j1 finished/g) ?? []).length;
try {
  await until(() => raw.includes('π - work'), 'native TUI startup title');
  await until(() => tail(3000).includes(model.split('/').at(-1)!), 'powerline footer renders model');
  assert.ok(!screen().includes('Failed to load extension'), `extension load error\n${tail(3000)}`);
  console.log(`Combo probe: ${model} + powerline-footer, mini-magic-context, agent-terminal; logs under ${root}`);

  input(`This is a tiny extension UI-compatibility smoke test, not a coding task. Use ONLY the subagent tool. Spawn exactly one child with this exact brief: "Do not read or change files and do not delegate. Remember the word ${token}. Use bash exactly once with command: printf CHILD_TOOL_OK; sleep 12; printf CHILD_TOOL_DONE . Then reply CHILD_READY. Keep your conversation for later follow-up." After the spawn call returns, reply exactly PARENT_CONTINUES and stop. For every later system-notification reply exactly NOTICE_SEEN and never retrieve the result automatically.\r`);
  await until(() => screen().includes('PARENT_CONTINUES'), 'parent continued before child finished');

  let listed = false;
  for (let round = 0; round < 20 && !listed; round++) {
    input('/agents\r');
    for (let i = 0; i < 10 && !listed; i++) {
      await new Promise(r => setTimeout(r, 300));
      const recent = tail(2000);
      if (recent.includes('existing conversations') && !recent.includes('No children')) listed = true;
    }
    if (!listed) { input('\u001b'); await new Promise(r => setTimeout(r, 400)); }
  }
  assert.ok(listed, `child never appeared in list\n${tail(4000)}`);
  input('\u001b');
  await new Promise(r => setTimeout(r, 150));
  let opened = false;
  for (let i = 0; i < 40 && !opened; i++) {
    input('/agents j1\r');
    for (let j = 0; j < 10 && !opened; j++) {
      await new Promise(r => setTimeout(r, 200));
      if (tail(1500).includes('Steer>')) opened = true;
    }
    if (!opened) { input('\u001b'); await new Promise(r => setTimeout(r, 300)); }
  }
  assert.ok(opened, `could not open child conversation\n${tail(4000)}`);
  await until(() => /CHILD_TOOL_|bash/.test(tail()), 'child activity visible');

  input('human correction: keep the word\r');
  await until(() => screen().includes('human correction: keep the word'), 'steer rendered in viewer');
  await closeViewer();
  await until(() => notices() >= 1, 'completion notice in parent chat');

  input('Call subagent read for j1 now, then reply READ_OK. Do not stop it.\r');
  await until(() => screen().includes('CHILD_READY'), 'explicit initial read');
  input(`Call subagent send for j1 with message: "What word did I ask you to remember?" Then reply SENT.\r`);
  await until(() => notices() >= 2, 'follow-up completion notice');
  input('Call subagent read for j1 and state the remembered word, then reply READ_OK.\r');
  await until(() => screen().includes(token), 'retained child context');

  input('/agents j1\r');
  await until(() => tail(1500).includes('Steer>'), 'reopen same child');
  input('\u0018');
  await until(() => screen().includes('j1 stopped'), 'human explicit stop');
  await closeViewer();
  input('/quit\r');
  await until(() => !!exit, 'TUI orderly exit');
  assert.equal(exit.code, 0);
  assert.ok(!screen().includes('Failed to load extension'), 'no extension load failure');
  // agent-terminal's extension registers --no-lsp (accepted above); MC initializes its store.
  const { access } = await import('node:fs/promises');
  await access(resolve(root, 'data/cortexkit/mini-magic-context/context.db'));
  console.log('PASS combo native TUI: third-party footer/extensions loaded; viewer open/close, steering, notice, read, retained context, stop, editor/exit all functional.');
} finally {
  if (!exit) command({ type: 'stop' });
  await writeFile(`${root}/tui.ansi.log`, raw);
  bridge.stdin.end();
  await new Promise(r => setTimeout(r, 300));
  if (!exit) bridge.kill('SIGKILL');
  console.log(`Probe evidence: ${root}`);
}
