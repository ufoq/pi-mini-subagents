import {
  AssistantMessageComponent, UserMessageComponent, ToolExecutionComponent,
  createReadToolDefinition, createBashToolDefinition, createEditToolDefinition, createWriteToolDefinition,
  createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition, createPowerShellToolDefinition,
  type ExtensionContext, type Theme, type ToolRenderers,
} from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { Container, Input, Text, ScrollView, matchesKey, Key, truncateToWidth, visibleWidth, type TUI } from '@earendil-works/pi-tui';
import { plain, sanitize, createSanitizer, Agents, messageText, type Snapshot, type ToolActivity } from './agents.ts';

function cleanValue(value: any): any {
  if (typeof value === 'string') return sanitize(value);
  if (Array.isArray(value)) return value.map(cleanValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [sanitize(key), cleanValue(item)]));
  return value;
}
function cleanContent(content: any, cleanText: (text: string) => string): any {
  if (typeof content === 'string') return cleanText(content);
  if (!Array.isArray(content)) return cleanValue(content);
  const copies = content.map(part => part && typeof part === 'object' ? { ...part } : part);
  const slots: Array<{ part: any; key: string }> = [];
  for (const part of copies) {
    if (!part || typeof part !== 'object') continue;
    for (const key of ['text', 'thinking']) if (typeof part[key] === 'string') slots.push({ part, key });
  }
  for (const slot of slots) slot.part[slot.key] = cleanText(slot.part[slot.key]);
  return copies.map(part => {
    if (!part || typeof part !== 'object') return part;
    const clean = { ...part };
    for (const [key, value] of Object.entries(part)) {
      if (key !== 'text' && key !== 'thinking') clean[key] = cleanValue(value);
    }
    return clean;
  });
}
function cleanMessage(message: any, cleanText: (text: string) => string): any {
  const clean = { ...message };
  if (clean.content !== undefined) clean.content = cleanContent(clean.content, cleanText);
  if (typeof clean.summary === 'string') clean.summary = sanitize(clean.summary);
  if (typeof clean.errorMessage === 'string') clean.errorMessage = sanitize(clean.errorMessage);
  if (typeof clean.toolName === 'string') clean.toolName = sanitize(clean.toolName);
  if (clean.details !== undefined) clean.details = cleanValue(clean.details);
  return clean;
}
function cleanResult(result: any, cleanText: (text: string) => string): any {
  if (!result) return result;
  const clean = { ...result };
  if (clean.content !== undefined) clean.content = cleanContent(clean.content, cleanText);
  for (const [key, value] of Object.entries(result)) {
    if (key !== 'content') clean[key] = cleanValue(value);
  }
  return clean;
}

/** Uses public Pi renderers; child text is sanitized before any renderer sees it. */
export class AgentViewer {
  private agents: Agents;
  private tui: TUI;
  private theme: Theme;
  private done: () => void;
  private cwd: string;
  private selected?: string;
  private cursor?: string;
  private input = new Input({ prompt: '> ', placeholder: 'Enter sends to this child' });
  private content = new Container();
  private scroll = new ScrollView(this.content, { follow: 'end', scrollbar: 'hidden' });
  private dirty = true;
  private snapshotCache?: { id: string; value: Snapshot };
  private unsubscribe: () => void;
  private status = '';
  private definitions: Record<string, ToolRenderers>;
  private _focused = false;

  constructor(agents: Agents, tui: TUI, theme: Theme, done: () => void, cwd: string, id?: string) {
    this.agents = agents; this.tui = tui; this.theme = theme; this.done = done; this.cwd = cwd;
    if (id && agents.list().some(c => c.id === id)) this.selected = id;
    this.definitions = Object.fromEntries([
      createReadToolDefinition(cwd), createBashToolDefinition(cwd), createEditToolDefinition(cwd), createWriteToolDefinition(cwd),
      createGrepToolDefinition(cwd), createFindToolDefinition(cwd), createLsToolDefinition(cwd), createPowerShellToolDefinition(cwd),
    ].map(d => [d.name, d]));
    this.unsubscribe = agents.subscribe(id => {
      if (!this.selected || this.selected === id) { this.dirty = true; this.snapshotCache = undefined; tui.requestRender(); }
    });
    this.input.onSubmit = message => {
      if (!this.selected || !message.trim()) return;
      if (this.mode() === 'stopped') { this.status = `${this.selected} is stopped; it cannot take more input.`; return; }
      const id = this.selected;
      this.input.setValue('');
      this.status = `Sending to ${id}…`;
      void agents.send(id, message).then(() => { this.status = `Input accepted by ${id}.`; }, error => { this.status = String(error); }).finally(() => tui.requestRender());
    };
    this.input.onEscape = () => this.back();
  }
  get focused() { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.input.focused = value && !!this.selected && this.mode() !== 'stopped'; }

  dispose() { this.unsubscribe(); }
  /** Newest child first, so a fresh spawn is at the top of the list. */
  private rows() { return [...this.agents.list()].reverse(); }
  /** The highlighted row is tracked by id, so inserts never move the cursor. */
  private listIndex(rows = this.rows()) {
    const found = this.cursor ? rows.findIndex(c => c.id === this.cursor) : -1;
    return found >= 0 ? found : 0;
  }
  /**
   * Intent plus the newest diagnostic. When the line is too narrow for both, the
   * intent shrinks to one word so the error stays readable.
   */
  private statusLine(mode: Mode, error: string | undefined, width: number) {
    const detail = [error ? sanitize(error).replace(/\s+/g, ' ') : '', sanitize(this.status).replace(/\s+/g, ' ')].filter(Boolean).join(' · ');
    const intent = !detail || visibleWidth(intentOf(mode)) + 3 + 6 <= width ? intentOf(mode) : shortIntentOf(mode);
    return [intent, detail].filter(Boolean).join(' · ');
  }
  /** Re-open the highlight after every reset truncation may have inserted. */
  private highlight(text: string) {
    return text.split(/(\x1b\[0m)/).map(part => part === '\x1b[0m' ? part : this.theme.bg('selectedBg', part)).join('');
  }
  private hint(width: number, tiers: string[]) {
    return this.theme.fg('dim', tiers.find(text => visibleWidth(text) <= width) ?? tiers.at(-1)!);
  }
  /** What Enter would do for the highlighted child right now; derived, never cached. */
  private mode(): Mode {
    return modeOf(this.selected ? this.agents.status(this.selected) : 'running');
  }
  invalidate() { this.dirty = true; this.snapshotCache = undefined; this.content.invalidate(); this.input.invalidate(); }
  private back() {
    if (this.selected) { this.selected = undefined; this.input.focused = false; this.status = ''; }
    else this.done();
    this.tui.requestRender();
  }

  handleInput(data: string) {
    if (matchesKey(data, Key.escape)) { this.back(); return; }
    if (!this.selected) {
      const rows = this.rows();
      const index = this.listIndex(rows);
      if (matchesKey(data, Key.up)) this.cursor = rows[Math.max(0, index - 1)]?.id;
      else if (matchesKey(data, Key.down)) this.cursor = rows[Math.min(rows.length - 1, index + 1)]?.id;
      else if (matchesKey(data, Key.enter) && rows[index]) {
        this.selected = rows[index].id; this.dirty = true; this.snapshotCache = undefined;
        this.input.focused = this.focused && this.mode() !== 'stopped'; this.scroll.scrollToEnd();
      }
    } else if (matchesKey(data, Key.pageUp)) this.scroll.scrollBy(-Math.max(1, this.scroll.viewportHeight - 1));
    else if (matchesKey(data, Key.pageDown)) this.scroll.scrollBy(Math.max(1, this.scroll.viewportHeight - 1));
    else if (matchesKey(data, Key.ctrl('y'))) this.scroll.scrollToEnd();
    else if (matchesKey(data, Key.ctrl('x'))) {
      const id = this.selected;
      this.status = `Stopping ${id}…`;
      void this.agents.stop(id).then(() => { this.status = `${id} stopped.`; }, error => { this.status = String(error); }).finally(() => this.tui.requestRender());
    } else if (this.mode() !== 'stopped') this.input.handleInput(data);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    // The overlay is capped at 90% of the terminal, so the body must fit that cap
    // minus the frame's two borders and two blank rows.
    const rows = Math.max(1, this.tui.terminal.rows);
    const cap = Math.max(1, Math.floor((rows * 9) / 10));
    // Framing must never push the title, hint, status or input line out of the
    // overlay: the conversation needs at least one row of its own.
    const framed = width >= 32 && cap >= (this.selected ? 9 : 7);
    const height = Math.max(1, cap - (framed ? 4 : 0));
    const inner = framed ? Math.max(1, width - 4) : width;
    const body = this.body(inner, height);
    if (body.length > height) body.length = height;
    if (!framed) return body;
    // A plain overlay composites as an unpadded block; this frame gives it edges and
    // breathing room, matching the bordered dialogs Pi itself renders.
    const bar = this.theme.fg('border', '│');
    const span = Math.max(1, width - 2);
    const blank = bar + ' '.repeat(width - 2) + bar;
    const row = (line: string) => {
      const text = truncateToWidth(line, inner);
      return bar + ' ' + text + ' '.repeat(Math.max(0, inner - visibleWidth(text))) + ' ' + bar;
    };
    return [
      this.theme.fg('border', `╭${'─'.repeat(span)}╮`),
      blank,
      ...body.map(row),
      blank,
      this.theme.fg('border', `╰${'─'.repeat(span)}╯`),
    ];
  }

  private body(width: number, height: number): string[] {
    const fit = (line: string) => truncateToWidth(line, width);
    const pad = (line: string) => { const text = fit(line); return text + ' '.repeat(Math.max(0, width - visibleWidth(text))); };
    if (!this.selected) {
      const rows = this.rows();
      const index = this.listIndex(rows);
      this.cursor = rows[index]?.id;
      // Reserve the title and, when it fits, the hint, so a row is always reachable.
      const showHint = height >= 3;
      const visible = Math.max(0, height - 1 - (showHint ? 1 : 0));
      const start = Math.max(0, index - visible + 1);
      return [this.theme.bold(this.theme.fg('accent', `Subagents — existing conversations${rows.length ? ` (${rows.length})` : ''}`)),
        ...(rows.length ? rows.slice(start, start + visible).map((c, i) => {
          const row = start + i === index;
          const line = `${row ? '> ' : '  '}${c.id} ${c.status}: ${c.task}`;
          return row ? this.highlight(pad(line)) : pad(line);
        }) : ['No children. Ask the parent to use subagent spawn.']),
        ...(showHint ? [this.hint(width, ['↑↓ select · Enter open · Esc close (children keep running)', '↑↓ select · Enter open · Esc close', '↑↓ · Enter · Esc'])] : []),
      ].map(fit);
    }
    if (this.snapshotCache?.id !== this.selected) this.snapshotCache = { id: this.selected, value: this.agents.snapshot(this.selected) };
    const snapshot = this.snapshotCache.value;
    if (this.dirty) {
      this.rebuild(snapshot); this.dirty = false;
    }
    // ScrollView's public state helpers supply follow/end and bounded scrolling.
    // A custom overlay's render() owns the viewport, so clip its rendered lines here.
    // Reserve title, hint and input first; the hint and status line are the only
    // things that may be dropped when the terminal is extremely short.
    const mode = modeOf(snapshot.status);
    this.input.focused = this.focused && mode !== 'stopped';
    const showStatus = height >= 3;
    const showHint = height >= 5;
    const viewport = Math.max(0, height - 2 - (showHint ? 1 : 0) - (showStatus ? 1 : 0));
    // Below the status line's threshold the composer carries a one-word state tag.
    const compact = width >= 16 && height > 1 && !showStatus ? `${tagOf(mode)} ` : '';
    // Render Input at its own width so its scrolling and cursor marker stay correct.
    const composer = this.input.render(Math.max(1, width - visibleWidth(compact))).map((line: string) => fit(compact + line));
    // A one-row terminal can only show one thing; the composer is the actionable one.
    if (height === 1) return composer;
    const lines = this.scroll.render(width);
    this.scroll.updateLayout(lines.length, Math.max(1, viewport), () => this.tui.requestRender());
    return [
      fit(this.theme.bold(this.theme.fg('accent', `${snapshot.id} ${snapshot.status} — ${plain(snapshot.task)}`))),
      ...lines.slice(this.scroll.scrollTop, this.scroll.scrollTop + viewport).map(fit),
      ...(showHint ? [fit(this.hint(width, ['PgUp/PgDn scroll · Ctrl+Y live · Ctrl+X stop · Esc list', 'PgUp/PgDn · Ctrl+Y · Ctrl+X · Esc', 'Ctrl+X stop · Esc']))] : []),
      ...(showStatus ? [fit(this.statusLine(mode, snapshot.error, width))] : []),
      ...composer,
    ];
  }

  private rebuild(snapshot: Snapshot) {
    this.content.clear();
    const shownActivities = new Set<ToolActivity>();
    const cleanText = createSanitizer();
    const messages = snapshot.messages.map(message => cleanMessage(message, cleanText));
    const streaming = snapshot.streaming ? cleanMessage(snapshot.streaming, cleanText) : undefined;
    const resultsById = new Map<string, any[]>();
    for (const message of messages) {
      if (message.role !== 'toolResult') continue;
      const id = String(message.toolCallId);
      resultsById.set(id, [...(resultsById.get(id) ?? []), message]);
    }
    const totalCalls = new Map<string, number>();
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      for (const call of message.content ?? []) {
        if (call.type !== 'toolCall') continue;
        const id = String(call.id);
        totalCalls.set(id, (totalCalls.get(id) ?? 0) + 1);
      }
    }
    const seenCalls = new Map<string, number>();
    const toolComponent = (rawName: string, id: string, args: any) => {
      const name = sanitize(rawName);
      const tool = new ToolExecutionComponent(name, id, cleanValue(args), { showImages: false }, this.definitions[rawName] ?? this.definitions[name], this.tui, this.cwd);
      // Observer snapshots do not own execution clocks. Marking execution started
      // would start native renderer timers with no public disposal hook on close.
      // The edit renderer rereads the file on args-complete, outside our sanitization.
      if (rawName !== 'edit' && name !== 'edit') tool.setArgsComplete();
      tool.setExpanded(true);
      return tool;
    };
    const showCall = (call: any) => {
      const id = String(call.id);
      const occurrence = seenCalls.get(id) ?? 0;
      seenCalls.set(id, occurrence + 1);
      const tool = toolComponent(String(call.name), id, call.arguments);
      const fromMessages = resultsById.get(id)?.[occurrence];
      const latest = occurrence === (totalCalls.get(id) ?? 1) - 1;
      const activity = latest ? snapshot.tools[id] : undefined;
      const current = fromMessages ? undefined : activity;
      const result = fromMessages ?? (current?.result ? cleanResult(current.result, cleanText) : undefined);
      if (result) tool.updateResult({ ...result, content: result.content ?? [], isError: result.isError ?? current?.isError ?? false }, current?.running ?? false);
      if (current) shownActivities.add(current);
      this.content.addChild(tool);
    };
    const showActivity = (activity: ToolActivity) => {
      if (shownActivities.has(activity)) return;
      const hasCall = (seenCalls.get(activity.id) ?? 0) > 0;
      if (activity.reported && hasCall) return;
      const tool = toolComponent(String(activity.name), activity.id, activity.args);
      const fromMessages = hasCall ? undefined : resultsById.get(activity.id)?.at(-1);
      const raw = fromMessages ? undefined : activity.result;
      const result = fromMessages ?? (raw ? cleanResult(raw, cleanText) : undefined);
      if (result) tool.updateResult({ ...result, content: result.content ?? [], isError: result.isError ?? activity.isError ?? false }, activity.running);
      shownActivities.add(activity);
      this.content.addChild(tool);
    };
    const interrupted = snapshot.interrupted === undefined ? [] : [{
      role: 'assistant', content: [{ type: 'text', text: cleanText(snapshot.interrupted) }], timestamp: 0, stopReason: 'aborted',
    } as unknown as AssistantMessage];
    for (const message of [...messages, ...interrupted, ...(streaming ? [streaming] : [])]) {
      if (message.role === 'user') this.content.addChild(new UserMessageComponent(messageText(message)));
      else if (message.role === 'assistant') {
        const assistant = new AssistantMessageComponent(message as AssistantMessage, false);
        if (message === streaming) assistant.updateContent(message as AssistantMessage, true);
        this.content.addChild(assistant);
        for (const call of message.content ?? []) {
          if (call.type !== 'toolCall') continue;
          if (call.partialArguments) this.content.addChild(new Text(`${sanitize(String(call.name))} (preparing arguments)`, 0, 0));
          else showCall(call);
        }
      } else if (message.role !== 'toolResult' && message.role !== 'system') {
        this.content.addChild(new Text(messageText(message) || message.summary || `[${sanitize(String(message.role))}]`, 0, 0));
      }
    }
    // Executions can start before a finalized assistant/tool-result message.
    for (const activity of Object.values(snapshot.tools)) showActivity(activity);
  }
}

type Mode = 'steer' | 'message' | 'stopped';
function modeOf(status: string): Mode {
  return status === 'stopped' ? 'stopped' : status === 'starting' || status === 'running' ? 'steer' : 'message';
}
const tagOf = (mode: Mode) => mode === 'steer' ? 'live' : mode === 'message' ? 'idle' : 'stopped';
const intentOf = (mode: Mode) => mode === 'steer' ? 'Enter→steer' : mode === 'message' ? 'Enter→new turn' : 'Stopped';
/** A narrower intent, so a diagnostic keeps most of a short line. */
const shortIntentOf = (mode: Mode) => mode === 'steer' ? 'steer' : mode === 'message' ? 'turn' : 'stopped';

export async function openViewer(agents: Agents, ctx: ExtensionContext, id?: string) {
  if (ctx.mode !== 'tui') return;
  await ctx.ui.custom<void>((tui, theme, _keys, done) => new AgentViewer(agents, tui, theme, () => done(), ctx.cwd, id),
    { overlay: true, overlayOptions: { width: '95%', maxHeight: '90%', anchor: 'center' } });
}
