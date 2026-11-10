import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from '@earendil-works/pi-coding-agent';
import { label } from './agents.ts';

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface ModelRef { provider: string; id: string }
export interface Preset {
  name: string;
  description: string;
  systemAppend: string;
  model?: ModelRef;
  thinking?: ThinkingLevel;
  tools?: string[];
  source: 'user' | 'project';
  filePath: string;
}
export interface PresetError { filePath: string; message: string }
export interface PresetDiscovery {
  presets: Preset[];
  errors: PresetError[];
  userDir: string;
  projectDir?: string;
}
export interface PresetDiscoveryOptions {
  cwd: string;
  trusted: boolean;
  /** Test seam; defaults to Pi's agent directory. */
  agentDir?: string;
}

const TOOL_NAMES = new Set(['read', 'bash', 'powershell', 'edit', 'write', 'grep', 'find', 'ls']);
const THINKING_LEVELS = new Set<ThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_SYSTEM_APPEND = 64 * 1024;

/** "provider/model" (model ids may contain slashes); undefined keeps the parent model. */
export function parseModel(spec?: string): ModelRef | undefined {
  if (spec === undefined) return undefined;
  // Control characters (notably NUL) cannot be passed to a subprocess argv.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(spec)) throw new Error('model must not contain control characters.');
  const match = /^([^/\s]+)\/(\S.*)$/.exec(spec.trim());
  if (!match) throw new Error('model must be "provider/model", for example "anthropic/claude-sonnet-4-5".');
  return { provider: match[1], id: match[2].trim() };
}

export function parseThinking(value: unknown): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !THINKING_LEVELS.has(value.trim() as ThinkingLevel)) {
    throw new Error(`thinking must be one of ${[...THINKING_LEVELS].join(', ')}.`);
  }
  return value.trim() as ThinkingLevel;
}

/** Accept the YAML string and array spellings, plus the compact model-tool string. */
export function parseTools(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : undefined;
  if (!raw) throw new Error('tools must be a comma-separated string or a list of tool names.');
  const tools = raw.map(item => typeof item === 'string' ? item.trim() : '').filter(Boolean);
  if (!tools.length) throw new Error('tools must not be empty.');
  const unknown = tools.filter(tool => !TOOL_NAMES.has(tool));
  if (unknown.length) throw new Error(`unknown tool${unknown.length === 1 ? '' : 's'} ${unknown.join(', ')}; use ${[...TOOL_NAMES].join(', ')}.`);
  return [...new Set(tools)];
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function findProjectDir(cwd: string): string | undefined {
  let current = resolve(cwd);
  while (true) {
    const candidate = join(current, CONFIG_DIR_NAME, 'subagent-presets');
    if (isDirectory(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function readPreset(filePath: string, source: 'user' | 'project'): Preset {
  let content: string;
  try { content = readFileSync(filePath, 'utf8'); }
  catch (error) { throw new Error(`could not read file: ${error instanceof Error ? error.message : String(error)}`); }

  let parsed: { frontmatter: Record<string, unknown>; body: string };
  try { parsed = parseFrontmatter<Record<string, unknown>>(content); }
  catch (error) { throw new Error(`invalid frontmatter: ${error instanceof Error ? error.message : String(error)}`); }
  const fm = parsed.frontmatter;

  if (typeof fm.name !== 'string' || !fm.name.trim()) throw new Error('name is required.');
  const name = fm.name.trim();
  if (!NAME.test(name)) throw new Error('name must start with a letter or digit and contain only letters, digits, ".", "_" or "-".');
  if (typeof fm.description !== 'string' || !fm.description.trim()) throw new Error('description is required.');
  const description = fm.description.trim();

  if (fm.system_append !== undefined && typeof fm.system_append !== 'string') throw new Error('system_append must be a string.');
  let systemAppend = typeof fm.system_append === 'string' ? fm.system_append.trim() : '';
  // The Markdown body is the conventional prompt. An explicit frontmatter
  // system_append takes precedence, so either spelling is usable.
  if (!systemAppend) systemAppend = parsed.body.trim();
  if (!systemAppend) throw new Error('system_append or a non-empty Markdown body is required.');
  if (Buffer.byteLength(systemAppend) > MAX_SYSTEM_APPEND) throw new Error(`system_append exceeds ${MAX_SYSTEM_APPEND} bytes.`);

  if (fm.model !== undefined && typeof fm.model !== 'string') throw new Error('model must be a string.');
  const model = fm.model === undefined ? undefined : parseModel(fm.model);
  const thinking = parseThinking(fm.thinking);
  const tools = parseTools(fm.tools);

  return { name, description, systemAppend, model, thinking, tools, source, filePath };
}

function loadDir(dir: string, source: 'user' | 'project', target: Map<string, Preset>, errors: PresetError[]) {
  if (!isDirectory(dir)) return;
  let entries: string[];
  try { entries = readdirSync(dir).filter(name => name.endsWith('.md')).sort(); }
  catch (error) {
    errors.push({ filePath: dir, message: `could not read directory: ${error instanceof Error ? error.message : String(error)}` });
    return;
  }

  const local = new Map<string, Preset>();
  const duplicates = new Set<string>();
  for (const entry of entries) {
    const filePath = join(dir, entry);
    try {
      const preset = readPreset(filePath, source);
      if (local.has(preset.name)) {
        duplicates.add(preset.name);
        errors.push({ filePath, message: `duplicate preset name "${preset.name}".` });
      } else local.set(preset.name, preset);
    } catch (error) {
      errors.push({ filePath, message: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const name of duplicates) local.delete(name);
  for (const [name, preset] of local) target.set(name, preset);
}

export function discoverPresets(options: PresetDiscoveryOptions): PresetDiscovery {
  const userDir = join(options.agentDir ?? getAgentDir(), 'subagent-presets');
  const candidateProject = findProjectDir(options.cwd);
  const projectDir = options.trusted ? candidateProject : undefined;
  const presets = new Map<string, Preset>();
  const errors: PresetError[] = [];
  loadDir(userDir, 'user', presets, errors);
  if (projectDir) loadDir(projectDir, 'project', presets, errors);
  return {
    presets: [...presets.values()].sort((a, b) => a.name.localeCompare(b.name)),
    errors,
    userDir,
    projectDir,
  };
}

export function findPreset(name: string, discovery: PresetDiscovery): Preset | undefined {
  return discovery.presets.find(preset => preset.name === name);
}

export function unknownPreset(name: string, discovery: PresetDiscovery): string {
  const available = discovery.presets.map(preset => preset.name);
  const where = discovery.presets.length
    ? `Available: ${available.join(', ')}.`
    : `No presets found. Add Markdown files under ${discovery.userDir}.`;
  return `Unknown subagent preset ${JSON.stringify(label(name))}. ${where}`;
}

export function presetsReply(discovery: PresetDiscovery): string {
  const lines = discovery.presets.map(preset => {
    const parts = [`${preset.name} (${preset.source}) — ${label(preset.description)}`];
    const defaults: string[] = [];
    if (preset.tools) defaults.push(`tools ${preset.tools.join(',')}`);
    if (preset.model) defaults.push(`model ${preset.model.provider}/${preset.model.id}`);
    if (preset.thinking) defaults.push(`thinking ${preset.thinking}`);
    if (defaults.length) parts.push(`[${defaults.join('; ')}]`);
    return parts.join(' ');
  });
  if (!lines.length) lines.push(`No subagent presets. Add Markdown files under ${discovery.userDir}.`);
  for (const error of discovery.errors) lines.push(`invalid ${label(error.filePath)}: ${label(error.message)}`);
  return lines.join('\n');
}
