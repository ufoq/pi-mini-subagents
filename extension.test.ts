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
  const theme = { fg: (_: string, s: string) => s };
  const tui = { requestRender() {}, terminal: { rows: 24 } };
  const viewer: any = new AgentViewer(agents, tui, theme, () => {}, process.cwd());
  try {
    const lines = viewer.render(100);
    const order = lines.map((line: string) => /\(j\d\)|j\d/.exec(line)?.[0]).filter(Boolean);
    assert.deepEqual(order.slice(0, 2), [second, first], 'newest child on top');
    // ↓ selects the second row, which is now the older child.
    viewer.focused = true; viewer.handleInput('\u001b[B'); viewer.handleInput('\r');
    assert.match(viewer.render(100).join('\n'), new RegExp(`${first} `), 'opens the older child under the cursor');
  } finally { viewer.dispose(); await agents.shutdown(); }
});

test('viewer late attach/live tools/scroll/narrow widths/steering/close-reopen use same registry', async () => {
  let rpc: RpcProcess;
  const notices: any[] = [];
  const agents = new Agents((...args) => notices.push(args), (spec, event, failure) => rpc = new RpcProcess(spec, event, failure));
  const id = agents.spawn('task', { command: process.execPath, args: ['fixtures/fake-rpc.mjs'], cwd: process.cwd() });
  const theme = { fg: (_: string, s: string) => s };
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
