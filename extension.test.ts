import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './fixtures/pi-loader.ts';
import { Agents } from './agents.ts';
import { RpcProcess } from './rpc.ts';
const { default: register, completionNotification, parseModel } = await load.import('../index.ts');
const { AgentViewer } = await load.import('../viewer.ts');
const { visibleWidth } = await load.import('@earendil-works/pi-tui');
const { initTheme } = await load.import('@earendil-works/pi-coding-agent');
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
  assert.ok(Buffer.byteLength(JSON.stringify(tools[0].parameters)) < 600);
  const ctx = { mode: 'rpc', ui: { notify() {}, custom() { assert.fail('terminal UI in RPC'); } } };
  await handlers.get('session_start')({}, ctx);
  const execute = (params: any) => tools[0].execute('t', params, undefined, undefined, ctx);
  assert.match((await execute({ action: 'list' })).content[0].text, /No subagents/);
  await assert.rejects(execute({ action: 'read' }), /id is required/);
  await assert.rejects(execute({ action: 'send', id: 'missing', message: 'hello' }), /Unknown/);
  await commands[0].handler('', ctx);
  await handlers.get('session_shutdown')({}, ctx);
  assert.equal(sent.length, 0);
  const content = completionNotification('j1', 'failed');
  assert.match(content, /^<system-notification>\nSubagent j1 failed\./);
  assert.ok(!content.includes('SECRET RESULT'));
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
    const order = lines.map((line: string) => /\(j\d\)|j\d/.exec(line)?.[0]).filter(Boolean);
    assert.deepEqual(order.slice(0, 2), [second, first], 'newest child on top');
    // ↓ selects the second row, which is now the older child.
    viewer.focused = true; viewer.handleInput('\u001b[B'); viewer.handleInput('\r');
    assert.match(viewer.render(100).join('\n'), new RegExp(`${first} `), 'opens the older child under the cursor');
  } finally { viewer.dispose(); await agents.shutdown(); }
});

test('viewer keeps its cursor, states input intent and fits narrow hints', async () => {
  const agents = new Agents(() => {});
  const first = agents.spawn('first task', { command: process.execPath, args: ['fixtures/fake-rpc.mjs'], cwd: process.cwd() });
  const second = agents.spawn('second task', { command: process.execPath, args: ['fixtures/fake-rpc.mjs'], cwd: process.cwd() });
  const ansi = { fg: (_: string, s: string) => `\x1b[36m${s}\x1b[0m`, bg: (_: string, s: string) => `\x1b[48;5;24m${s}\x1b[0m`, bold: (s: string) => `\x1b[1m${s}\x1b[0m` };
  const tui = { requestRender() {}, terminal: { rows: 24 } };
  const wait = async (fn: () => boolean) => {
    for (let i = 0; i < 300; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); }
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
    // Finished children get a new-turn label; stopped ones accept no typing.
    const rpc = (agents as any).children.get(first).rpc;
    await rpc.request('finish'); await rpc.request('settle');
    await wait(() => agents.snapshot(first).status === 'finished');
    viewer.handleInput('\r');
    assert.match(viewer.render(60).join('\n'), /starts a new turn/, 'finished child starts a new turn');
    await agents.stop(first);
    assert.match(viewer.render(60).join('\n'), /Stopped; Esc/);
    const before = agents.snapshot(first).messages.length;
    viewer.handleInput('should not be typed'); viewer.handleInput('\r');
    assert.equal(agents.snapshot(first).messages.length, before, 'stopped child takes no input');
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
    for (let i = 0; i < 300; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); }
    assert.fail('condition not reached');
  };
  const viewer: any = new AgentViewer(agents, { requestRender() {}, terminal: { rows: 24 } }, ansi, () => {}, process.cwd(), id);
  try {
    await wait(() => agents.snapshot(id).status === 'running');
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
    await wait(() => agents.snapshot(id).status === 'finished');
    viewer.render(80);
    viewer.handleInput('X');
    assert.equal(viewer.input.getValue(), 'draftX', `draft keeps its cursor position across relabel, got ${JSON.stringify(viewer.input.getValue())}`);
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
    for (let i = 0; i < 300; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); }
    assert.fail('condition not reached');
  };
  let viewer: any;
  try {
    await wait(() => !!agents.snapshot(id).tools.t1);
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
