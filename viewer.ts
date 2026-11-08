import {
  AssistantMessageComponent, UserMessageComponent, ToolExecutionComponent,
  createReadToolDefinition, createBashToolDefinition, createEditToolDefinition, createWriteToolDefinition,
  type ExtensionContext, type Theme, type ToolRenderers,
} from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { Container, Input, Text, ScrollView, matchesKey, Key, truncateToWidth, visibleWidth, type TUI } from '@earendil-works/pi-tui';
import { plain, Agents, messageText, type Snapshot, type ToolActivity } from './agents.ts';

/** Uses public Pi renderers; no child transcript enters parent context. */
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
    ].map(d => [d.name, d]));
    this.unsubscribe = agents.subscribe(id => {
      if (!this.selected || this.selected === id) { this.dirty = true; this.snapshotCache = undefined; tui.requestRender(); }
    });
    this.input.onSubmit = message => {
      if (!this.selected || !message.trim()) return;
      if (this.mode() === 'stopped' || this.mode() === 'failed') { this.status = `${this.selected} cannot take more input.`; return; }
      const id = this.selected;
      this.input.setValue('');
      this.status = `Sending to ${id}…`;
      void agents.send(id, message).then(() => { this.status = `Input accepted by ${id}.`; }, error => { this.status = String(error); }).finally(() => tui.requestRender());
    };
    this.input.onEscape = () => this.back();
  }
  get focused() { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.input.focused = value && !!this.selected && ['stopped', 'failed'].includes(this.mode()) === false; }

  dispose() { this.unsubscribe(); }
  /** Newest child first, so a fresh spawn is at the top of the list. */
  private rows() { return [...this.agents.list()].reverse(); }
  /** The highlighted row is tracked by id, so inserts never move the cursor. */
  private listIndex(rows = this.rows()) {
    const found = this.cursor ? rows.findIndex(c => c.id === this.cursor) : -1;
    return found >= 0 ? found : 0;
  }
  /** Re-open the highlight after every reset truncation may have inserted. */
  private highlight(text: string) {
    return text.split(/(\x1b\[0m)/).map(part => part === '\x1b[0m' ? part : this.theme.bg('selectedBg', part)).join('');
  }
  /** States what Enter does, so a finished child is not mistaken for a live steer. */
  private guidance(mode = this.mode()) {
    return mode === 'steer' ? 'Enter sends to this child now; it may finish first.'
      : mode === 'message' ? 'Enter starts a new turn in this conversation.'
        : mode === 'failed' ? 'This child failed; Esc returns to the list.'
          : 'Stopped; Esc returns to the list.';
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
        this.input.focused = this.focused && !['stopped', 'failed'].includes(this.mode()); this.scroll.scrollToEnd();
      }
    } else if (matchesKey(data, Key.pageUp)) this.scroll.scrollBy(-Math.max(1, this.scroll.viewportHeight - 1));
    else if (matchesKey(data, Key.pageDown)) this.scroll.scrollBy(Math.max(1, this.scroll.viewportHeight - 1));
    else if (matchesKey(data, Key.ctrl('y'))) this.scroll.scrollToEnd();
    else if (matchesKey(data, Key.ctrl('x'))) {
      const id = this.selected;
      this.status = `Stopping ${id}…`;
      void this.agents.stop(id).then(() => { this.status = `${id} stopped.`; }, error => { this.status = String(error); }).finally(() => this.tui.requestRender());
    } else if (!['stopped', 'failed'].includes(this.mode())) this.input.handleInput(data);
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
    this.input.focused = this.focused && mode !== 'stopped' && mode !== 'failed';
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
      ...(showStatus ? [fit([intentOf(mode), snapshot.error || this.status].filter(Boolean).join(' · '))] : []),
      ...composer,
    ];
  }

  private rebuild(snapshot: Snapshot) {
    this.content.clear();
    const shownTools = new Set<string>();
    const results = new Map(snapshot.messages.filter(m => m.role === 'toolResult').map(m => [m.toolCallId, m]));
    const showTool = (activity: ToolActivity) => {
      if (shownTools.has(activity.id)) return;
      shownTools.add(activity.id);
      const tool = new ToolExecutionComponent(activity.name, activity.id, activity.args, { showImages: false }, this.definitions[activity.name], this.tui, this.cwd);
      // Observer snapshots do not own execution clocks. Marking execution started
      // would start native renderer timers with no public disposal hook on close.
      tool.setArgsComplete(); tool.setExpanded(true);
      const result = results.get(activity.id) ?? activity.result;
      if (result) tool.updateResult({ ...result, content: result.content ?? [], isError: result.isError ?? activity.isError ?? false }, activity.running);
      this.content.addChild(tool);
    };
    for (const message of [...snapshot.messages, ...(snapshot.streaming ? [snapshot.streaming] : [])]) {
      if (message.role === 'user') this.content.addChild(new UserMessageComponent(messageText(message)));
      else if (message.role === 'assistant') {
        const assistant = new AssistantMessageComponent(message as AssistantMessage, false);
        if (message === snapshot.streaming) assistant.updateContent(message as AssistantMessage, true);
        this.content.addChild(assistant);
        for (const call of message.content ?? []) {
          if (call.type !== 'toolCall') continue;
          if (call.partialArguments) this.content.addChild(new Text(`${call.name} ${call.partialArguments}`, 0, 0));
          else showTool(snapshot.tools[call.id] ?? { id: call.id, name: call.name, args: call.arguments, running: !results.has(call.id) });
        }
      } else if (message.role !== 'toolResult' && message.role !== 'system') {
        this.content.addChild(new Text(messageText(message) || message.summary || `[${message.role}]`, 0, 0));
      }
    }
    // Executions can start before a finalized assistant/tool-result message.
    for (const activity of Object.values(snapshot.tools)) showTool(activity);
  }
}

type Mode = 'steer' | 'message' | 'stopped' | 'failed';
function modeOf(status: string): Mode {
  if (status === 'stopped' || status === 'failed') return status;
  return status === 'starting' || status === 'running' ? 'steer' : 'message';
}
const tagOf = (mode: Mode) => mode === 'steer' ? 'live' : mode === 'message' ? 'idle' : mode === 'failed' ? 'failed' : 'stopped';
const intentOf = (mode: Mode) => mode === 'steer' ? 'Enter→steer' : mode === 'message' ? 'Enter→new turn' : mode === 'failed' ? 'Child failed' : 'Stopped';

export async function openViewer(agents: Agents, ctx: ExtensionContext, id?: string) {
  if (ctx.mode !== 'tui') return;
  await ctx.ui.custom<void>((tui, theme, _keys, done) => new AgentViewer(agents, tui, theme, () => done(), ctx.cwd, id),
    { overlay: true, overlayOptions: { width: '95%', maxHeight: '90%', anchor: 'center' } });
}
