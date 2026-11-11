import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from './fixtures/pi-loader.ts';

const { composeSystemAppend, discoverPresets, parseModel, parseThinking, parseTools, presetNamesLine, presetsReply, unknownPreset } = await load.import('../presets.ts');

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'mini-presets-'));
  const agentDir = join(root, 'agent');
  const project = join(root, 'project');
  await mkdir(join(project, '.pi', 'subagent-presets'), { recursive: true });
  await mkdir(join(agentDir, 'subagent-presets'), { recursive: true });
  return { root, agentDir, project };
}

test('preset append preserves normal append and uses project append only when trusted', async () => {
  const ws = await workspace();
  try {
    await writeFile(join(ws.agentDir, 'APPEND_SYSTEM.md'), 'GLOBAL_APPEND');
    await writeFile(join(ws.project, '.pi', 'APPEND_SYSTEM.md'), 'PROJECT_APPEND');
    assert.equal(composeSystemAppend(ws.project, false, 'PRESET_APPEND', ws.agentDir), 'GLOBAL_APPEND\n\nPRESET_APPEND');
    assert.equal(composeSystemAppend(ws.project, true, 'PRESET_APPEND', ws.agentDir), 'PROJECT_APPEND\n\nPRESET_APPEND');
  } finally { await rm(ws.root, { recursive: true, force: true }); }
});

test('discovery loads user presets, trusts project presets, and lets project override', async () => {
  const ws = await workspace();
  try {
    await writeFile(join(ws.agentDir, 'subagent-presets', 'oracle.md'), `---
name: oracle
description: Read-only engineering consultant
tools: read, grep, find, ls
model: mock/mock
thinking: high
---
ORACLE_BODY
`);
    await writeFile(join(ws.agentDir, 'subagent-presets', 'reviewer.md'), `---
name: reviewer
description: User reviewer
tools: [read, grep]
---
USER_REVIEWER
`);
    await writeFile(join(ws.project, '.pi', 'subagent-presets', 'reviewer.md'), `---
name: reviewer
description: Project reviewer
tools: read, find
---
PROJECT_REVIEWER
`);
    await writeFile(join(ws.project, '.pi', 'subagent-presets', 'scout.md'), `---
name: scout
description: Project scout
---
PROJECT_SCOUT
`);

    const untrusted = discoverPresets({ cwd: ws.project, trusted: false, agentDir: ws.agentDir });
    assert.deepEqual(untrusted.presets.map(p => p.name), ['oracle', 'reviewer']);
    assert.equal(untrusted.presets.find(p => p.name === 'reviewer')?.source, 'user');
    assert.equal(untrusted.presets.find(p => p.name === 'reviewer')?.systemAppend, 'USER_REVIEWER');

    const trusted = discoverPresets({ cwd: ws.project, trusted: true, agentDir: ws.agentDir });
    assert.deepEqual(trusted.presets.map(p => p.name), ['oracle', 'reviewer', 'scout']);
    const oracle = trusted.presets.find(p => p.name === 'oracle')!;
    assert.deepEqual(oracle.tools, ['read', 'grep', 'find', 'ls']);
    assert.deepEqual(oracle.model, { provider: 'mock', id: 'mock' });
    assert.equal(oracle.thinking, 'high');
    assert.equal(oracle.systemAppend, 'ORACLE_BODY');
    assert.equal(trusted.presets.find(p => p.name === 'reviewer')?.source, 'project');
    assert.equal(trusted.presets.find(p => p.name === 'reviewer')?.systemAppend, 'PROJECT_REVIEWER');
  } finally { await rm(ws.root, { recursive: true, force: true }); }
});

test('frontmatter system_append wins, malformed presets are skipped, and duplicates are invalid', async () => {
  const ws = await workspace();
  try {
    await writeFile(join(ws.agentDir, 'subagent-presets', 'explicit.md'), `---
name: explicit
description: Explicit append
system_append: |
  EXPLICIT_SYSTEM
  SECOND_LINE
---
ignored body
`);
    await writeFile(join(ws.agentDir, 'subagent-presets', 'missing-name.md'), `---
description: no name
---
BODY
`);
    await writeFile(join(ws.agentDir, 'subagent-presets', 'bad-tool.md'), `---
name: bad-tool
description: bad
tools: read, subagent
---
BODY
`);
    await writeFile(join(ws.agentDir, 'subagent-presets', 'bad-model.md'), `---
name: bad-model
description: bad
model: not-a-provider-model
---
BODY
`);
    await writeFile(join(ws.agentDir, 'subagent-presets', 'bad-thinking.md'), `---
name: bad-thinking
description: bad
thinking: extreme
---
BODY
`);
    await writeFile(join(ws.agentDir, 'subagent-presets', 'empty.md'), `---
name: empty
description: no prompt
---
`);
    await writeFile(join(ws.agentDir, 'subagent-presets', 'dupe-a.md'), `---
name: dupe
description: first
---
A
`);
    await writeFile(join(ws.agentDir, 'subagent-presets', 'dupe-b.md'), `---
name: dupe
description: second
---
B
`);

    const found = discoverPresets({ cwd: ws.project, trusted: true, agentDir: ws.agentDir });
    assert.deepEqual(found.presets.map(p => p.name), ['explicit']);
    assert.equal(found.presets[0].systemAppend, 'EXPLICIT_SYSTEM\nSECOND_LINE');
    const messages = found.errors.map(e => e.message).join('\n');
    assert.match(messages, /name is required/);
    assert.match(messages, /unknown tool subagent/);
    assert.match(messages, /model must be/);
    assert.match(messages, /thinking must be/);
    assert.match(messages, /system_append or a non-empty Markdown body/);
    assert.match(messages, /duplicate preset name "dupe"/);
    assert.match(presetsReply(found), /explicit \(user\)/);
    assert.match(presetsReply(found), /invalid .*missing-name\.md/);
    assert.match(unknownPreset('nope', found), /Unknown subagent preset "nope".*Available: explicit/s);
  } finally { await rm(ws.root, { recursive: true, force: true }); }
});

test('list preset names are compact and capped', () => {
  assert.equal(presetNamesLine({ presets: [], errors: [], userDir: '/tmp/presets' }), 'Presets: none.');
  const presets = Array.from({ length: 25 }, (_, i) => ({ name: `p${i}` }));
  const line = presetNamesLine({ presets, errors: [], userDir: '/tmp/presets' } as any);
  assert.match(line, /^Presets: p0, p1/);
  assert.match(line, /\+5 more/);
});

test('model, thinking and tool parsers reject invalid values before launch', () => {
  assert.deepEqual(parseModel('provider/model-with/slashes'), { provider: 'provider', id: 'model-with/slashes' });
  assert.throws(() => parseModel('model'), /provider\/model/);
  assert.throws(() => parseModel('provider/bad\u0000id'), /control characters/);
  assert.equal(parseThinking('high'), 'high');
  assert.throws(() => parseThinking('extreme'), /thinking must be/);
  assert.deepEqual(parseTools('read, grep,read'), ['read', 'grep']);
  assert.deepEqual(parseTools(['read', 'ls']), ['read', 'ls']);
  assert.throws(() => parseTools('read,subagent'), /unknown tool subagent/);
  assert.throws(() => parseTools(''), /must not be empty/);
  assert.throws(() => parseTools(3), /comma-separated/);
});
