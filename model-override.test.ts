import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RpcProcess } from './rpc.ts';
import { mockProvider, isolatedEnvironment } from './fixtures/mock-provider.ts';

// Proves the optional per-spawn model override reaches the child as real
// --provider/--model flags: the child's provider is a second endpoint while the
// parent keeps its own provider and model.
test('native RPC parent: spawn model override switches provider and model for the child only', async () => {
  const mock = await mockProvider();
  const alt = await mockProvider(); // separate port: a distinct provider baseUrl
  const { env } = await isolatedEnvironment(mock.url, alt.url);
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
    await until(() => alt.childPending.length === 1, 'child request reached the second provider');
    assert.equal(alt.requests.at(-1).model, 'mock-alt', 'child requested the overridden model');
    assert.equal(mock.requests.filter(r => !isParent(r)).length, 0, 'no child request used the parent provider');
    alt.releaseChild();
    await until(() => alt.childPending.length === 1, 'child tool result');
    alt.releaseChild();
    await until(() => settled() >= 2, 'completion');
    const parent = mock.requests.filter(isParent).at(-1);
    assert.equal(parent.model, 'mock', 'parent kept its own model on its own provider');
    assert.deepEqual(failures, []);
  } finally {
    await rpc.stop();
    await mock.close();
    await alt.close();
    for (const key of Object.keys(env)) {
      if (oldEnv[key] === undefined) delete process.env[key]; else process.env[key] = oldEnv[key];
    }
  }
});
