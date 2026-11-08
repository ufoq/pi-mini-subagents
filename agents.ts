import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { RpcProcess, type Invocation, type RecordData } from './rpc.ts';

export type Status = 'starting' | 'running' | 'finished' | 'failed' | 'stopped';
export interface ToolActivity {
  id: string; name: string; args: RecordData; result?: RecordData; running: boolean; isError?: boolean;
}
export interface Snapshot {
  id: string; task: string; status: Status; sessionId?: string;
  messages: RecordData[]; streaming?: RecordData; tools: Record<string, ToolActivity>;
  result?: string; error?: string;
}
interface Child extends Snapshot { rpc: RpcProcess; ready: Promise<void>; held?: boolean; dirty?: boolean; pending?: Status[] }
type ProcessFactory = (spec: Invocation, event: (e: RecordData) => void, failure: (e: Error) => void) => RpcProcess;

export function childInvocation(cwd: string, model?: { provider: string; id: string }, thinking?: string): Invocation {
  const args = ['--mode', 'rpc', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--tools', 'read,bash,edit,write'];
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
  return (message.content ?? []).map((c: RecordData) => c.type === 'text' ? c.text : c.type === 'toolCall' ? `${c.name} ${JSON.stringify(c.arguments)}` : '').filter(Boolean).join('\n');
}
/** One line with no terminal escapes or control characters. */
export function plain(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
/** A plain label, additionally bounded to 100 code points for model replies. */
export function label(text: string): string {
  return [...plain(text)].slice(0, 100).join('');
}
const bounded = (text: string) => text.length <= 8000 ? text : text.slice(0, 8000) + '\n[truncated; full conversation in /agents]';
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
      throw new Error(`Could not start ${id}: ${error instanceof Error ? error.message : String(error)}`);
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
    const header = `${id} ${c.status}`;
    if (c.status !== 'running' && c.status !== 'starting') return bounded(`${header}\n${[c.error, c.result].filter(Boolean).join('\n') || '(no assistant result)'}`);
    const tools = Object.values(c.tools).filter(t => t.running).map(t => `${t.name} ${JSON.stringify(t.args)}\n${messageText(t.result)}`).join('\n');
    return bounded(`${header}\n${c.messages.slice(-4).map(messageText).join('\n')}\n${messageText(c.streaming)}\n${tools}`);
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
      throw error;
    }
  }

  async stop(id: string): Promise<void> {
    const c = this.get(id);
    c.status = 'stopped'; c.streaming = undefined;
    interruptTools(c, 'Stopped before tool completed.');
    this.changed(id);
    await c.rpc.stop();
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
    if (!child) throw new Error(`Unknown subagent ${JSON.stringify(id)}. Use list to find ids.`);
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
    tool.running = false; tool.isError = true;
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
