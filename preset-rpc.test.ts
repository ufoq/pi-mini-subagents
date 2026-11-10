import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RpcProcess } from './rpc.ts';
import { mockProvider, isolatedEnvironment } from './fixtures/mock-provider.ts';

// Proves a preset reaches a real child Pi process as a system append, while
// explicit spawn arguments override only the fields they provide.
test('native RPC parent: preset supplies system append and defaults; explicit tools override', async () => {
  const mock = await mockProvider();
  const { env } = await isolatedEnvironment(mock.url);
  const presetDir = join(env.PI_CODING_AGENT_DIR, 'subagent-presets');
  await mkdir(presetDir, { recursive: true });
  await writeFile(join(presetDir, 'oracle.md'), `---
name: oracle
description: Offline preset fixture
tools: read, grep, find, ls
model: mock/mock
thinking: low
---
PRESET_SYSTEM_MARKER: treat this as a read-only consultation.
`);
  const oldEnv = { ...process.env };
  Object.assign(process.env, env);
  const events: any[] = [];
  const failures: Error[] = [];
  const rpc = new RpcProcess({ command: 'pi', args: ['--mode', 'rpc', '--no-session', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '-e', './index.ts', '--model', 'mock/mock', '--thinking', 'off', '--tools', 'subagent'], cwd: process.cwd() }, e => events.push(e), e => failures.push(e));
  const settled = () => events.filter(e => e.type === 'agent_settled').length;
  const prompt = (message: string) => rpc.request('prompt', { message, streamingBehavior: 'steer' });
  const isParent = (request: any) => request.tools?.some((t: any) => t.function?.name === 'subagent');
  const text = (message: any) => typeof message.content === 'string' ? message.content : (message.content ?? []).map((part: any) => part.text ?? '').join('\n');
  async function until(fn: () => boolean, label: string) {
    for (let i = 0; i < 1000; i++) {
      if (fn()) return;
      if (failures.length) throw new Error(failures.map(f => f.message).join('\n'));
      await new Promise(r => setTimeout(r, 20));
    }
    assert.fail(`Timed out: ${label}`);
  }
  try {
    await prompt('DELEGATE_PRESET');
    await until(() => mock.childPending.length === 1, 'preset child request');
    const request = mock.requests.filter(r => !isParent(r)).at(-1);
    const system = request.messages.filter((m: any) => m.role === 'system').map(text).join('\n');
    const user = request.messages.filter((m: any) => m.role === 'user').map(text).join('\n');
    assert.match(system, /PRESET_SYSTEM_MARKER/, 'preset body is appended to the system prompt');
    assert.doesNotMatch(system, /MOCK_PRESET_TASK/, 'the task is not folded into the role prompt');
    assert.match(user, /MOCK_PRESET_TASK/, 'the task remains the user message');
    assert.deepEqual(request.tools.map((t: any) => t.function.name).sort(), ['read'], 'explicit tools override the preset allowlist');
    assert.equal(request.model, 'mock', 'the preset model is used when no explicit model is given');
    assert.ok(!request.tools.some((t: any) => t.function.name === 'subagent'), 'a child cannot delegate');

    mock.releaseChild();
    await until(() => settled() >= 2, 'preset child completion');
    assert.deepEqual(failures, []);
  } finally {
    await rpc.stop(); await mock.close();
    for (const key of Object.keys(env)) {
      if (oldEnv[key] === undefined) delete process.env[key]; else process.env[key] = oldEnv[key];
    }
  }
});
