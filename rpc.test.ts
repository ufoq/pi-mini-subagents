import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { RpcProcess } from './rpc.ts';

export function fake(onEvent = (_e: any) => {}, onFailure = (_e: Error) => {}) {
  return new RpcProcess({ command: process.execPath, args: ['fixtures/fake-rpc.mjs'], cwd: process.cwd() }, onEvent, onFailure);
}
export async function until(predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 300; i++) {
    if (await predicate()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.fail('condition not reached');
}
export async function alive(pid: number) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
  } catch { return false; }
}

test('RPC correlates requests, handles split UTF-8 and only LF framing', async () => {
  const events: any[] = [];
  const rpc = fake(e => events.push(e));
  try {
    const [state, echo] = await Promise.all([rpc.request('get_state'), rpc.request('echo')]);
    assert.equal(state.sessionId, 'fake-session');
    assert.equal(echo.echo, 'echo');
    await rpc.request('unicode');
    assert.equal(events.find(e => e.type === 'unicode').text, '中\u2028\u2029🙂');
    await assert.rejects(rpc.request('prompt', { message: 'reject' }), /prompt rejected/);
  } finally { await rpc.stop(); }
});

test('exit and malformed protocol reject pending commands with diagnostics', async () => {
  for (const mode of ['crash', 'malformed']) {
    let failure: Error | undefined;
    const rpc = fake(() => {}, e => { failure = e; });
    try {
      await rpc.request('get_state');
      const waiting = assert.rejects(rpc.request('wait'), mode === 'crash' ? /useful crash diagnostic/ : /JSON/);
      await rpc.request('prompt', { message: mode });
      await waiting;
      await until(() => !!failure);
    } finally { await rpc.stop(); }
  }
});

test('spawn failure rejects pending requests', async () => {
  const rpc = new RpcProcess({ command: '/nonexistent/pi-mini-subagents', args: [], cwd: process.cwd() }, () => {}, () => {});
  await assert.rejects(rpc.request('get_state'), /ENOENT/);
  await rpc.stop();
});

test('explicit stop is idempotent and kills detached owned descendants', async () => {
  let descendant = 0;
  const rpc = fake(e => { if (e.type === 'descendant') descendant = e.pid; });
  await rpc.request('prompt', { message: 'descendant' });
  await until(() => descendant > 0);
  assert.equal(await alive(descendant), true);
  const waiting = assert.rejects(rpc.request('wait'), /stop/i);
  await Promise.all([rpc.stop(), rpc.stop()]);
  await waiting;
  await until(async () => !(await alive(descendant)));
  assert.equal(await alive(rpc.pid!), false);
});
