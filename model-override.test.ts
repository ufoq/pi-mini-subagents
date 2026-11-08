import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RpcProcess } from './rpc.ts';
import { mockProvider, isolatedEnvironment } from './fixtures/mock-provider.ts';

// Proves the optional per-spawn model override reaches the child as real
// --provider/--model flags: the child requests its own model while the parent
// keeps its own.
test('native RPC parent: spawn model override uses that model only for the child', async () => {
  const mock = await mockProvider();
  const { env } = await isolatedEnvironment(mock.url);
  const oldEnv = { ...process.env };
  Object.assign(process.env, env);
  const events: any[] = [];
  const failures: Error[] = [];
  const rpc = new RpcProcess({ command: 'pi', args: ['--mode', 'rpc', '--no-session', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '-e', './index.ts', '--model', 'mock/mock', '--thinking', 'off', '--tools', 'subagent'], cwd: process.cwd() }, e => events.push(e), e => failures.push(e));
  const settled = () => events.filter(e => e.type === 'agent_settled').length;
  const prompt = (message: string) => rpc.request('prompt', { message, streamingBehavior: 'steer' });
  async function until(fn: () => boolean, label: string) {
    for (let i = 0; i < 1000; i++) {
      if (fn()) return;
      if (failures.length) throw new Error(failures.map(f => f.message).join('\n'));
      await new Promise(r => setTimeout(r, 20));
    }
    assert.fail(`Timed out: ${label}`);
  }
  const isParent = (request: any) => request.tools?.some((t: any) => t.function?.name === 'subagent');
  try {
    const state = await rpc.request('get_state');
    assert.equal(`${state.model.provider}/${state.model.id}`, 'mock/mock');
    await prompt('DELEGATE_ALT');
    await until(() => mock.childPending.length === 1, 'child request reached provider');
    const child = mock.requests.filter(r => !isParent(r)).at(-1);
    assert.equal(child.model, 'mock-alt', 'child requested the overridden model');
    mock.releaseChild();
    await until(() => mock.childPending.length === 1, 'child tool result');
    mock.releaseChild();
    await until(() => settled() >= 2, 'completion');
    const parent = mock.requests.filter(isParent).at(-1);
    assert.equal(parent.model, 'mock', 'parent kept its own model');
    assert.deepEqual(failures, []);
  } finally {
    await rpc.stop();
    await mock.close();
    for (const key of Object.keys(env)) {
      if (oldEnv[key] === undefined) delete process.env[key]; else process.env[key] = oldEnv[key];
    }
  }
});
