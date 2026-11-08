import {
  AssistantMessageComponent, UserMessageComponent, ToolExecutionComponent,
  createReadToolDefinition, createBashToolDefinition, createEditToolDefinition, createWriteToolDefinition,
  type ExtensionContext, type Theme, type ToolRenderers,
} from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { Container, Input, Text, ScrollView, matchesKey, Key, truncateToWidth, visibleWidth, type TUI } from '@earendil-works/pi-tui';
import { Agents, messageText, type Snapshot, type ToolActivity } from './agents.ts';

/** Uses public Pi renderers; no child transcript enters parent context. */
export class AgentViewer {
  private agents: Agents;
  private tui: TUI;
  private theme: Theme;
  private done: () => void;
  private cwd: string;
  private selected?: string;
  private index = 0;
  private input = new Input({ prompt: 'Steer> ', placeholder: 'Enter sends to this child' });
  private content = new Container();
  private scroll = new ScrollView(this.content, { follow: 'end', scrollbar: 'hidden' });
  private dirty = true;
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
      if (!this.selected || this.selected === id) { this.dirty = true; tui.requestRender(); }
    });
    this.input.onSubmit = message => {
      if (!this.selected || !message.trim()) return;
      const id = this.selected;
      this.input.setValue('');
      this.status = `Sending to ${id}…`;
      void agents.send(id, message).then(() => { this.status = `Input accepted by ${id}.`; }, error => { this.status = String(error); }).finally(() => tui.requestRender());
    };
    this.input.onEscape = () => this.back();
  }
  get focused() { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.input.focused = value && !!this.selected; }

  dispose() { this.unsubscribe(); }
  /** Newest child first, so a fresh spawn is at the top of the list. */
  private rows() { return [...this.agents.list()].reverse(); }
  invalidate() { this.dirty = true; this.content.invalidate(); this.input.invalidate(); }
  private back() {
    if (this.selected) { this.selected = undefined; this.input.focused = false; this.status = ''; }
    else this.done();
    this.tui.requestRender();
  }

  handleInput(data: string) {
    if (matchesKey(data, Key.escape)) { this.back(); return; }
    if (!this.selected) {
      const rows = this.rows();
      if (matchesKey(data, Key.up)) this.index = Math.max(0, this.index - 1);
      else if (matchesKey(data, Key.down)) this.index = Math.min(rows.length - 1, this.index + 1);
      else if (matchesKey(data, Key.enter) && rows[this.index]) {
        this.selected = rows[this.index].id; this.dirty = true; this.input.focused = this.focused; this.scroll.scrollToEnd();
      }
    } else if (matchesKey(data, Key.pageUp)) this.scroll.scrollBy(-Math.max(1, this.scroll.viewportHeight - 1));
    else if (matchesKey(data, Key.pageDown)) this.scroll.scrollBy(Math.max(1, this.scroll.viewportHeight - 1));
    else if (matchesKey(data, Key.ctrl('y'))) this.scroll.scrollToEnd();
    else if (matchesKey(data, Key.ctrl('x'))) {
      const id = this.selected;
      this.status = `Stopping ${id}…`;
      void this.agents.stop(id).then(() => { this.status = `${id} stopped.`; }, error => { this.status = String(error); }).finally(() => this.tui.requestRender());
    } else this.input.handleInput(data);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    // Room for the overlay's own margins plus a one-cell border and padding.
    const framed = width >= 32;
    const height = Math.max(3, this.tui.terminal.rows - 6 - (framed ? 4 : 0));
    const inner = framed ? Math.max(1, width - 4) : width;
    const body = this.body(inner, height);
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
      this.index = Math.max(0, Math.min(this.index, rows.length - 1));
      const start = Math.max(0, this.index - height + 3);
      return [this.theme.bold(this.theme.fg('accent', `Subagents — existing conversations${rows.length ? ` (${rows.length})` : ''}`)),
        ...(rows.length ? rows.slice(start, start + height - 2).map((c, i) => {
          const line = `${start + i === this.index ? '> ' : '  '}${c.id} ${c.status}: ${c.task}`;
          return start + i === this.index ? this.theme.bg('selectedBg', pad(line)) : pad(line);
        }) : ['No children. Ask the parent to use subagent spawn.']),
        this.theme.fg('dim', '↑↓ select · Enter open · Esc close (children keep running)'),
      ].map(fit);
    }
    const snapshot = this.agents.snapshot(this.selected);
    if (this.dirty) {
      this.rebuild(snapshot); this.dirty = false;
    }
    // ScrollView's public state helpers supply follow/end and bounded scrolling.
    // A custom overlay's render() owns the viewport, so clip its rendered lines here.
    const lines = this.scroll.render(width);
    const viewport = Math.max(1, height - 4);
    this.scroll.updateLayout(lines.length, viewport, () => this.tui.requestRender());
    return [
      fit(this.theme.bold(this.theme.fg('accent', `${snapshot.id} ${snapshot.status} — ${snapshot.task.replace(/\s+/g, ' ')}`))),
      ...lines.slice(this.scroll.scrollTop, this.scroll.scrollTop + viewport).map(fit),
      fit(this.theme.fg('dim', 'PgUp/PgDn scroll · Ctrl+Y live · Ctrl+X stop · Esc list')),
      fit(this.status || snapshot.error || ''),
      ...this.input.render(width).map(fit),
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

export async function openViewer(agents: Agents, ctx: ExtensionContext, id?: string) {
  if (ctx.mode !== 'tui') return;
  await ctx.ui.custom<void>((tui, theme, _keys, done) => new AgentViewer(agents, tui, theme, () => done(), ctx.cwd, id),
    { overlay: true, overlayOptions: { width: '95%', maxHeight: '90%', anchor: 'center' } });
}
