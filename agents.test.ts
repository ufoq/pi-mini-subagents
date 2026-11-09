import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agents, childInvocation, transcript } from './agents.ts';
import { RpcProcess } from './rpc.ts';
const invocation = { command: process.execPath, args: ['fixtures/fake-rpc.mjs'], cwd: process.cwd() };
async function until(predicate: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.fail('condition not reached');
}
function setup() {
  const processes: RpcProcess[] = [];
  const notices: any[] = [];
  const agents = new Agents((id, status) => {
    notices.push({ id, status, read: agents.read(id) });
  }, (spec, event, failure) => {
    const rpc = new RpcProcess(spec, event, failure); processes.push(rpc); return rpc;
  });
  return { agents, processes, notices };
}

test('launch is immediate; late snapshot, live activity, steering and persistent follow-up', async () => {
  const { agents, processes, notices } = setup();
  try {
    const brief = 'Read-only. Own no files. Keep exactly this restriction.';
    const id = agents.spawn(brief, invocation);
    assert.equal(typeof id, 'string');
    assert.equal(agents.list()[0].status, 'starting');
    await until(() => agents.snapshot(id).tools.t1?.result?.content?.[0]?.text === 'live output');
    const snapshot = agents.snapshot(id);
    assert.equal(snapshot.messages[0].content, brief);
    assert.equal(snapshot.tools.t1.result.content[0].text, 'live output');
    assert.equal(notices.length, 0);
    await assert.rejects(agents.send(id, 'reject'), /prompt rejected/);
    assert.equal(agents.snapshot(id).status, 'running');
    assert.equal(agents.snapshot(id).tools.t1.running, true);
    assert.equal(notices.length, 0, 'rejected input is not completion');
    let updates = 0;
    const unsubscribe = agents.subscribe(() => updates++);
    await agents.send(id, 'correction');
    await until(() => agents.snapshot(id).messages.some(m => m.content === 'correction'));
    await processes[0].request('finish');
    assert.equal(notices.length, 0, 'agent_end is not settlement');
    const running = agents.read(id);
    assert.match(running, /tool bash: done/, 'running read attributes tool output');
    assert.match(running, /assistant: /, 'running read attributes assistant output');
    await processes[0].request('settle');
    assert.equal(agents.list()[0].status, 'finished');
    assert.match(notices[0].read, /SECRET RESULT/);
    assert.match(notices[0].read, /^j1 finished · fake-model\/fake$/m);
    assert.match(notices[0].read, /retained: transcript in memory; subagent stop releases any live child process/);
    assert.ok(updates > 0);
    unsubscribe();
    const previousUpdates = updates;
    await agents.send(id, 'follow-up with context');
    await processes[0].request('finish'); await processes[0].request('settle');
    assert.equal(processes.length, 1, 'same process');
    assert.equal(updates, previousUpdates, 'closing observer unsubscribes, not stops');
    assert.match(agents.read(id), /correction.*follow-up with context/s);
    assert.equal(notices.length, 2);
    const copy = agents.snapshot(id); copy.messages.length = 0;
    assert.ok(agents.snapshot(id).messages.length > 0, 'snapshot not mutable registry');
  } finally { await agents.shutdown(); }
});

test('no five-child cap, no queue, no notices or transcripts on launch/list', async () => {
  const { agents, processes, notices } = setup();
  try {
    for (let i = 0; i < 7; i++) agents.spawn('task ' + i, invocation);
    assert.equal(processes.length, 7);
    assert.equal(agents.list().length, 7);
    assert.ok(!JSON.stringify(agents.list()).includes('messages'));
    assert.equal(notices.length, 0);
    await until(() => agents.list().every(a => a.status === 'running'));
  } finally { await agents.shutdown(); }
  assert.ok(agents.list().every(a => a.status === 'stopped'));
  assert.equal(notices.length, 0);
});

test('provider failure, process failure, validation and result read bounds', async () => {
  const { agents, processes, notices } = setup();
  try {
    assert.throws(() => agents.spawn(' ', invocation), /message/);
    assert.throws(() => agents.read('missing'), /Unknown/);
    const id = agents.spawn('task', invocation);
    await until(() => agents.list()[0].status === 'running');
    await assert.rejects(agents.send(id, ' '), /message/);
    await processes[0].request('provider_error');
    assert.equal(agents.snapshot(id).status, 'failed');
    assert.match(agents.read(id), /provider unavailable/);
    assert.equal(notices[0].status, 'failed');
    await agents.send(id, 'x'.repeat(20000));
    await processes[0].request('finish'); await processes[0].request('settle');
    assert.ok(agents.read(id).length < 9000);
    assert.match(agents.read(id), /truncated/);
    assert.match(agents.read(id), /retained: transcript in memory; subagent stop releases any live child process/, 'the retention reminder survives truncation');
    await agents.stop(id);
    await assert.rejects(agents.send(id, 'follow up'), /stopped/);
    const crashed = agents.spawn('crash', invocation);
    await until(() => agents.snapshot(crashed).status === 'failed');
    assert.match(agents.read(crashed), /useful crash diagnostic/);
  } finally { await agents.shutdown(); }
});

test('streaming deltas are reconstructed, then replaced by authoritative message_end', async () => {
  const { agents, processes } = setup();
  const id = agents.spawn('task', invocation);
  try {
    await until(() => !!agents.snapshot(id).tools.t1);
    await processes[0].request('stream');
    const partial = agents.snapshot(id).streaming!;
    assert.equal(partial.content[0].text, 'authoritative text');
    assert.equal(partial.content[1].thinking, 'thinking');
    assert.equal(partial.content[2].partialArguments, '{"command":"echo');
    await processes[0].request('stream_end');
    assert.equal(agents.snapshot(id).streaming, undefined);
    assert.equal(agents.snapshot(id).messages.at(-1).content[0].text, 'FINAL authoritative message');
  } finally { await agents.shutdown(); }
});

test('transcript preserves code spacing and strips terminal escapes', () => {
  const snapshot: any = {
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'go("a  b")\n  indented \x1b[31mX\x1b[0m' }] }],
    tools: {},
  };
  assert.match(transcript(snapshot), /go\("a  b"\)\n  indented X/);
});

test('stopping keeps recent output readable, including a partial answer', async () => {
  const { agents, processes, notices } = setup();
  try {
    const id = agents.spawn('stop me', invocation);
    await until(() => agents.snapshot(id).status === 'running');
    await processes[0].request('stream');
    await until(() => agents.snapshot(id).streaming?.content?.[0]?.text === 'authoritative text');
    await agents.stop(id);
    const partial = agents.read(id);
    assert.match(partial, /^j1 stopped · fake-model\/fake$/m);
    assert.match(partial, /user: stop me/);
    assert.match(partial, /assistant \(interrupted\): authoritative text/);
    assert.match(partial, /tool bash \(interrupted\): .*live output/s);
    assert.match(partial, /\[Stopped before tool completed\.\]/);
    assert.match(partial, /stopped: transcript retained in memory until parent shutdown/);
    await agents.stop(id);
    assert.match(agents.read(id), /assistant \(interrupted\): authoritative text/, 'repeated stop keeps the partial answer');
    const second = agents.spawn('finished but not settled', invocation);
    await until(() => agents.snapshot(second).status === 'running');
    await processes[1].request('finish');
    await agents.stop(second);
    assert.match(agents.read(second), /tool bash: done/);
    assert.match(agents.read(second), /SECRET RESULT/);
    assert.equal(notices.length, 0, 'stop never emits completion');
  } finally { await agents.shutdown(); }
});

test('stop during startup does not submit work or emit completion', async () => {
  const { agents, notices } = setup();
  const id = agents.spawn('task', invocation);
  await agents.stop(id);
  assert.equal(agents.snapshot(id).status, 'stopped');
  assert.equal(agents.snapshot(id).messages.length, 0);
  assert.equal(notices.length, 0);
  await agents.shutdown();
});

test('a child whose process cannot be constructed is never retained', async () => {
  const notices: any[] = [];
  const agents = new Agents((id, status) => notices.push({ id, status }), () => {
    throw new Error("The argument 'args[5]' must be a string without null bytes.");
  });
  assert.throws(() => agents.spawn('task', invocation), /Could not start j1: .*null bytes/);
  assert.deepEqual(agents.list(), []);
  assert.equal(notices.length, 0);
  await agents.shutdown(); // must not touch a half-registered child
});

test('a synchronous failure from a factory that still returns a process is delivered after launch', async () => {
  const notices: any[] = [];
  const observed: string[][] = [];
  const agents = new Agents((id, status) => notices.push({ id, status }), (_spec, _event, failure) => {
    failure(new Error('spawn failed synchronously'));
    return { request: async () => { throw new Error('unreachable'); }, stop: async () => {} } as any;
  });
  agents.subscribe(() => observed.push(agents.list().map(c => `${c.id} ${c.status}`)));
  const id = agents.spawn('task', invocation);
  assert.equal(id, 'j1');
  assert.deepEqual(observed, [['j1 failed']], 'one publication, after launch, with the final state');
  assert.deepEqual(agents.list().map(c => `${c.id} ${c.status}`), ['j1 failed']);
  await until(() => notices.length === 1);
  assert.deepEqual(notices, [{ id: 'j1', status: 'failed' }]);
  assert.match(agents.read('j1'), /spawn failed synchronously/);
  await agents.shutdown();
});

test('a factory that fails synchronously before throwing emits no notification', async () => {
  const notices: any[] = [];
  const observed: string[][] = [];
  const agents = new Agents((id, status) => notices.push({ id, status, readable: agents.read(id) }), (_spec, _event, failure) => {
    failure(new Error('spawn failed synchronously'));
    throw new Error('factory threw after reporting failure');
  });
  agents.subscribe(() => observed.push(agents.list().map(c => `${c.id} ${c.status}`)));
  assert.throws(() => agents.spawn('task', invocation), /Could not start j1: factory threw/);
  assert.deepEqual(agents.list(), []);
  assert.equal(notices.length, 0, 'no completion for a child id the caller never received');
  assert.deepEqual(observed, [], 'a discarded child is never published to observers');
  await agents.shutdown();
});

test('callbacks queued by a factory that then throws never reach observers or the parent', async () => {
  const notices: any[] = [];
  const observed: string[][] = [];
  const agents = new Agents((id, status) => notices.push({ id, status }), (_spec, event) => {
    // Callback arrives after the factory has already failed the launch.
    queueMicrotask(() => event({ type: 'agent_settled' }));
    throw new Error('factory threw');
  });
  agents.subscribe(() => observed.push(agents.list().map(c => `${c.id} ${c.status}`)));
  assert.throws(() => agents.spawn('task', invocation), /Could not start j1: factory threw/);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(agents.list(), []);
  assert.deepEqual(observed, [], 'a discarded child is never published');
  assert.deepEqual(notices, [], 'a discarded child never completes');
  await agents.shutdown();
});

test('a throwing completion notifier does not invalidate a retained child', async () => {
  const logged: any[] = [];
  const error = console.error;
  console.error = (...args: any[]) => logged.push(args);
  const agents = new Agents(() => { throw new Error('notify channel closed'); }, (_spec, _event, failure) => {
    failure(new Error('spawn failed synchronously'));
    return { request: async () => { throw new Error('unreachable'); }, stop: async () => {} } as any;
  });
  const id = agents.spawn('task', invocation);
  assert.equal(id, 'j1');
  assert.deepEqual(agents.list().map(c => `${c.id} ${c.status}`), ['j1 failed']);
  assert.match(agents.read('j1'), /spawn failed synchronously/);
  console.error = error;
  assert.match(String(logged.at(-1)), /completion delivery failed/i, 'delivery failure is logged, not silent');
  await agents.shutdown();
});

test('startup never overwrites a synchronous terminal state', async () => {
  const prompts: any[] = [];
  const agents = new Agents(() => {}, (_spec, _event, failure) => {
    failure(new Error('spawn failed synchronously'));
    return { request: async (type: string, data: any) => { if (type === 'prompt') prompts.push(data); return {}; }, stop: async () => {} } as any;
  });
  const id = agents.spawn('task', invocation);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(agents.snapshot(id).status, 'failed');
  assert.deepEqual(prompts, [], 'no work submitted for a launch that already failed');
  await agents.shutdown();
});

test('a settlement queued before stop and delivered after it is ignored', async () => {
  const notices: any[] = [];
  let deliver: any;
  const agents = new Agents((id, status) => notices.push({ id, status }), (_spec, event) => {
    deliver = event;
    return { request: async () => ({ messages: [] }), stop: async () => {} } as any;
  });
  const id = agents.spawn('task', invocation);
  await until(() => agents.snapshot(id).status === 'running');
  await agents.stop(id);
  deliver({ type: 'agent_settled' });
  assert.equal(agents.snapshot(id).status, 'stopped');
  assert.deepEqual(notices, [], 'explicit stop sends no completion');
  await agents.shutdown();
});

test('status is readable without copying history, and labels survive C1 sequences', async () => {
  const agents = new Agents(() => {});
  try {
    const id = agents.spawn('\u009b31mred\u009b0m task', { command: process.execPath, args: ['fixtures/fake-rpc.mjs'], cwd: process.cwd() });
    assert.equal(agents.status(id), 'starting');
    await until(() => agents.status(id) === 'running');
    assert.ok(!/\u009b/.test(agents.list()[0].task), 'C1 CSI cannot reach the viewer');
    assert.throws(() => agents.status('nope'), /Unknown subagent/);
  } finally { await agents.shutdown(); }
});

test('list labels are one line, escape-free and never split an emoji', async () => {
  const agents = new Agents(() => {});
  try {
    const id = agents.spawn(`\x1b[31m${'a'.repeat(99)}🙂\u0007 tail`, { command: process.execPath, args: ['fixtures/fake-rpc.mjs'], cwd: process.cwd() });
    const task = agents.list().find(c => c.id === id)!.task;
    assert.ok(!/\x1b|\u0007|\n/.test(task), 'escape and control characters are stripped');
    assert.equal([...task].length, 100, 'bounded by code points');
    assert.ok(task.endsWith('🙂'), 'emoji at the boundary is not split');
  } finally { await agents.shutdown(); }
});

test('a failed launch still consumes its id, so ids stay monotonic', async () => {
  let calls = 0;
  const agents = new Agents(() => {}, () => {
    if (++calls === 1) throw new Error('factory threw');
    return new RpcProcess({ command: process.execPath, args: ['fixtures/fake-rpc.mjs'], cwd: process.cwd() }, () => {}, () => {});
  });
  assert.throws(() => agents.spawn('task', invocation), /Could not start j1/);
  const second = agents.spawn('task', { command: process.execPath, args: ['fixtures/fake-rpc.mjs'], cwd: process.cwd() });
  assert.equal(second, 'j2');
  await agents.shutdown();
});

test('child CLI inherits parent resources except extensions, with all tools', () => {
  const spec = childInvocation('/tmp', { provider: 'provider', id: 'model' }, 'high');
  assert.ok(spec.args.includes('--mode'));
  assert.ok(spec.args.includes('--no-extensions'), 'extensions stay off, so no subagent tool');
  assert.ok(spec.args.includes('--no-session'), 'children do not clutter /resume or persist transcripts');
  for (const flag of ['--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes']) {
    assert.ok(!spec.args.includes(flag), `${flag} would strip a parent resource`);
  }
  const shell = process.platform === 'win32' ? 'powershell' : 'bash';
  assert.ok(spec.args.includes(`read,${shell},edit,write,grep,find,ls`), 'all built-in tools');
  assert.ok(!spec.args.some(a => a.startsWith('builtin:')), 'no built-in extensions either, so no MCP');
  assert.ok(!spec.args.includes('./index.ts'), 'our extension never loads in a child');
  assert.ok(spec.args.includes('provider')); assert.ok(spec.args.includes('model')); assert.ok(spec.args.includes('high'));
  for (const flag of ['--continue', '--fork', '--no-context-files', '--resume']) assert.ok(!spec.args.includes(flag));
});
