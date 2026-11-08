import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agents, childInvocation } from './agents.ts';
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
    await until(() => !!agents.snapshot(id).tools.t1);
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
    await processes[0].request('settle');
    assert.equal(agents.list()[0].status, 'finished');
    assert.match(notices[0].read, /SECRET RESULT/);
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

test('child CLI has fresh context, ordinary tools, explicit resources disabled, model/thinking defaults', () => {
  const spec = childInvocation('/tmp', { provider: 'provider', id: 'model' }, 'high');
  for (const flag of ['--mode', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes']) assert.ok(spec.args.includes(flag));
  assert.ok(spec.args.includes('read,bash,edit,write'));
  assert.ok(spec.args.includes('provider')); assert.ok(spec.args.includes('model')); assert.ok(spec.args.includes('high'));
  for (const flag of ['--continue', '--fork', '--no-context-files', '--no-session']) assert.ok(!spec.args.includes(flag));
});
