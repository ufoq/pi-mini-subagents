import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { RpcProcess, type Invocation, type RecordData } from './rpc.ts';

export type Status = 'starting' | 'running' | 'finished' | 'failed' | 'stopped';
export interface ToolActivity {
  id: string; name: string; args: RecordData; result?: RecordData; running: boolean; isError?: boolean; interrupted?: boolean; reported?: boolean;
}
export interface Snapshot {
  id: string; task: string; status: Status; sessionId?: string; model?: string;
  messages: RecordData[]; streaming?: RecordData; interrupted?: string;
  tools: Record<string, ToolActivity>; result?: string; error?: string;
}
interface Child extends Snapshot { rpc: RpcProcess; ready: Promise<void>; held?: boolean; dirty?: boolean; pending?: Status[] }
type ProcessFactory = (spec: Invocation, event: (e: RecordData) => void, failure: (e: Error) => void) => RpcProcess;

export function childInvocation(cwd: string, model?: { provider: string; id: string }, thinking?: string): Invocation {
  const shell = process.platform === 'win32' ? 'powershell' : 'bash';
  // All built-in tools plus inherited skills, templates and themes. Extensions
  // stay off, so MCP and our own `subagent` tool never load in a child. Children
  // write no transcript, so they never appear in Pi's /resume list.
  const args = ['--mode', 'rpc', '--no-session', '--no-extensions', '--tools', `read,${shell},edit,write,grep,find,ls`];
  if (model) args.push('--provider', model.provider, '--model', model.id);
  if (thinking) args.push('--thinking', thinking);
  // Use the same CLI as the parent when running a standard Node installation.
  if (!/^(?:node|bun)(?:\.exe)?$/.test(basename(process.execPath))) return { command: process.execPath, args, cwd };
  let cli = process.argv[1];
  try { cli = realpathSync(cli); } catch { /* PATH fallback for embedded hosts. */ }
  const isPiCli = cli && /(?:^|\/)pi-coding-agent\/.*cli\.(?:js|ts)$/.test(cli);
  return { command: isPiCli ? process.execPath : 'pi', args: isPiCli ? [cli, ...args] : args, cwd };
}

export function messageText(message?: RecordData): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  return (message.content ?? []).filter((c: RecordData) => c.type === 'text').map((c: RecordData) => c.text).filter(Boolean).join('\n');
}
/** One line with no terminal escapes or control characters. */
export function plain(text: string): string {
  return sanitize(text).replace(/\s+/g, ' ').trim();
}
/** A plain label, additionally bounded to 100 code points for model replies. */
export function label(text: string): string {
  return [...plain(text)].slice(0, 100).join('');
}
const LIMIT = 8000;
/** Keep the trailing reminder even when the body is truncated. */
function bounded(text: string, tail?: string) {
  const suffix = tail ? `\n${tail}` : '';
  if (text.length + suffix.length <= LIMIT) return text + suffix;
  const note = '\n[truncated; full conversation in /agents]';
  return text.slice(0, Math.max(0, LIMIT - suffix.length - note.length)) + note + suffix;
}
function c1Introducer(code: number) {
  return code === 0x9b || code === 0x9d || code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f;
}
function cancelled(code: number) {
  return code === 0x18 || code === 0x1a; // CAN / SUB
}
type ScanState = null | { kind: 'csi' } | { kind: 'string'; bel: boolean };
function scan(text: string, initial: ScanState): { text: string; state: ScanState } {
  let out = '';
  let state = initial;
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (state?.kind === 'csi') {
      if (cancelled(code) || code === 0x9c) { state = null; i++; continue; }
      if (code === 0x1b || c1Introducer(code)) { state = null; continue; }
      if (code >= 0x40 && code <= 0x7e) { state = null; i++; continue; }
      i++; continue;
    }
    if (state?.kind === 'string') {
      if (code === 0x9c) { state = null; i++; continue; }
      if (cancelled(code)) { state = null; i++; continue; }
      if (code === 0x1b) {
        if (text.charCodeAt(i + 1) === 0x5c) { state = null; i += 2; continue; }
        state = null; continue;
      }
      if (c1Introducer(code)) { state = null; continue; }
      if (state.bel && code === 0x07) { state = null; i++; continue; }
      i++; continue;
    }
    if (code === 0x1b) {
      // NUL and other C0 controls do not end an escape sequence.
      let j = i + 1;
      while (j < text.length) {
        const c = text.charCodeAt(j);
        if (c === 0x1b || c1Introducer(c) || cancelled(c)) break;
        if (c === 0x7f || c < 0x20) { j++; continue; }
        break;
      }
      if (j >= text.length) { i = j; break; }
      const next = text.charCodeAt(j);
      if (next === 0x1b || c1Introducer(next)) { i = j; continue; }
      if (next === 0x5d) { state = { kind: 'string', bel: true }; i = j + 1; continue; }
      if (next === 0x5b) { state = { kind: 'csi' }; i = j + 1; continue; }
      if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) { state = { kind: 'string', bel: false }; i = j + 1; continue; }
      if (next === 0x28 || next === 0x29 || next === 0x23) {
        const following = text.charCodeAt(j + 1);
        i = following === 0x1b || c1Introducer(following) ? j + 1 : j + 2;
        continue;
      }
      i = j + 1;
      continue;
    }
    if (c1Introducer(code)) {
      if (code === 0x9d) state = { kind: 'string', bel: true };
      else if (code === 0x9b) state = { kind: 'csi' };
      else state = { kind: 'string', bel: false };
      i++; continue;
    }
    if (code === 0x0a) { out += '\n'; i++; continue; }
    if (code === 0x09) { out += '\t'; i++; continue; }
    if (code === 0x0d) { if (text.charCodeAt(i + 1) === 0x0a) i++; out += '\n'; i++; continue; }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) { i++; continue; }
    out += text[i]; i++;
  }
  return { text: out, state };
}
/** Strip terminal escapes/control characters but preserve code spacing and newlines. */
export function sanitize(text: string): string { return scan(text, null).text; }
/** Stateful sanitizer for a composed display stream; split control strings stay hidden. */
export function createSanitizer() {
  let state: ScanState = null;
  return (text: string) => { const result = scan(text, state); state = result.state; return result.text; };
}
/** Sanitize a sequence of text blocks as one stream, so a control string split across blocks stays hidden. */
export function sanitizeMany(texts: string[]): string[] {
  const clean = createSanitizer();
  return texts.map(clean);
}
const clip = (text: string, limit = 500) => {
  const value = sanitize(text);
  return [...value].length <= limit ? value : [...value].slice(0, limit).join('') + '…';
};
function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitize(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [sanitize(key), sanitizeValue(item)]));
  return value;
}
function argsText(args: unknown) {
  try { return JSON.stringify(sanitizeValue(args)); } catch { return String(args); }
}
/** One attributed line per message/tool call, so `read` does not dump an unlabelled wall. */
export function transcript(c: Snapshot): string {
  const live: string[] = [];
  const recentLines: string[] = [];
  const completed: string[] = [];
  const recent = c.messages.slice(-8);
  for (const m of recent) {
    if (m.role === 'toolResult') {
      recentLines.push(`tool ${sanitize(String(m.toolName ?? '?'))}${m.isError ? ' (error)' : ''}: ${clip(messageText(m))}`);
    } else if (m.role === 'assistant') {
      const calls = (m.content ?? []).filter((x: RecordData) => x.type === 'toolCall').map((x: RecordData) => sanitize(String(x.name ?? '?')));
      const text = messageText(m);
      recentLines.push(`assistant: ${clip(text || '(no text)')}${calls.length ? ` [called ${calls.join(', ')}]` : ''}`);
    } else if (m.role === 'user') {
      recentLines.push(`user: ${clip(messageText(m))}`);
    } else {
      recentLines.push(`${sanitize(String(m.role ?? 'message'))}: ${clip(messageText(m))}`);
    }
  }
  if (c.streaming) live.push(`assistant (streaming): ${clip(messageText(c.streaming))}`);
  if (c.interrupted) live.push(`assistant (interrupted): ${clip(c.interrupted)}`);
  for (const tool of Object.values(c.tools)) {
    if (tool.reported) continue;
    const name = sanitize(String(tool.name));
    if (tool.running) {
      live.push(`tool ${name} (running): ${clip(argsText(tool.args))}${tool.result ? ` → ${clip(messageText(tool.result))}` : ''}`);
    } else if (tool.interrupted) {
      live.push(`tool ${name} (interrupted): ${clip(argsText(tool.args))}${tool.result ? ` → ${clip(messageText(tool.result))}` : ''}`);
    } else if (tool.result) {
      // Parallel batches can finish a tool before Pi emits its toolResult message.
      completed.push(`tool ${name}: ${clip(messageText(tool.result))}`);
    }
  }
  return sanitize([...live, ...recentLines, ...completed].join('\n'));
}
function requireMessage(message: string) {
  if (typeof message !== 'string' || !message.trim()) throw new Error('A non-empty message is required.');
}

/** One session-local registry shared by model controls and human observation. */
export class Agents {
  private children = new Map<string, Child>();
  private listeners = new Set<(id: string) => void>();
  private sequence = 0;
  private closing = false;
  private notify: (id: string, status: Status) => void;
  private createProcess: ProcessFactory;

  constructor(notify: (id: string, status: Status) => void, createProcess: ProcessFactory = (spec, event, failure) => new RpcProcess(spec, event, failure)) {
    this.notify = notify;
    this.createProcess = createProcess;
  }

  spawn(message: string, invocation: Invocation): string {
    requireMessage(message);
    if (this.closing) throw new Error('Subagent registry is shutting down.');
    const id = `j${++this.sequence}`;
    const child = { id, task: message, status: 'starting', messages: [], tools: {} } as Child;
    // Register first so a process factory that calls back synchronously can be
    // observed; hold notifications until launch has actually succeeded.
    child.held = true;
    this.children.set(id, child);
    try {
      child.rpc = this.createProcess(invocation, event => this.event(child, event), error => this.failed(child, error));
    } catch (error) {
      // e.g. invalid argv: never retain a child that owns no process.
      this.children.delete(id);
      throw new Error(sanitize(`Could not start ${id}: ${error instanceof Error ? error.message : String(error)}`));
    }
    // Launch succeeded: publish everything a synchronous factory callback queued.
    child.held = false;
    child.ready = this.start(child, message);
    const provisional = child.dirty === true;
    if (provisional) { child.dirty = false; this.changed(id); }
    for (const status of child.pending?.splice(0) ?? []) this.complete(id, status);
    if (!provisional) this.changed(id);
    return id;
  }

  private async start(child: Child, message: string) {
    try {
      // A synchronous factory callback may already have finished this launch.
      if (child.status !== 'starting') return;
      const state = await child.rpc.request('get_state');
      child.sessionId = state.sessionId;
      if (state.model) child.model = `${state.model.provider}/${state.model.id}`;
      const history = await child.rpc.request('get_messages');
      // Live events can land while history is in flight; keep both, history first.
      child.messages = [...(history.messages ?? []), ...child.messages];
      if (child.status !== 'starting') return;
      child.status = 'running';
      this.changed(child.id);
      const accepted = await child.rpc.request('prompt', { message, streamingBehavior: 'steer' });
      if (accepted.disposition === 'handled') throw new Error('Child prompt was handled without starting work.');
    } catch (error) {
      this.failed(child, error);
      await child.rpc.stop();
    }
  }

  /** Current status without copying the conversation, for hot UI paths. */
  status(id: string): Status { return this.get(id).status; }
  list() {
    return [...this.children.values()].map(c => ({ id: c.id, status: c.status, task: label(c.task) }));
  }

  snapshot(id: string): Snapshot {
    const { rpc: _rpc, ready: _ready, ...snapshot } = this.get(id);
    return structuredClone(snapshot);
  }

  read(id: string): string {
    const c = this.get(id);
    const header = `${id} ${c.status}${c.model ? ` · ${sanitize(c.model)}` : ''}`;
    const error = c.error ? sanitize(c.error) : '';
    const result = c.result ? sanitize(c.result) : '';
    if (c.status === 'stopped') {
      const shown = transcript(c);
      // The transcript already shows the latest assistant text, so avoid repeating it.
      const retained = result && !shown.includes(clip(result)) ? result : '';
      return bounded([header, error, retained, shown].filter(Boolean).join('\n'), 'stopped: transcript retained in memory until parent shutdown');
    }
    if (c.status !== 'running' && c.status !== 'starting') {
      return bounded([header, error, result].filter(Boolean).join('\n'), 'retained: transcript in memory; subagent stop releases any live child process');
    }
    return bounded([header, transcript(c)].filter(Boolean).join('\n'));
  }

  async send(id: string, message: string): Promise<void> {
    requireMessage(message);
    const c = this.get(id);
    await c.ready;
    if (c.status === 'stopped') throw new Error(`Subagent ${id} is stopped; spawn a new child.`);
    const previous = { status: c.status, error: c.error, result: c.result };
    c.status = 'running'; c.error = undefined; c.result = undefined;
    this.changed(id);
    try {
      const accepted = await c.rpc.request('prompt', { message, streamingBehavior: 'steer' });
      if (accepted.disposition === 'handled') throw new Error('Child prompt was handled without starting work.');
    } catch (error) {
      // A rejected input is not proof that the already-running child failed.
      // Transport failures report themselves through onFailure instead.
      if (c.status === 'running') { Object.assign(c, previous); this.changed(id); }
      throw new Error(sanitize(error instanceof Error ? error.message : String(error)));
    }
  }

  async stop(id: string): Promise<void> {
    const c = this.get(id);
    c.status = 'stopped';
    // Keep what the child had produced so stop-then-read is still useful.
    if (c.streaming) c.interrupted = messageText(c.streaming);
    c.streaming = undefined;
    interruptTools(c, 'Stopped before tool completed.');
    this.changed(id);
    try { await c.rpc.stop(); }
    catch (error) { throw new Error(sanitize(error instanceof Error ? error.message : String(error))); }
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.children.keys()].map(id => this.stop(id)));
    this.listeners.clear();
  }

  subscribe(listener: (id: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private get(id: string): Child {
    const child = this.children.get(id);
    if (!child) throw new Error(sanitize(`Unknown subagent ${JSON.stringify(id)}. Use list to find ids.`));
    return child;
  }
  private changed(id: string) {
    const child = this.children.get(id);
    // A discarded child must never reach observers.
    if (!child) return;
    // A provisional child is not published until its process exists.
    if (child.held) { child.dirty = true; return; }
    for (const listener of [...this.listeners]) {
      try { listener(id); } catch (error) { console.error('Subagent observer failed:', error); }
    }
  }
  private failed(c: Child, error: unknown) {
    if (c.status === 'stopped' || c.status === 'failed') return;
    c.status = 'failed'; c.error = String(error instanceof Error ? error.message : error); c.streaming = undefined;
    interruptTools(c, 'Child process/command failed before tool completed.');
    this.changed(c.id);
    this.complete(c.id, c.status);
  }

  /** Attempt completion once, after launch, never for a discarded child. Delivery failures are logged, not retried. */
  private complete(id: string, status: Status) {
    if (this.closing) return;
    const child = this.children.get(id);
    // A discarded child never completes; a held one queues until launch.
    if (!child) return;
    if (child.held) { (child.pending ??= []).push(status); return; }
    try {
      this.notify(id, status);
    } catch (error) {
      // Delivery failure must not invalidate an otherwise running child.
      console.error('Subagent completion delivery failed:', error);
    }
  }

  private event(c: Child, e: RecordData) {
    if (c.status === 'stopped') return;
    switch (e.type) {
      case 'message_start':
        if (e.message.role === 'assistant') c.streaming = e.message;
        break;
      case 'message_update': updateStreaming(c, e.assistantMessageEvent); break;
      case 'message_end':
        c.messages.push(e.message);
        if (e.message.role === 'assistant') c.streaming = undefined;
        if (e.message.role === 'toolResult') {
          const tool = c.tools[e.message.toolCallId];
          if (tool && !tool.running) tool.reported = true;
        }
        break;
      case 'tool_execution_start':
        c.tools[e.toolCallId] = { id: e.toolCallId, name: e.toolName, args: e.args ?? {}, running: true };
        break;
      case 'tool_execution_update':
      case 'tool_execution_end': {
        const tool = c.tools[e.toolCallId] ??= { id: e.toolCallId, name: e.toolName, args: e.args ?? {}, running: true };
        tool.result = e.partialResult ?? e.result;
        tool.running = e.type !== 'tool_execution_end'; tool.isError = e.isError;
        break;
      }
      case 'agent_settled': {
        const last = c.messages.findLast(m => m.role === 'assistant');
        c.result = messageText(last) || '(no assistant text)';
        c.error = last?.errorMessage ?? (e.aborted ? 'Child run aborted.' : last?.stopReason === 'error' ? 'Child provider failed.' : undefined);
        c.status = c.error ? 'failed' : 'finished';
        c.streaming = undefined;
        this.changed(c.id);
        this.complete(c.id, c.status);
        return;
      }
    }
    this.changed(c.id);
  }
}

function interruptTools(c: Snapshot, reason: string) {
  for (const tool of Object.values(c.tools)) {
    if (!tool.running) continue;
    tool.running = false; tool.isError = true; tool.interrupted = true;
    tool.result = { ...tool.result, isError: true, content: [...(tool.result?.content ?? []), { type: 'text', text: `[${reason}]` }] };
  }
}

/** Delta reconstruction for live display only; message_end replaces it. */
function updateStreaming(c: Snapshot, e: RecordData) {
  if (!c.streaming || typeof e.contentIndex !== 'number') return;
  const content = c.streaming.content;
  const i = e.contentIndex;
  if (e.type === 'text_start') content[i] = { type: 'text', text: '' };
  else if (e.type === 'thinking_start') content[i] = { type: 'thinking', thinking: '' };
  else if (e.type === 'toolcall_start') content[i] = { type: 'toolCall', id: e.id, name: e.toolName, arguments: {}, partialArguments: '' };
  else if (e.type === 'text_delta') { content[i] ??= { type: 'text', text: '' }; content[i].text += e.delta; }
  else if (e.type === 'thinking_delta') { content[i] ??= { type: 'thinking', thinking: '' }; content[i].thinking += e.delta; }
  else if (e.type === 'toolcall_delta' && content[i]) content[i].partialArguments += e.delta;
  else if (e.type === 'text_end') content[i] = { type: 'text', text: e.content };
  else if (e.type === 'thinking_end') content[i] = { type: 'thinking', thinking: e.content };
  else if (e.type === 'toolcall_end') content[i] = e.toolCall;
}
