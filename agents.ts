import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { RpcProcess, type Invocation, type RecordData } from './rpc.ts';

export type Status = 'active' | 'stopped';
export type Outcome = 'finished' | 'failed';
export interface ToolActivity {
  id: string; name: string; args: RecordData; result?: RecordData; running: boolean; isError?: boolean; interrupted?: boolean; reported?: boolean;
}
export interface Snapshot {
  id: string; task: string; status: Status; preset?: string; sessionId?: string; model?: string;
  messages: RecordData[]; streaming?: RecordData; interrupted?: string; interruptedMessage?: RecordData;
  tools: Record<string, ToolActivity>; result?: string; error?: string;
}
interface Child extends Snapshot { rpc: RpcProcess; ready: Promise<void>; held?: boolean; dirty?: boolean; pending?: Outcome[]; turnStarted?: boolean; dead?: boolean; control?: Promise<void>; cleanup?: () => void; reminder?: ReturnType<typeof setTimeout>; activeSince?: number }
type ProcessFactory = (spec: Invocation, event: (e: RecordData) => void, failure: (e: Error) => void) => RpcProcess;
export interface ChildOptions { tools?: string[]; systemAppend?: string }
export interface AgentOptions {
  reminderMs?: number;
  remind?: (id: string, minutes: number) => void;
  cancelReminder?: (id: string) => void;
  cancelNotices?: (id: string) => void;
}

export const REMINDER_MS = 10 * 60 * 1000;

export function childInvocation(cwd: string, model?: { provider: string; id: string }, thinking?: string, options?: ChildOptions): Invocation {
  const shell = process.platform === 'win32' ? 'powershell' : 'bash';
  // All built-in tools plus inherited skills, templates and themes. Extensions
  // stay off, so MCP and our own `subagent` tool never load in a child. Children
  // write no transcript, so they never appear in Pi's /resume list.
  const tools = options?.tools ?? `read,${shell},edit,write,grep,find,ls`.split(',');
  const args = ['--mode', 'rpc', '--no-session', '--no-extensions', '--tools', tools.join(',')];
  let cleanup: (() => void) | undefined;
  if (options?.systemAppend) {
    const dir = mkdtempSync(join(tmpdir(), 'pi-mini-subagents-'));
    const file = join(dir, 'system-append.md');
    try { writeFileSync(file, options.systemAppend, { encoding: 'utf8', mode: 0o600 }); }
    catch (error) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } throw error; }
    args.push('--append-system-prompt', file);
    cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };
  }
  if (model) args.push('--provider', model.provider, '--model', model.id);
  if (thinking) args.push('--thinking', thinking);
  // Use the same CLI as the parent when running a standard Node installation.
  if (!/^(?:node|bun)(?:\.exe)?$/.test(basename(process.execPath))) return { command: process.execPath, args, cwd, cleanup };
  let cli = process.argv[1];
  try { cli = realpathSync(cli); } catch { /* PATH fallback for embedded hosts. */ }
  const isPiCli = cli && /(?:^|\/)pi-coding-agent\/.*cli\.(?:js|ts)$/.test(cli);
  return { command: isPiCli ? process.execPath : 'pi', args: isPiCli ? [cli, ...args] : args, cwd, cleanup };
}

export function messageText(message?: RecordData, clean?: (text: string) => string): string {
  if (!message) return '';
  if (typeof message.content === 'string') return clean ? clean(message.content) : message.content;
  const parts: string[] = [];
  for (const c of message.content ?? []) {
    if (c.type !== 'text' && c.type !== 'thinking') continue;
    const raw = typeof c.text === 'string' ? c.text : typeof c.thinking === 'string' ? c.thinking : '';
    const text = clean ? clean(raw) : raw;
    if (c.type === 'text' && text) parts.push(text);
  }
  return parts.join('\n');
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
type ScanState = null | { kind: 'esc' } | { kind: 'csi' } | { kind: 'string'; bel: boolean; pendingEsc?: boolean };
function scan(text: string, initial: ScanState): { text: string; state: ScanState } {
  if (initial?.kind === 'esc') { text = '\x1b' + text; initial = null; }
  else if (initial?.kind === 'string' && initial.pendingEsc) { text = '\x1b' + text; initial = { kind: 'string', bel: initial.bel }; }
  let out = '';
  let state = initial;
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (state?.kind === 'csi') {
      if (cancelled(code) || code === 0x9c) { state = null; i++; continue; }
      if (code === 0x1b) {
        if (i + 1 >= text.length) { state = { kind: 'esc' }; i++; continue; }
        state = null; continue;
      }
      if (c1Introducer(code)) { state = null; continue; }
      if (code >= 0x40 && code <= 0x7e) { state = null; i++; continue; }
      i++; continue;
    }
    if (state?.kind === 'string') {
      if (code === 0x9c) { state = null; i++; continue; }
      if (cancelled(code)) { state = null; i++; continue; }
      if (code === 0x1b) {
        if (text.charCodeAt(i + 1) === 0x5c) { state = null; i += 2; continue; }
        if (i + 1 >= text.length) { state = { kind: 'string', bel: state.bel, pendingEsc: true }; i++; continue; }
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
      if (j >= text.length) { state = { kind: 'esc' }; i = j; break; }
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
const trim = (value: string, limit = 500) => [...value].length <= limit ? value : [...value].slice(0, limit).join('') + '…';
function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitize(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [sanitize(key), sanitizeValue(item)]));
  return value;
}
function argsText(args: unknown) {
  try { return JSON.stringify(sanitizeValue(args)); } catch { return String(args); }
}
interface PreparedMessages {
  rows: Array<{ message: RecordData; text: string; error?: string }>;
  lastAssistant?: string;
  lastError?: string;
  lastErrorRaw?: string;
}
function prepareMessages(c: Snapshot, clean: (text: string) => string): PreparedMessages {
  const rows: PreparedMessages['rows'] = [];
  let lastAssistant: string | undefined;
  let lastError: string | undefined;
  let lastErrorRaw: string | undefined;
  for (const message of c.messages) {
    const text = messageText(message, clean);
    const error = typeof message.errorMessage === 'string' ? clean(message.errorMessage) : undefined;
    rows.push({ message, text, error });
    if (message.role === 'assistant') lastAssistant = text;
    if (error !== undefined) { lastError = error; lastErrorRaw = message.errorMessage; }
  }
  return { rows, lastAssistant, lastError, lastErrorRaw };
}
/** One attributed line per message/tool call, so `read` does not dump an unlabelled wall. */
export function transcript(c: Snapshot, prepared?: PreparedMessages, clean?: (text: string) => string, fullInterrupted = false): string {
  if (!clean) clean = createSanitizer();
  if (!prepared) prepared = prepareMessages(c, clean);
  const live: string[] = [];
  const recentLines: string[] = [];
  const completed: string[] = [];
  const recentStart = Math.max(0, prepared.rows.length - 8);
  for (let index = recentStart; index < prepared.rows.length; index++) {
    const { message: m, text } = prepared.rows[index];
    if (m.role === 'toolResult') {
      recentLines.push(`tool ${sanitize(String(m.toolName ?? '?'))}${m.isError ? ' (error)' : ''}: ${trim(text)}`);
    } else if (m.role === 'assistant') {
      const calls = (m.content ?? []).filter((x: RecordData) => x.type === 'toolCall').map((x: RecordData) => sanitize(String(x.name ?? '?')));
      recentLines.push(`assistant: ${trim(text || '(no text)')}${calls.length ? ` [called ${calls.join(', ')}]` : ''}`);
    } else if (m.role === 'user') {
      recentLines.push(`user: ${trim(text)}`);
    } else {
      recentLines.push(`${sanitize(String(m.role ?? 'message'))}: ${trim(text)}`);
    }
  }
  if (c.streaming) live.push(`assistant (streaming): ${trim(messageText(c.streaming, clean))}`);
  if (c.interruptedMessage) {
    const text = messageText(c.interruptedMessage, clean);
    if (text) live.push(`assistant (interrupted): ${trim(text, fullInterrupted ? LIMIT : 500)}`);
  } else if (c.interrupted) live.push(`assistant (interrupted): ${trim(clean(c.interrupted), fullInterrupted ? LIMIT : 500)}`);
  for (const tool of Object.values(c.tools)) {
    if (tool.reported) continue;
    const name = sanitize(String(tool.name));
    const result = tool.result ? trim(clean(messageText(tool.result))) : '';
    if (tool.running) {
      live.push(`tool ${name} (running): ${trim(argsText(tool.args))}${result ? ` → ${result}` : ''}`);
    } else if (tool.interrupted) {
      live.push(`tool ${name} (interrupted): ${trim(argsText(tool.args))}${result ? ` → ${result}` : ''}`);
    } else if (result) {
      // Parallel batches can finish a tool before Pi emits its toolResult message.
      completed.push(`tool ${name}: ${result}`);
    }
  }
  return [...live, ...recentLines, ...completed].join('\n');
}
function requireMessage(message: string) {
  if (typeof message !== 'string' || !message.trim()) throw new Error('A non-empty message is required.');
}

/** One session-local registry shared by model controls and human observation. */
export const MAX_CHILDREN = 8;

export class Agents {
  private children = new Map<string, Child>();
  private listeners = new Set<(id: string) => void>();
  private sequence = 0;
  private closing = false;
  private notify: (id: string, outcome: Outcome) => void;
  private createProcess: ProcessFactory;
  private reminderMs: number;
  private remind?: (id: string, minutes: number) => void;
  private cancelReminder?: (id: string) => void;
  private cancelNotices?: (id: string) => void;

  constructor(notify: (id: string, outcome: Outcome) => void, createProcess: ProcessFactory = (spec, event, failure) => new RpcProcess(spec, event, failure), options: AgentOptions = {}) {
    this.notify = notify;
    this.createProcess = createProcess;
    this.reminderMs = options.reminderMs ?? REMINDER_MS;
    this.remind = options.remind;
    this.cancelReminder = options.cancelReminder;
    this.cancelNotices = options.cancelNotices;
  }

  /** FIFO per child: startup, sends and stops are accepted in invocation order. */
  private enqueue<T>(c: Child, op: () => Promise<T>): Promise<T> {
    const tail = c.control ?? Promise.resolve();
    const next = tail.catch(() => {}).then(op);
    c.control = next.then(() => {}, () => {});
    return next;
  }

  spawn(message: string, invocation: Invocation, preset?: string): string {
    try {
      requireMessage(message);
      if (this.closing) throw new Error('Subagent registry is shutting down.');
      if (this.children.size >= MAX_CHILDREN) {
        throw new Error(`Subagent limit reached (${MAX_CHILDREN}). Read any output you need, then free a slot with subagent({ action: "remove", id: "<id>" }); remove releases its process and discards its transcript.`);
      }
    } catch (error) {
      invocation.cleanup?.();
      throw error;
    }
    const id = `j${++this.sequence}-${Date.now().toString(36)}`;
    const child = { id, task: message, preset, status: 'active', messages: [], tools: {} } as Child;
    // Register first so a process factory that calls back synchronously can be
    // observed; hold notifications until launch has actually succeeded.
    child.held = true;
    child.cleanup = invocation.cleanup;
    this.children.set(id, child);
    try {
      child.rpc = this.createProcess(invocation, event => this.event(child, event), error => this.failed(child, error));
    } catch (error) {
      // e.g. invalid argv: never retain a child that owns no process.
      invocation.cleanup?.();
      this.children.delete(id);
      throw new Error(sanitize(`Could not start ${id}: ${error instanceof Error ? error.message : String(error)}`));
    }
    // Launch succeeded: publish everything a synchronous factory callback queued.
    child.held = false;
    child.ready = this.enqueue(child, () => this.start(child, message));
    // Active from spawn so a launch that never reaches agent_start can still
    // produce a reminder; stop() sets stopped synchronously and cancels launch.
    child.activeSince = Date.now();
    this.armReminder(child);
    const provisional = child.dirty === true;
    if (provisional) { child.dirty = false; this.changed(id); }
    for (const outcome of child.pending?.splice(0) ?? []) this.complete(id, outcome);
    if (!provisional) this.changed(id);
    return id;
  }

  private async start(child: Child, message: string) {
    try {
      // A synchronous failure or a stop before launch means no prompt may run.
      if (this.children.get(child.id) !== child || child.status === 'stopped') return;
      const state = await child.rpc.request('get_state');
      child.sessionId = state.sessionId;
      if (state.model) child.model = `${state.model.provider}/${state.model.id}`;
      const history = await child.rpc.request('get_messages');
      // Live events can land while history is in flight; keep both without
      // duplicating a message that Pi already included in the snapshot.
      const historyMessages = history.messages ?? [];
      const seen = new Set(historyMessages.map((m: RecordData) => JSON.stringify(m)));
      child.messages = [...historyMessages, ...child.messages.filter(m => !seen.has(JSON.stringify(m)))];
      if (this.children.get(child.id) !== child || child.status === 'stopped') return;
      const accepted = await child.rpc.request('prompt', { message, streamingBehavior: 'steer' });
      if (accepted.disposition === 'handled') throw new Error('Child prompt was handled without starting work.');
    } catch (error) {
      // A transport failure has already been published by failed(); a command
      // rejection is recoverable and keeps the process for a later send.
      if (this.children.get(child.id) !== child || child.dead) return;
      this.refuse(child, error);
    }
  }

  /** Current status without copying the conversation, for hot UI paths. */
  status(id: string): Status { return this.get(id).status; }
  list() {
    return [...this.children.values()].map(c => ({ id: c.id, status: c.status, task: label(c.task), preset: c.preset }));
  }

  snapshot(id: string): Snapshot {
    const { rpc: _rpc, ready: _ready, held: _held, dirty: _dirty, pending: _pending, turnStarted: _turnStarted, dead: _dead, control: _control, cleanup: _cleanup, reminder: _reminder, activeSince: _activeSince, ...snapshot } = this.get(id);
    return structuredClone(snapshot);
  }

  read(id: string): string {
    const c = this.get(id);
    const header = `${id} ${c.status}${c.preset ? ` · ${sanitize(c.preset)}` : ''}${c.model ? ` · ${sanitize(c.model)}` : ''}`;
    const clean = createSanitizer();
    const prepared = prepareMessages(c, clean);
    const last = c.messages.findLast(m => m.role === 'assistant');
    const lastText = last ? messageText(last) : '';
    const error = c.error ? (c.error === prepared.lastErrorRaw ? prepared.lastError ?? '' : clean(c.error)) : '';
    const result = c.result ? (c.result === lastText ? prepared.lastAssistant ?? '' : clean(c.result)) : '';
    if (c.status === 'stopped') {
      const shown = transcript(c, prepared, clean, true);
      // The transcript already shows the latest assistant text, so avoid repeating it.
      // Deduplicate against the full result, not its clipped preview.
      const retained = result && !shown.includes(result) ? result : '';
      const tail = c.dead
        ? 'stopped: process gone; transcript retained until subagent remove'
        : 'stopped: transcript retained; send continues this child; subagent remove releases the process and transcript';
      return bounded([header, error, retained, shown].filter(Boolean).join('\n'), tail);
    }
    return bounded([header, transcript(c, prepared, clean)].filter(Boolean).join('\n'));
  }

  async send(id: string, message: string): Promise<void> {
    requireMessage(message);
    const c = this.get(id);
    await this.enqueue(c, async () => {
      if (this.children.get(c.id) !== c) throw new Error(`Unknown subagent ${JSON.stringify(sanitize(String(id)))}. Use list to find ids.`);
      if (c.dead) throw new Error(`Subagent ${id} process is gone; read its output, then remove it.`);
      // Only an idle send waits for a new agent_start. Steering an active run
      // must not make a later transport failure discard the partial answer.
      const idle = c.status === 'stopped';
      const wasPending = c.turnStarted === true;
      if (idle) c.turnStarted = true;
      try {
        const accepted = await c.rpc.request('prompt', { message, streamingBehavior: 'steer' });
        if (accepted.disposition === 'handled') throw new Error('Child prompt was handled without starting work.');
      } catch (error) {
        if (idle && !wasPending) c.turnStarted = false;
        if (c.dead) throw new Error(`Subagent ${id} process is gone; read its output, then remove it.`);
        throw new Error(sanitize(error instanceof Error ? error.message : String(error)));
      }
    });
  }

  async stop(id: string): Promise<void> {
    const c = this.get(id);
    this.clearReminder(c);
    try { this.cancelReminder?.(id); } catch (error) { console.error('Subagent reminder cancellation failed:', error); }
    // A dead child has no transport to abort. Repeated stop is safe: Pi's
    // abort is a no-op on an idle child and waits for the run to settle.
    if (c.dead) { c.status = 'stopped'; return; }
    c.status = 'stopped';
    // Keep what the child had produced so stop-then-read is still useful.
    if (c.streaming) { c.interrupted = messageText(c.streaming); c.interruptedMessage = c.streaming; }
    c.streaming = undefined;
    interruptTools(c, 'Stopped before tool completed.');
    this.changed(id);
    await this.enqueue(c, async () => {
      if (this.children.get(c.id) !== c) return;
      try {
        await c.rpc.request('clear_queue');
        await c.rpc.request('abort');
      } catch (error) {
        if (!c.dead) {
          c.error = String(error instanceof Error ? error.message : error);
          throw new Error(sanitize(c.error));
        }
      } finally {
        if (this.children.get(c.id) === c) {
          c.status = 'stopped'; c.streaming = undefined; c.turnStarted = false;
          c.cleanup?.(); c.cleanup = undefined;
          this.changed(id);
        }
      }
    });
  }

  async remove(id: string): Promise<void> {
    const c = this.get(id);
    this.clearReminder(c);
    try { this.cancelReminder?.(id); this.cancelNotices?.(id); } catch (error) { console.error('Subagent notice cancellation failed:', error); }
    c.cleanup?.(); c.cleanup = undefined;
    // Delete and notify first: the cap slot and the viewer must not wait for
    // the SIGTERM grace period. Queued operations re-check membership.
    this.children.delete(id);
    this.emit(id);
    try { await c.rpc.stop(); } catch (error) { console.error('Subagent process cleanup failed:', error); }
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.children.values()].map(async c => {
      this.clearReminder(c);
      try { this.cancelReminder?.(c.id); this.cancelNotices?.(c.id); } catch (error) { console.error('Subagent notice cancellation failed:', error); }
      c.cleanup?.(); c.cleanup = undefined;
      try { await c.rpc.stop(); } catch (error) { console.error('Subagent process cleanup failed:', error); }
    }));
    this.children.clear();
    this.listeners.clear();
  }

  subscribe(listener: (id: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private get(id: string): Child {
    const child = this.children.get(id);
    if (!child) throw new Error(`Unknown subagent ${JSON.stringify(sanitize(String(id)))}. Use list to find ids.`);
    return child;
  }
  private changed(id: string) {
    const child = this.children.get(id);
    // A discarded child must never reach observers.
    if (!child) return;
    // A provisional child is not published until its process exists.
    if (child.held) { child.dirty = true; return; }
    this.emit(id);
  }
  private emit(id: string) {
    for (const listener of [...this.listeners]) {
      try { listener(id); } catch (error) { console.error('Subagent observer failed:', error); }
    }
  }
  private failed(c: Child, error: unknown) {
    if (this.children.get(c.id) !== c || c.dead) return;
    c.dead = true;
    this.clearReminder(c);
    try { this.cancelReminder?.(c.id); } catch (error) { console.error('Subagent reminder cancellation failed:', error); }
    // A process exit after an already settled/stopped turn must not turn a
    // completed result into a second failed notice; the transcript stays readable.
    if (c.status === 'stopped' && !c.turnStarted) {
      c.cleanup?.(); c.cleanup = undefined;
      this.changed(c.id);
      return;
    }
    if (c.streaming) { c.interrupted = messageText(c.streaming); c.interruptedMessage = c.streaming; }
    if (c.turnStarted) { c.result = undefined; c.interrupted = undefined; c.interruptedMessage = undefined; }
    c.turnStarted = false;
    c.status = 'stopped'; c.error = String(error instanceof Error ? error.message : error); c.streaming = undefined;
    interruptTools(c, 'Child process/command failed before tool completed.');
    c.cleanup?.(); c.cleanup = undefined;
    this.changed(c.id);
    this.complete(c.id, 'failed');
  }
  /** A prompt rejected by a live child: stopped and retryable, never a process failure. */
  private refuse(c: Child, error: unknown) {
    if (this.children.get(c.id) !== c || c.dead) return;
    this.clearReminder(c);
    try { this.cancelReminder?.(c.id); } catch (error) { console.error('Subagent reminder cancellation failed:', error); }
    if (c.streaming) { c.interrupted = messageText(c.streaming); c.interruptedMessage = c.streaming; }
    c.turnStarted = false;
    c.status = 'stopped'; c.error = String(error instanceof Error ? error.message : error); c.streaming = undefined;
    c.cleanup?.(); c.cleanup = undefined;
    this.changed(c.id);
    this.complete(c.id, 'failed');
  }

  /** Attempt completion once, after launch, never for a discarded child. Delivery failures are logged, not retried. */
  private complete(id: string, outcome: Outcome) {
    if (this.closing) return;
    const child = this.children.get(id);
    // A discarded child never completes; a held one queues until launch.
    if (!child) return;
    if (child.held) { (child.pending ??= []).push(outcome); return; }
    try {
      this.notify(id, outcome);
    } catch (error) {
      // Delivery failure must not invalidate an otherwise running child.
      console.error('Subagent completion delivery failed:', error);
    }
  }

  private event(c: Child, e: RecordData) {
    if (this.children.get(c.id) !== c) return;
    switch (e.type) {
      case 'agent_start':
        c.turnStarted = false;
        c.status = 'active'; c.error = undefined; c.result = undefined;
        c.interrupted = undefined; c.interruptedMessage = undefined;
        if (c.reminder === undefined) {
          c.activeSince ??= Date.now();
          this.armReminder(c);
        }
        this.changed(c.id);
        break;
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
        c.turnStarted = false;
        this.clearReminder(c);
        try { this.cancelReminder?.(c.id); } catch (error) { console.error('Subagent reminder cancellation failed:', error); }
        const last = c.messages.findLast(m => m.role === 'assistant');
        c.result = messageText(last) || '(no assistant text)';
        const aborted = e.aborted === true;
        c.error = aborted ? undefined : last?.errorMessage ?? (last?.stopReason === 'error' ? 'Child provider failed.' : undefined);
        c.status = 'stopped';
        c.streaming = undefined;
        // Pi has already loaded the append prompt. Release its temp file at
        // settlement, including provider failures that bypass failed().
        c.cleanup?.(); c.cleanup = undefined;
        this.changed(c.id);
        if (!aborted) this.complete(c.id, c.error ? 'failed' : 'finished');
        return;
      }
    }
    this.changed(c.id);
  }

  private armReminder(c: Child) {
    if (this.reminderMs <= 0 || c.reminder !== undefined) return;
    c.reminder = setTimeout(() => {
      c.reminder = undefined;
      if (this.children.get(c.id) !== c || c.status !== 'active') return;
      const minutes = Math.max(1, Math.round((Date.now() - (c.activeSince ?? Date.now())) / 60_000));
      try { this.remind?.(c.id, minutes); } catch (error) { console.error('Subagent reminder delivery failed:', error); }
      if (this.children.get(c.id) === c && c.status === 'active') this.armReminder(c);
    }, this.reminderMs);
    c.reminder.unref?.();
  }

  private clearReminder(c: Child) {
    if (c.reminder !== undefined) clearTimeout(c.reminder);
    c.reminder = undefined;
    c.activeSince = undefined;
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
