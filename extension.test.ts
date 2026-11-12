import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { load } from './fixtures/pi-loader.ts';
import { Agents } from './agents.ts';
import { RpcProcess } from './rpc.ts';
const { default: register, completionNotification, createCompletionNotifier, sendNotices, noticeNotification, parseModel, listReply, startingReply } = await load.import('../index.ts');
const { AgentViewer } = await load.import('../viewer.ts');
const { visibleWidth, CURSOR_MARKER } = await load.import('@earendil-works/pi-tui');
const { initTheme, ToolExecutionComponent } = await load.import('@earendil-works/pi-coding-agent');
// initTheme is public and initializes the native renderers, just as Pi does.
initTheme('dark');

function adapter() {
  const tools: any[] = [], commands: any[] = [], sent: any[] = [];
  const handlers = new Map<string, any>();
  register({
    registerTool: (tool: any) => tools.push(tool), registerCommand: (name: string, command: any) => commands.push({ name, ...command }),
    on: (name: string, handler: any) => handlers.set(name, handler), sendMessage: (...args: any[]) => sent.push(args),
  });
  return { tools, commands, sent, handlers };
}

test('one compact tool, actionable validation, exact completion-only delivery and RPC UI guard', async () => {
  const { tools, commands, sent, handlers } = adapter();
  assert.equal(tools.length, 1); assert.equal(tools[0].name, 'subagent');
  assert.ok(Buffer.byteLength(JSON.stringify(tools[0].parameters)) < 700);
  assert.ok(tools[0].parameters.properties.preset);
  assert.ok(tools[0].parameters.properties.thinking);
  assert.ok(tools[0].parameters.properties.tools);
  assert.match(tools[0].promptGuidelines.join(' '), /list.*presets/i);
  assert.match(tools[0].promptGuidelines.join(' '), /bash sleep/i);
  assert.match(tools[0].promptGuidelines.join(' '), /end the turn/i);
  assert.equal(tools[0].parameters.properties.system_append, undefined, 'system_append is preset-only, never a tool argument');
  const ctx = { mode: 'rpc', cwd: process.cwd(), isProjectTrusted: () => false, ui: { notify() {}, custom() { assert.fail('terminal UI in RPC'); } } };
  await handlers.get('session_start')({}, ctx);
  const execute = (params: any) => tools[0].execute('t', params, undefined, undefined, ctx);
  assert.match((await execute({ action: 'list' })).content[0].text, /No subagents[\s\S]*Presets: /);
  await assert.rejects(execute({ action: 'read' }), /id is required/);
  await assert.rejects(execute({ action: 'send', id: 'missing', message: 'hello' }), /Unknown/);
  await commands[0].handler('', ctx);
  await handlers.get('session_shutdown')({}, ctx);
  assert.equal(sent.length, 0);
  const content = completionNotification([{ id: 'j1', outcome: 'failed' }]);
  assert.match(content, /^<system-notification>\nSubagent j1 failed\./);
  assert.match(content, /subagent remove releases the process and transcript/);
  assert.ok(!content.includes('SECRET RESULT'));
  const reminder = noticeNotification([{ id: 'j1-abc', minutes: 10 }]);
  assert.match(reminder, /has been running for 10 minutes/);
  assert.ok(!reminder.includes('Settled children stay in memory'));
  assert.equal(startingReply('j1'), 'j1 active. Continue independent work. When only subagent-dependent work remains, end your turn; do not wait with shell sleep or polling. Completion will wake you; use subagent read for results.');
  assert.match(startingReply('j1', { provider: 'mock', id: 'alias/model' }), /active on mock\/alias\/model/);
  assert.match(startingReply('j1', { provider: 'mock', id: 'mock' }, 'oracle'), /^j1 active \(oracle\) on mock\/mock\./);
  assert.match(listReply([{ id: 'j1', status: 'stopped', task: 'review', preset: 'oracle' }]), /j1 stopped \(oracle\): review/);
  assert.ok(!startingReply('j1', { provider: 'p\x1b]52;c;SECRET\x07', id: 'model' }).includes('SECRET'), 'inherited model echo is sanitized');
  assert.match(listReply([{ id: 'j1', status: 'stopped', task: 'review' }]), /subagent remove releases the process and transcript/);
  assert.ok(!listReply([{ id: 'j1', status: 'active', task: 'review' }]).includes('subagent remove'));
  assert.equal(listReply([]), 'No subagents.');
  assert.equal(listReply([], 'Presets: none.'), 'No subagents.\nPresets: none.');
  assert.equal(parseModel(undefined), undefined);
  assert.deepEqual(parseModel('anthropic/claude-sonnet-4-5'), { provider: 'anthropic', id: 'claude-sonnet-4-5' });
  // Model ids themselves may contain slashes.
  assert.deepEqual(parseModel(' litellm/ollama-cloud/deepseek-v4.1-flash '), { provider: 'litellm', id: 'ollama-cloud/deepseek-v4.1-flash' });
  assert.throws(() => parseModel('claude-sonnet-4-5'), /provider\/model/);
  assert.throws(() => parseModel('/model'), /provider\/model/);
  assert.throws(() => parseModel('provider/'), /provider\/model/);
  assert.throws(() => parseModel('mock/bad\u0000id'), /control characters/);
  assert.throws(() => parseModel('mock/bad\u001bid'), /control characters/);
  assert.throws(() => parseModel('mock/bad\u009bid'), /control characters/);
});

test('completion notices coalesce into one steer message per boundary', async () => {
  const batches: any[][] = [];
  const notifier = createCompletionNotifier(batch => batches.push(batch), 10);
  // Idle: a burst coalesces after the short wake window.
  notifier.add('j1', 'finished');
  notifier.add('j2', 'failed');
  assert.deepEqual(batches, []);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(batches, [[{ id: 'j1', outcome: 'finished' }, { id: 'j2', outcome: 'failed' }]]);
  // Busy: hold every completion until the turn boundary, then send one message.
  notifier.startRun();
  notifier.add('j3', 'finished');
  notifier.add('j4', 'finished');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(batches.length, 1, 'busy parent is not interrupted while the turn runs');
  notifier.boundary();
  assert.deepEqual(batches[1], [{ id: 'j3', outcome: 'finished' }, { id: 'j4', outcome: 'finished' }]);
  // A completion after the last turn boundary is flushed when the run ends.
  notifier.add('j5', 'failed');
  assert.equal(batches.length, 2);
  notifier.endRun();
  assert.deepEqual(batches[2], [{ id: 'j5', outcome: 'failed' }]);
  // agent_end is not idle: retry backoff keeps batching until the next run starts.
  notifier.add('j6', 'finished');
  notifier.add('j7', 'finished');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(batches.length, 3);
  notifier.startRun();
  assert.deepEqual(batches[3], [{ id: 'j6', outcome: 'finished' }, { id: 'j7', outcome: 'finished' }]);
  // Settlement enables idle batching again.
  notifier.settled();
  notifier.add('j8', 'finished');
  notifier.add('j9', 'failed');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(batches[4], [{ id: 'j8', outcome: 'finished' }, { id: 'j9', outcome: 'failed' }]);
  assert.equal(completionNotification(batches[1] as any).match(/<system-notification>/g)?.length, 1);
  notifier.clear();
});

test('completion delivery is one steer message with every finished id', async () => {
  const sent: any[] = [];
  const pi = { sendMessage: (...args: any[]) => sent.push(args) };
  await sendNotices(pi as any, [{ id: 'j1', outcome: 'finished' }, { id: 'j2', outcome: 'failed' }]);
  assert.equal(sent.length, 1);
  const [message, options] = sent[0];
  assert.equal(message.customType, 'mini-subagent-notice');
  assert.equal(options.deliverAs, 'steer');
  assert.equal(options.triggerTurn, true);
  assert.match(message.content, /Subagent j1 finished/);
  assert.match(message.content, /Subagent j2 failed/);
  assert.equal(message.content.match(/<system-notification>/g)?.length, 1);
});

test('reminders coalesce per child and share message boundaries', async () => {
  const batches: any[][] = [];
  const notifier = createCompletionNotifier(batch => batches.push(batch), 10);
  notifier.remind('j1', 10);
  notifier.remind('j1', 20);
  notifier.remind('j2', 30);
  assert.deepEqual(batches, []);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(batches, [[{ id: 'j1', minutes: 20 }, { id: 'j2', minutes: 30 }]]);

  notifier.startRun();
  notifier.remind('j1', 30);
  notifier.add('j1', 'finished');
  notifier.boundary();
  assert.deepEqual(batches[1], [{ id: 'j1', outcome: 'finished' }], 'completion supersedes a reminder');

  notifier.remind('j2', 40);
  notifier.cancel('j2');
  notifier.boundary();
  assert.equal(batches.length, 2, 'cancel removes a pending reminder');

  notifier.remind('j3', 10);
  notifier.add('j4', 'failed');
  notifier.boundary();
  assert.deepEqual(batches[2], [{ id: 'j4', outcome: 'failed' }, { id: 'j3', minutes: 10 }]);
  assert.match(noticeNotification(batches[2] as any), /Subagent j3 has been running for 10 minutes/);
  assert.match(noticeNotification(batches[2] as any), /Stopped children stay readable/);
  notifier.clear();
});

test('drop removes both a queued completion and reminder for a removed child', async () => {
  const batches: any[][] = [];
  const notifier = createCompletionNotifier(batch => batches.push(batch), 10);
  notifier.startRun();
  notifier.add('j1', 'finished');
  notifier.remind('j1', 10);
  notifier.add('j2', 'failed');
  notifier.drop('j1');
  notifier.boundary();
  assert.deepEqual(batches, [[{ id: 'j2', outcome: 'failed' }]], 'drop leaves other children unaffected');
  notifier.clear();
});

test('presets action lists config and an unknown preset starts no child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mini-ext-presets-'));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const { tools } = adapter();
  const ctx = { mode: 'rpc', cwd: process.cwd(), isProjectTrusted: () => false, ui: { notify() {}, custom() {} } };
  const execute = (params: any) => tools[0].execute('t', params, undefined, undefined, ctx);
  try {
    await mkdir(join(root, 'subagent-presets'));
    await writeFile(join(root, 'subagent-presets', 'oracle.md'), `---
name: oracle
description: offline preset
tools: read, grep
---
SYSTEM
`);
    const listing = await execute({ action: 'presets' });
    assert.match(listing.content[0].text, /oracle \(user\)/);
    assert.match((await execute({ action: 'list' })).content[0].text, /Presets: oracle/);
    await assert.rejects(execute({ action: 'spawn', preset: 'missing', message: 'x' }), /Unknown subagent preset/);
    assert.match((await execute({ action: 'list' })).content[0].text, /No subagents/);
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
    await rm(root, { recursive: true, force: true });
  }
});

test('project presets follow Pi project trust', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mini-ext-trust-'));
  const agentDir = join(root, 'agent');
  const project = join(root, 'project');
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let trusted = false;
  const { tools } = adapter();
  const ctx = { mode: 'rpc', cwd: project, isProjectTrusted: () => trusted, ui: { notify() {}, custom() {} } };
  const execute = (params: any) => tools[0].execute('t', params, undefined, undefined, ctx);
  try {
    await mkdir(join(agentDir, 'subagent-presets'), { recursive: true });
    await mkdir(join(project, '.pi', 'subagent-presets'), { recursive: true });
    await writeFile(join(agentDir, 'subagent-presets', 'shared.md'), `---
name: shared
description: user
---
USER
`);
    await writeFile(join(project, '.pi', 'subagent-presets', 'oracle.md'), `---
name: oracle
description: project
---
PROJECT
`);

    const untrusted = await execute({ action: 'presets' });
    assert.match(untrusted.content[0].text, /shared \(user\)/);
    assert.doesNotMatch(untrusted.content[0].text, /oracle/);

    trusted = true;
    const listing = await execute({ action: 'presets' });
    assert.match(listing.content[0].text, /oracle \(project\)/);
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
    await rm(root, { recursive: true, force: true });
  }
});

test('viewer lists newest subagents first', async () => {
  const agents = new Agents(() => {});
  const first = agents.spawn('first task', { command: process.execPath, args: ['fixtures/fake-rpc.mjs'], cwd: process.cwd() });
  const second = agents.spawn('second task', { command: process.execPath, args: ['fixtures/fake-rpc.mjs'], cwd: process.cwd() });
  // ANSI-emitting theme: padding and truncation must still be exact at terminal widths.
  const theme = { fg: (_: string, s: string) => `\x1b[36m${s}\x1b[0m`, bg: (_: string, s: string) => `\x1b[48;5;24m${s}\x1b[0m`, bold: (s: string) => `\x1b[1m${s}\x1b[0m` };
  const tui = { requestRender() {}, terminal: { rows: 24 } };
  const viewer: any = new AgentViewer(agents, tui, theme, () => {}, process.cwd());
  try {
    const lines = viewer.render(100);
    assert.ok(lines[0].includes('╭') && lines.at(-1)!.includes('╰'), 'wide overlay is framed');
    assert.ok(lines.every((line: string) => visibleWidth(line) === 100), 'frame fills the requested width');
    assert.ok(lines.slice(2, -2).every((line: string) => line.includes('│')), 'content rows are bordered');
    const order = lines.map((line: string) => /j\d+-[a-z0-9]+/.exec(line)?.[0]).filter(Boolean);
    assert.deepEqual(order.slice(0, 2), [second, first], 'newest child on top');
    // ↓ selects the second row, which is now the older child.
    viewer.focused = true; viewer.handleInput('\u001b[B'); viewer.handleInput('\r');
    assert.match(viewer.render(100).join('\n'), new RegExp(`${first} `), 'opens the older child under the cursor');
  } finally { viewer.dispose(); await agents.shutdown(); }
});

test('viewer falls back safely when the selected child is removed', async () => {
  const agents = new Agents(() => {});
  const id = agents.spawn('removable task', { command: process.execPath, args: ['fixtures/fake-rpc.mjs'], cwd: process.cwd() });
  const theme = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s };
  const viewer: any = new AgentViewer(agents, { requestRender() {}, terminal: { rows: 24 } }, theme, () => {}, process.cwd(), id);
  try {
    assert.match(viewer.render(80).join('\n'), new RegExp(id));
    await agents.remove(id);
    const lines = viewer.render(80).join('\n');
    assert.doesNotMatch(lines, new RegExp(id), 'the removed child disappears');
    assert.match(lines, /No children/i, 'the viewer returns to the empty list');
    viewer.handleInput('\r');
  } finally { viewer.dispose(); await agents.shutdown(); }
});

test('viewer shows the preset on a child in both list and detail views', async () => {
  const agents = new Agents(() => {});
  const id = agents.spawn('preset task', { command: process.execPath, args: ['fixtures/fake-rpc.mjs'], cwd: process.cwd() }, 'oracle');
  const theme = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s };
  const viewer: any = new AgentViewer(agents, { requestRender() {}, terminal: { rows: 24 } }, theme, () => {}, process.cwd(), id);
  try {
    assert.match(viewer.render(80).join('\n'), new RegExp(`${id} \\(oracle\\)`));
    viewer.handleInput('\u001b');
    assert.match(viewer.render(80).join('\n'), new RegExp(`${id} \\(oracle\\)`));
  } finally { viewer.dispose(); await agents.shutdown(); }
});

test('viewer keeps its cursor, states input intent and fits narrow hints', async () => {
  const agents = new Agents(() => {});
  const first = agents.spawn('first task', { command: process.execPath, args: ['fixtures/fake-rpc.mjs'], cwd: process.cwd() });
  const second = agents.spawn('second task', { command: process.execPath, args: ['fixtures/fake-rpc.mjs'], cwd: process.cwd() });
  const ansi = { fg: (_: string, s: string) => `\x1b[36m${s}\x1b[0m`, bg: (_: string, s: string) => `\x1b[48;5;24m${s}\x1b[0m`, bold: (s: string) => `\x1b[1m${s}\x1b[0m` };
  const tui = { requestRender() {}, terminal: { rows: 24 } };
  const wait = async (fn: () => boolean) => {
    for (let i = 0; i < 1000; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); }
    assert.fail('condition not reached');
  };
  const viewer: any = new AgentViewer(agents, tui, ansi, () => {}, process.cwd());
  try {
    // Cursor starts on the newest child, then moves to the older one.
    assert.match(viewer.render(60).join('\n'), new RegExp(`> ${second} `));
    viewer.focused = true; viewer.handleInput('\u001b[B');
    assert.match(viewer.render(60).join('\n'), new RegExp(`> ${first} `));
    // A new child must not steal the highlight.
    const third = agents.spawn('third task', { command: process.execPath, args: ['fixtures/fake-rpc.mjs'], cwd: process.cwd() });
    assert.match(viewer.render(60).join('\n'), new RegExp(`> ${first} `), 'inserts keep the cursor on the same id');
    // Enter opens the highlighted child, not the newest one.
    viewer.handleInput('\r');
    const detail = viewer.render(60).join('\n');
    assert.match(detail, new RegExp(`${first} `));
    assert.match(detail, /PgUp\/PgDn/, 'Enter opened the conversation, not just the list');
    // Selection highlight covers the full inner width even when the label truncates.
    viewer.handleInput('\u001b'); // back to the list
    const row = viewer.render(40).find((line: string) => line.includes('\x1b[48;5;24m'));
    const highlight = /\x1b\[48;5;24m([\s\S]*?)\x1b\[0m/.exec(row!)?.[1] ?? '';
    assert.equal(visibleWidth(highlight), 36, 'highlight spans border-padded inner width');
    // Finished children get a new-turn label; stopped children accept a new turn.
    await wait(() => agents.snapshot(first).status === 'active');
    const rpc = (agents as any).children.get(first).rpc;
    await rpc.request('finish'); await rpc.request('settle');
    await wait(() => agents.snapshot(first).status === 'stopped');
    viewer.handleInput('\r');
    assert.match(viewer.render(60).join('\n'), /Enter→new turn/, 'finished child starts a new turn');
    await agents.stop(first);
    assert.match(viewer.render(60).join('\n'), /Enter→new turn/);
    const before = agents.snapshot(first).messages.length;
    viewer.handleInput('accepted after stop');
    assert.equal(viewer.input.getValue(), 'accepted after stop', 'a stopped child accepts input');
    viewer.handleInput('\r');
    await wait(() => agents.snapshot(first).messages.length > before);
    assert.ok(agents.snapshot(first).messages.length > before, 'a stopped child starts a new turn');
    // Exactly one row carries the selection background.
    viewer.handleInput('\u001b');
    assert.equal((viewer.render(40).join('\n').match(/\x1b\[48;5;24m/g) ?? []).length, 1);
    // The frame appears at 32 columns and not below it.
    assert.ok(!viewer.render(31).some((line: string) => line.includes('╭')));
    assert.ok(viewer.render(32).some((line: string) => line.includes('╭')));
    // Total height stays inside the overlay's 90% cap, small and tall terminals alike.
    for (const rows of [7, 12, 24, 80]) {
      const sized: any = new AgentViewer(agents, { requestRender() {}, terminal: { rows } }, ansi, () => {}, process.cwd(), first);
      try {
        const lines = sized.render(80);
        assert.ok(lines.length <= Math.floor(rows * 0.9), `overlay fits ${rows} rows`);
      } finally { sized.dispose(); }
    }
    // Narrow widths keep a hint that fits, and never exceed the width.
    for (const width of [12, 30]) {
      const lines = viewer.render(width);
      assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
      assert.match(lines.map((l: string) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n'), /↑/, 'a navigation hint survives narrow widths');
    }
    assert.ok(third);
  } finally { viewer.dispose(); await agents.shutdown(); }
});

test('viewer keeps the input visible on short terminals and highlights truncated rows fully', async () => {
  const long = `start ${'lorem ipsum '.repeat(20)}end`;
  const agents = new Agents(() => {});
  const id = agents.spawn(long, { command: process.execPath, args: ['fixtures/fake-rpc.mjs'], cwd: process.cwd() });
  const ansi = { fg: (_: string, s: string) => `\x1b[36m${s}\x1b[0m`, bg: (_: string, s: string) => `\x1b[48;5;24m${s}\x1b[0m`, bold: (s: string) => `\x1b[1m${s}\x1b[0m` };
  const bgColumns = (line: string) => {
    let active = false; let columns = 0;
    for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
      if (part === '\x1b[48;5;24m') { active = true; continue; }
      if (part === '\x1b[0m') { active = false; continue; }
      if (part.startsWith('\x1b[')) continue;
      if (active) columns += visibleWidth(part);
    }
    return columns;
  };
  const wait = async (fn: () => boolean) => {
    for (let i = 0; i < 1000; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); }
    assert.fail('condition not reached');
  };
  const viewer: any = new AgentViewer(agents, { requestRender() {}, terminal: { rows: 24 } }, ansi, () => {}, process.cwd(), id);
  try {
    await wait(() => agents.snapshot(id).status === 'active');
    // Truncated row: the ellipsis and the padding after it stay highlighted.
    viewer.handleInput('\u001b'); // back to the list
    const list = viewer.render(40);
    const row = list.find((line: string) => line.includes('\x1b[48;5;24m'))!;
    assert.match(row.replace(/\x1b\[[0-9;]*m/g, ''), /\.\.\./, 'the label is truncated');
    assert.equal(bgColumns(row), 36, 'highlight covers the whole inner row after resets');
    // Short terminals keep the input line instead of clipping it away, down to one row.
    for (const rows of [1, 2, 3, 7, 9, 11, 16]) {
      const sized: any = new AgentViewer(agents, { requestRender() {}, terminal: { rows } }, ansi, () => {}, process.cwd(), id);
      try {
        const lines = sized.render(80);
        assert.ok(lines.length <= Math.max(1, Math.floor(rows * 0.9)), `fits ${rows} rows, got ${lines.length}: ${JSON.stringify(lines.map((l: string) => l.replace(/\x1b\[[0-9;]*m/g, '')))}`);
        assert.match(lines.join('\n').replace(/\x1b\[[0-9;]*m/g, ''), /sends to this child|^> /m, `input visible at ${rows} rows`);
      } finally { sized.dispose(); }
    }
    // A draft survives the running -> finished label change, cursor intact.
    viewer.handleInput('\r'); // reopen the child
    viewer.focused = true;
    for (const ch of 'draft') viewer.handleInput(ch);
    const rpc = (agents as any).children.get(id).rpc;
    await rpc.request('finish'); await rpc.request('settle');
    await wait(() => agents.snapshot(id).status === 'stopped');
    viewer.render(80);
    viewer.handleInput('X');
    assert.equal(viewer.input.getValue(), 'draftX', `draft keeps its cursor position across relabel, got ${JSON.stringify(viewer.input.getValue())}`);
  } finally { viewer.dispose(); await agents.shutdown(); }
});

test('viewer never hides intent behind status text or tiny heights, and drops stopped focus', async () => {
  const agents = new Agents(() => {});
  const id = agents.spawn('state task', { command: process.execPath, args: ['fixtures/fake-rpc.mjs'], cwd: process.cwd() });
  const plain = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s };
  const wait = async (fn: () => boolean) => {
    for (let i = 0; i < 1000; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); }
    assert.fail('condition not reached');
  };
  const viewer: any = new AgentViewer(agents, { requestRender() {}, terminal: { rows: 24 } }, plain, () => {}, process.cwd(), id);
  try {
    await wait(() => agents.status(id) === 'active');
    viewer.focused = true;
    // Guidance is not masked by transient feedback.
    viewer.status = 'Input accepted by j1.';
    const tall = viewer.render(80).join('\n');
    assert.match(tall, /Enter→steer/, 'intent survives feedback');
    assert.match(tall, /Input accepted by j1\./, 'feedback is still shown');
    // Short terminals carry the state next to the composer instead.
    const short: any = new AgentViewer(agents, { requestRender() {}, terminal: { rows: 5 } }, plain, () => {}, process.cwd(), id);
    try {
      assert.match(short.render(80).join('\n'), /Enter→steer/, 'short terminals still show intent');
      short.focused = true;
      short.handleInput('\u0018'); // Ctrl+X -> stop
      await wait(() => agents.status(id) === 'stopped');
      const stopped = short.render(80).join('\n');
      assert.match(stopped, /stopped/, 'stopped state is visible');
      assert.equal(short.input.focused, true, 'a stopped child keeps input focus');
    } finally { short.dispose(); }
    // A tagged composer reserves its prefix width, so a long draft still scrolls,
    // keeps its caret marker, and is never truncated after being rendered.
    {
      const fresh = agents.spawn('composer scroll', { command: process.execPath, args: ['fixtures/fake-rpc.mjs'], cwd: process.cwd() });
      try {
        for (const width of [16, 18, 20, 22]) {
          const narrow: any = new AgentViewer(agents, { requestRender() {}, terminal: { rows: 3 } }, plain, () => {}, process.cwd(), fresh);
          try {
            narrow.focused = true;
            narrow.handleInput('abcdefghijabcdefghij');
            const composer = narrow.render(width).at(-1)!;
            assert.match(composer, /^live > /, `tag present at ${width} columns`);
            const text = composer.split(CURSOR_MARKER).join('').replace(/\x1b_pi:\/?fc\x07/g, '').replace(/\x1b\[[0-9;]*m/g, '');
            assert.match(text.trimEnd(), /(?:ij)$/, `the draft tail stays visible at ${width} columns`);
            assert.ok(!text.includes('...'), `the composer is not post-truncated at ${width} columns`);
            assert.ok(composer.includes(CURSOR_MARKER), `the caret marker survives at ${width} columns`);
          } finally { narrow.dispose(); }
        }
      } finally { await agents.stop(fresh); }
    }
    // Errors stay readable next to the intent, and intent never crowds them out.
    {
      viewer.status = 'Error: prompt rejected by the child process';
      const line = viewer.render(40).join('\n');
      assert.match(line, /prompt rejected/, 'the error itself is visible at 40 columns');
      assert.match(line, /Stopped|Enter→new turn|turn ·/, 'intent survives the error');
    }
    // A failed child shows its diagnostic even on a 20-column overlay.
    {
      const failing = agents.spawn('failing task', { command: process.execPath, args: ['fixtures/fake-rpc.mjs'], cwd: process.cwd() });
      const narrow: any = new AgentViewer(agents, { requestRender() {}, terminal: { rows: 24 } }, plain, () => {}, process.cwd(), failing);
      try {
        await wait(() => agents.status(failing) === 'active');
        await (agents as any).children.get(failing).rpc.request('provider_error');
        await wait(() => agents.status(failing) === 'stopped');
        const line = narrow.render(20).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
        assert.match(line, /provider/, 'the diagnostic is not crowded out by the intent');
        assert.match(line, /turn/, 'the intent is still stated');
      } finally { narrow.dispose(); await agents.stop(failing); }
    }
    // Rendering does not re-clone the conversation when the cache is warm.
    {
      viewer.render(80);
      const original = agents.snapshot.bind(agents);
      (agents as any).snapshot = () => { throw new Error('snapshot called during a warm render'); };
      try { viewer.render(80); } finally { agents.snapshot = original; }
    }
    // Geometry sweep: every sampled size fits the cap and keeps the composer.
    for (const rows of [1, 2, 3, 5, 8, 12]) {
      for (const width of [8, 16, 31, 32, 60]) {
        for (const withId of [true, false]) {
          const sized: any = new AgentViewer(agents, { requestRender() {}, terminal: { rows } }, plain, () => {}, process.cwd(), withId ? id : undefined);
          try {
            const lines = sized.render(width);
            assert.ok(lines.length <= Math.max(1, Math.floor(rows * 0.9)), `cap at ${rows}x${width}`);
            assert.ok(lines.every((line: string) => visibleWidth(line) <= width), `width at ${rows}x${width}`);
            if (withId) assert.match(lines.join('\n'), /> /, `composer at ${rows}x${width}`);
          } finally { sized.dispose(); }
        }
      }
    }
  } finally { viewer.dispose(); await agents.shutdown(); }
});

test('viewer late attach/live tools/scroll/narrow widths/steering/close-reopen use same registry', async () => {
  let rpc: RpcProcess;
  const notices: any[] = [];
  const agents = new Agents((...args) => notices.push(args), (spec, event, failure) => rpc = new RpcProcess(spec, event, failure));
  const id = agents.spawn('task', { command: process.execPath, args: ['fixtures/fake-rpc.mjs'], cwd: process.cwd() });
  const theme = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s };
  const tui = { requestRender() {}, terminal: { rows: 24 } };
  const wait = async (fn: () => boolean) => {
    for (let i = 0; i < 1000; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); }
    assert.fail('condition not reached');
  };
  let viewer: any;
  try {
    await wait(() => agents.snapshot(id).tools.t1?.result?.content?.[0]?.text === 'live output');
    viewer = new AgentViewer(agents, tui, theme, () => {}, process.cwd(), id);
    viewer.focused = true;
    const initial = viewer.render(100).join('\n');
    assert.match(initial, /task/); assert.match(initial, /live output/); assert.match(initial, /example/);
    viewer.handleInput('correction'); viewer.handleInput('\r');
    await wait(() => agents.snapshot(id).messages.some(m => m.content === 'correction'));
    assert.equal(notices.length, 0, 'viewing and steering create no parent notices');
    // Inject long tool output through the same event fixture/controller contract.
    const long = agents.snapshot(id);
    long.tools.t1.result = { content: [{ type: 'text', text: Array.from({ length: 100 }, (_, i) => `line-${i} 中文🙂`).join('\n') }] };
    const original = agents.snapshot.bind(agents);
    agents.snapshot = () => long;
    viewer.invalidate();
    for (const width of [12, 30, 80]) {
      const lines = viewer.render(width);
      assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
      assert.ok(lines.length <= 24);
    }
    viewer.render(80);
    viewer.handleInput('\u001b[5~'); // Page Up
    assert.match(viewer.render(80).join('\n'), /line-/);
    viewer.handleInput('\u001b[5~'); viewer.handleInput('\u001b[5~');
    viewer.handleInput('\u0019'); // Ctrl+Y -> live end
    assert.match(viewer.render(80).join('\n'), /line-99/);
    agents.snapshot = original;
    viewer.dispose();
    await rpc!.request('finish'); await rpc!.request('settle');
    const pid = rpc!.pid;
    viewer = new AgentViewer(agents, tui, theme, () => {}, process.cwd(), id);
    assert.match(viewer.render(100).join('\n'), /SECRET RESULT/);
    assert.equal(rpc!.pid, pid);
    viewer.handleInput('\u0018'); // Ctrl+X
    await wait(() => agents.snapshot(id).status === 'stopped');
  } finally { viewer?.dispose(); await agents.shutdown(); }
});

test('a task label cannot inject terminal escapes into the conversation heading', async () => {
  const agents = new Agents(() => {});
  const plainTheme = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s };
  const id = agents.spawn('\x1b[48;5;196mRED\x1b[0m task', { command: process.execPath, args: ['fixtures/fake-rpc.mjs'], cwd: process.cwd() });
  const viewer: any = new AgentViewer(agents, { requestRender() {}, terminal: { rows: 24 } }, plainTheme, () => {}, process.cwd(), id);
  try {
    const detail = viewer.render(80).join('\n');
    assert.ok(!detail.includes('\x1b[48;5;196m'), 'heading drops the injected background');
    assert.match(detail, /RED task/, 'the readable text remains');
  } finally { viewer.dispose(); await agents.shutdown(); }
});

test('the stopped viewer keeps interrupted text that read clips', async () => {
  const agents = new Agents(() => {});
  const plainTheme = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s };
  const id = agents.spawn('long partial', { command: process.execPath, args: ['fixtures/fake-rpc.mjs'], cwd: process.cwd() });
  const viewer: any = new AgentViewer(agents, { requestRender() {}, terminal: { rows: 40 } }, plainTheme, () => {}, process.cwd(), id);
  const wait = async (fn: () => boolean) => {
    for (let i = 0; i < 1000; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); }
    assert.fail('condition not reached');
  };
  try {
    await wait(() => agents.status(id) === 'active');
    await (agents as any).children.get(id).rpc.request('long');
    await wait(() => agents.snapshot(id).streaming !== undefined);
    await agents.stop(id);
    assert.match(viewer.render(120).join('\n'), /TAIL_MARKER/, 'the viewer shows the full interrupted answer');
    assert.match(agents.read(id), /TAIL_MARKER/, 'read shows the full interrupted answer');
  } finally { viewer.dispose(); await agents.shutdown(); }
});

test('the stopped viewer carries sanitizer state into interrupted output', async () => {
  const agents = new Agents(() => {});
  const plainTheme = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s };
  const id = agents.spawn('interrupted split', { command: process.execPath, args: ['fixtures/fake-rpc.mjs'], cwd: process.cwd() });
  const viewer: any = new AgentViewer(agents, { requestRender() {}, terminal: { rows: 40 } }, plainTheme, () => {}, process.cwd(), id);
  const wait = async (fn: () => boolean) => {
    for (let i = 0; i < 1000; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); }
    assert.fail('condition not reached');
  };
  try {
    await wait(() => agents.status(id) === 'active');
    await (agents as any).children.get(id).rpc.request('interruptsplit');
    await wait(() => agents.snapshot(id).streaming !== undefined);
    await agents.stop(id);
    const detail = viewer.render(120).join('\n');
    assert.match(detail, /AFTER/);
    assert.ok(!detail.includes('SECRET'), 'interrupted output does not reset control-string state');
  } finally { viewer.dispose(); await agents.shutdown(); }
});

test('a completed tool result already sanitized in messages is not scanned twice', async () => {
  const agents = new Agents(() => {});
  const plainTheme = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s };
  const id = agents.spawn('result message', { command: process.execPath, args: ['fixtures/fake-rpc.mjs'], cwd: process.cwd() });
  const viewer: any = new AgentViewer(agents, { requestRender() {}, terminal: { rows: 40 } }, plainTheme, () => {}, process.cwd(), id);
  const wait = async (fn: () => boolean) => {
    for (let i = 0; i < 1000; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); }
    assert.fail('condition not reached');
  };
  try {
    await wait(() => agents.status(id) === 'active');
    await (agents as any).children.get(id).rpc.request('resultmessage');
    await wait(() => agents.snapshot(id).messages.some(m => m.role === 'toolResult'));
    const detail = viewer.render(120).join('\n');
    assert.match(detail, /VISIBLE/, 'the authoritative result is rendered without a second stateful pass');
  } finally { viewer.dispose(); await agents.shutdown(); }
});

test('viewer thinking state survives running, settled and stopped reads', async () => {
  const agents = new Agents(() => {});
  const plainTheme = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s };
  const id = agents.spawn('thinking split', { command: process.execPath, args: ['fixtures/fake-rpc.mjs'], cwd: process.cwd() });
  const viewer: any = new AgentViewer(agents, { requestRender() {}, terminal: { rows: 40 } }, plainTheme, () => {}, process.cwd(), id);
  const wait = async (fn: () => boolean) => {
    for (let i = 0; i < 1000; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); }
    assert.fail('condition not reached');
  };
  try {
    await wait(() => agents.status(id) === 'active');
    await (agents as any).children.get(id).rpc.request('thinkingsplit');
    await wait(() => agents.snapshot(id).messages.length >= 1);
    let detail = viewer.render(120).join('\n');
    assert.match(detail, /AFTER/);
    assert.ok(!detail.includes('SECRET'), 'running viewer hides a payload opened in thinking');
    await (agents as any).children.get(id).rpc.request('settle');
    await wait(() => agents.status(id) === 'stopped');
    detail = viewer.render(120).join('\n');
    assert.match(detail, /AFTER/);
    assert.ok(!detail.includes('SECRET'), 'settled viewer hides a payload opened in thinking');
    await agents.stop(id);
    detail = viewer.render(120).join('\n');
    assert.match(detail, /AFTER/);
    assert.ok(!detail.includes('SECRET'), 'stopped viewer hides a payload opened in thinking');
  } finally { viewer.dispose(); await agents.shutdown(); }
});

test('viewer interrupted thinking and result metadata share sanitizer state', async () => {
  const agents = new Agents(() => {});
  const plainTheme = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s };
  const wait = async (fn: () => boolean) => {
    for (let i = 0; i < 1000; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); }
    assert.fail('condition not reached');
  };
  const id = agents.spawn('interrupted thinking', { command: process.execPath, args: ['fixtures/fake-rpc.mjs'], cwd: process.cwd() });
  const viewer: any = new AgentViewer(agents, { requestRender() {}, terminal: { rows: 40 } }, plainTheme, () => {}, process.cwd(), id);
  try {
    await wait(() => agents.status(id) === 'active');
    await (agents as any).children.get(id).rpc.request('interruptthinking');
    await wait(() => agents.snapshot(id).streaming?.content?.length >= 2);
    await agents.stop(id);
    let detail = viewer.render(120).join('\n');
    assert.match(detail, /AFTER/);
    assert.ok(!detail.includes('SECRET'), 'interrupted thinking viewer hides its payload');

    const second = new Agents(() => {});
    const other = second.spawn('metadata result', { command: process.execPath, args: ['fixtures/fake-rpc.mjs'], cwd: process.cwd() });
    const otherViewer: any = new AgentViewer(second, { requestRender() {}, terminal: { rows: 40 } }, plainTheme, () => {}, process.cwd(), other);
    try {
      await wait(() => second.status(other) === 'active');
      await (second as any).children.get(other).rpc.request('metadataresult');
      await wait(() => second.snapshot(other).messages.some(m => m.role === 'toolResult' && m.toolCallId === 'm1'));
      detail = otherViewer.render(120).join('\n');
      assert.match(detail, /BEFORE/);
      assert.match(detail, /image\/png/);
      assert.ok(!detail.includes('SECRET'), 'image metadata continues the shared text stream');
    } finally { otherViewer.dispose(); await second.shutdown(); }
  } finally { viewer.dispose(); await agents.shutdown(); }
});

test('failed diagnostics in the message and status line keep sanitizer state', async () => {
  const agents = new Agents(() => {});
  const plainTheme = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s };
  const id = agents.spawn('failed split', { command: process.execPath, args: ['fixtures/fake-rpc.mjs'], cwd: process.cwd() });
  const viewer: any = new AgentViewer(agents, { requestRender() {}, terminal: { rows: 40 } }, plainTheme, () => {}, process.cwd(), id);
  const wait = async (fn: () => boolean) => {
    for (let i = 0; i < 1000; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); }
    assert.fail('condition not reached');
  };
  try {
    await wait(() => agents.status(id) === 'active');
    await (agents as any).children.get(id).rpc.request('failsplit');
    await wait(() => agents.status(id) === 'stopped');
    const detail = viewer.render(120).join('\n');
    assert.match(detail, /AFTER/);
    assert.match(detail, /Error: AFTER/);
    assert.ok(!detail.includes('SECRET'), 'neither the message renderer nor status line resets control-string state');
  } finally { viewer.dispose(); await agents.shutdown(); }
});

test('a partial tool-call preview never shows encoded control payloads', async () => {
  const agents = new Agents(() => {});
  const plainTheme = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s };
  const id = agents.spawn('partial arguments', { command: process.execPath, args: ['fixtures/fake-rpc.mjs'], cwd: process.cwd() });
  const viewer: any = new AgentViewer(agents, { requestRender() {}, terminal: { rows: 40 } }, plainTheme, () => {}, process.cwd(), id);
  const wait = async (fn: () => boolean) => {
    for (let i = 0; i < 1000; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); }
    assert.fail('condition not reached');
  };
  try {
    await wait(() => agents.status(id) === 'active');
    await (agents as any).children.get(id).rpc.request('partialinject');
    await wait(() => !!agents.snapshot(id).streaming);
    const detail = viewer.render(120).join('\n');
    assert.match(detail, /preparing arguments/);
    assert.ok(!detail.includes('SECRET'), 'serialized JSON escapes are not rendered as a payload');
  } finally { viewer.dispose(); await agents.shutdown(); }
});

test('an unexecuted partial call does not consume a later reused id result', async () => {
  const agents = new Agents(() => {});
  const plainTheme = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s };
  const id = agents.spawn('unexecuted call', { command: process.execPath, args: ['fixtures/fake-rpc.mjs'], cwd: process.cwd() });
  const viewer: any = new AgentViewer(agents, { requestRender() {}, terminal: { rows: 40 } }, plainTheme, () => {}, process.cwd(), id);
  const wait = async (fn: () => boolean) => {
    for (let i = 0; i < 1000; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); }
    assert.fail('condition not reached');
  };
  try {
    await wait(() => agents.status(id) === 'active');
    await (agents as any).children.get(id).rpc.request('unexecuted');
    await wait(() => agents.snapshot(id).messages.some(m => m.role === 'toolResult' && m.toolCallId === 'u1'));
    const detail = viewer.render(120).join('\n');
    assert.match(detail, /bash \(not executed\)/);
    assert.equal((detail.match(/RAN RESULT/g) ?? []).length, 1, 'the result belongs only to the executed call');
  } finally { viewer.dispose(); await agents.shutdown(); }
});

test('the viewer shows a reused tool id as a new occurrence', async () => {
  const agents = new Agents(() => {});
  const plainTheme = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s };
  const id = agents.spawn('reuse tool id', { command: process.execPath, args: ['fixtures/fake-rpc.mjs'], cwd: process.cwd() });
  const viewer: any = new AgentViewer(agents, { requestRender() {}, terminal: { rows: 40 } }, plainTheme, () => {}, process.cwd(), id);
  const wait = async (fn: () => boolean) => {
    for (let i = 0; i < 1000; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); }
    assert.fail('condition not reached');
  };
  try {
    await wait(() => agents.status(id) === 'active' && agents.snapshot(id).messages.some(m => m.role === 'user') && !!agents.snapshot(id).tools.t1);
    await (agents as any).children.get(id).rpc.request('finish');
    await (agents as any).children.get(id).rpc.request('settle');
    await wait(() => agents.status(id) === 'stopped');
    await agents.send(id, 'again');
    await wait(() => agents.snapshot(id).messages.some(m => m.role === 'user' && m.content === 'again'));
    await wait(() => agents.snapshot(id).tools.t1?.running === true && agents.snapshot(id).tools.t1?.args?.command === 'second');
    const detail = viewer.render(120).join('\n');
    assert.match(detail, /example/, 'the old call keeps its own argument');
    assert.match(detail, /second/, 'the new call shows its own argument');
    assert.match(detail, /live output/, 'the new running occurrence is visible');
  } finally { viewer.dispose(); await agents.shutdown(); }
});

test('viewer sanitizes child text, arguments and results before rendering', async () => {
  const agents = new Agents(() => {});
  const plainTheme = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s };
  const id = agents.spawn('inject', { command: process.execPath, args: ['fixtures/fake-rpc.mjs'], cwd: process.cwd() });
  const viewer: any = new AgentViewer(agents, { requestRender() {}, terminal: { rows: 60 } }, plainTheme, () => {}, process.cwd(), id);
  const wait = async (fn: () => boolean) => {
    for (let i = 0; i < 1000; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); }
    assert.fail('condition not reached');
  };
  try {
    await mkdir('tmp', { recursive: true });
    await writeFile('tmp/preview-inject.txt', 'a\n\x1b[2JFILE_PAYLOAD\n');
    await wait(() => agents.status(id) === 'active');
    await (agents as any).children.get(id).rpc.request('inject');
    await wait(() => !!agents.snapshot(id).tools.i1?.result);
    await wait(() => !!agents.snapshot(id).tools.i2?.result);
    await new Promise(r => setTimeout(r, 100)); // let any disk-backed preview finish
    const proto = ToolExecutionComponent.prototype;
    const original = proto.setArgsComplete;
    const completed: string[] = [];
    proto.setArgsComplete = function () { completed.push((this as any).toolName); return original.call(this); };
    let detail: string;
    try { detail = viewer.render(100).join('\n'); } finally { proto.setArgsComplete = original; }
    assert.ok(!completed.includes('edit'), 'the edit renderer never receives an args-complete signal');
    viewer.status = '\x1b[2Jbad status';
    detail = viewer.render(100).join('\n');
    assert.match(detail, /INJECTED/);
    assert.match(detail, /PAYLOAD/);
    assert.match(detail, /EDIT_PAYLOAD/, 'diff details reach the native renderer');
    assert.match(detail, /image\/pngIMAGE_PAYLOAD/, 'the image fallback is rendered from sanitized metadata');
    assert.match(detail, /AFTER/);
    assert.match(detail, /DCS_AFTER/);
    assert.ok(!detail.includes('SECRET') && !detail.includes('DCS_SECRET'), 'split control strings stay hidden');
    assert.ok(!detail.includes('\x1b[2J'), 'CSI is stripped from child text and status');
    assert.ok(!detail.includes('\x1b]52'), 'OSC is stripped from tool arguments');
    assert.ok(!detail.includes('\x9b'), '8-bit CSI is stripped from tool results');
    assert.ok(!detail.includes('52;c;SECRET'), 'OSC payload does not leak as visible text');
    assert.ok(!agents.read(id).includes('\x1b'), 'tool names are sanitized in read too');
    assert.ok(!agents.read(id).includes('52;c;SECRET'), 'parent tool arguments are sanitized before JSON encoding');
    assert.ok(!detail.includes('FILE_PAYLOAD'), 'the edit renderer never reads the file for a preview');
  } finally { viewer.dispose(); await agents.shutdown(); await rm('tmp/preview-inject.txt', { force: true }); }
});
