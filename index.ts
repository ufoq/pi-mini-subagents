import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { Agents, childInvocation, sanitize, type Status } from './agents.ts';
import { composeSystemAppend, discoverPresets, findPreset, parseModel, parseThinking, parseTools, presetsReply, unknownPreset } from './presets.ts';

export { parseModel } from './presets.ts';

export interface CompletionNotice { id: string; status: Status }

/** One notice for a burst of completions; delivery still happens at the next message boundary. */
export function completionNotification(notices: CompletionNotice[]) {
  const lines = notices.map(({ id, status }) => `Subagent ${id} ${status}. Result/diagnostic available; use subagent read when needed.`);
  lines.push('Settled children stay in memory; subagent stop releases any live child process.');
  return `<system-notification>\n${lines.join('\n')}\n</system-notification>`;
}

export function sendCompletionNotices(pi: Pick<ExtensionAPI, 'sendMessage'>, notices: CompletionNotice[]) {
  return pi.sendMessage(
    { customType: 'mini-subagent-completion', content: completionNotification(notices), display: true },
    { triggerTurn: true, deliverAs: 'steer' },
  );
}

/**
 * Coalesce completions into one notification per message boundary.
 * While the parent is busy, notices wait for the next turn, run or compaction
 * boundary; when idle they wake it after a short window so a burst of child
 * completions is still one message.
 */
export function createCompletionNotifier(send: (notices: CompletionNotice[]) => void, delayMs = 100) {
  let pending: CompletionNotice[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  const flush = () => {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    if (!pending.length) return;
    const notices = pending;
    pending = [];
    send(notices);
  };
  return {
    add(id: string, status: Status) {
      pending.push({ id, status });
      if (busy || timer !== undefined) return;
      timer = setTimeout(flush, delayMs);
      timer.unref?.();
    },
    startRun() {
      busy = true;
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      // A retry or continuation is a fresh boundary: the initial steering poll
      // runs after agent_start, so held notices join its first request.
      flush();
    },
    boundary: flush,
    // agent_end is only a low-level run boundary; retries and compaction can
    // follow it. Hold idle batching until the session actually settles.
    endRun: flush,
    settled() { busy = false; flush(); },
    clear() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined; pending = []; busy = false;
    },
  };
}

export function startingReply(id: string, model?: { provider: string; id: string }, preset?: string) {
  return `${id} starting${preset ? ` (${sanitize(preset)})` : ''}${model ? ` on ${sanitize(model.provider)}/${sanitize(model.id)}` : ''}. Parent may continue; completion will notify. Results require read.`;
}

export function listReply(rows: { id: string; status: Status; task: string; preset?: string }[]) {
  const lines = rows.map(c => `${c.id} ${c.status}${c.preset ? ` (${sanitize(c.preset)})` : ''}: ${c.task}`);
  if (rows.some(c => c.status === 'finished' || c.status === 'failed')) {
    lines.push('Settled children retain memory; subagent stop releases any live child process.');
  }
  return lines.join('\n') || 'No subagents.';
}

export default function (pi: ExtensionAPI) {
  let agents: Agents | undefined;
  const notices = createCompletionNotifier((batch) => {
    try {
      void Promise.resolve(sendCompletionNotices(pi, batch))
        .catch(error => console.error('Subagent completion delivery failed:', error));
    } catch (error) {
      console.error('Subagent completion delivery failed:', error);
    }
  });
  const registry = () => agents ??= new Agents((id, status) => notices.add(id, status));

  pi.on('session_start', () => { registry(); });
  pi.on('agent_start', () => notices.startRun());
  pi.on('turn_end', () => notices.boundary());
  pi.on('agent_end', () => notices.endRun());
  pi.on('agent_settled', () => notices.settled());
  // Compaction can run between turns; Pi polls steering after it, so flush
  // held notices here to reach the upcoming request instead of the next turn.
  pi.on('session_compact', () => notices.boundary());
  pi.on('session_compact_failed', () => notices.boundary());
  pi.on('session_shutdown', async () => {
    notices.clear();
    if (agents) await agents.shutdown();
    // Session replacement owns a fresh registry, never the old handles.
    agents = undefined;
  });

  pi.registerTool({
    name: 'subagent', label: 'Subagent',
    description: 'Persistent background Pi children in this cwd. spawn: task in message; optional preset supplies launch defaults; model/thinking/tools override them. presets: list user/trusted-project presets. list; read: result/error or attributed recent activity; send: steer/follow up in the same conversation; stop: terminate. Completion notifies without results. Put restrictions/file ownership in task prompts, not enforced here.',
    parameters: Type.Object({
      action: StringEnum(['spawn', 'list', 'read', 'send', 'stop', 'presets'] as const),
      id: Type.Optional(Type.String()),
      message: Type.Optional(Type.String()),
      model: Type.Optional(Type.String({ description: '"provider/model" for this child; defaults to the parent model.' })),
      preset: Type.Optional(Type.String()),
      thinking: Type.Optional(Type.String()),
      tools: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const a = registry();
        let text: string;
        if (params.action === 'spawn') {
          if (!params.message?.trim()) throw new Error('A non-empty message is required.');
          const trusted = ctx.isProjectTrusted?.() ?? false;
          const discovery = discoverPresets({ cwd: ctx.cwd, trusted });
          const preset = params.preset === undefined ? undefined : findPreset(params.preset, discovery);
          if (params.preset !== undefined && !preset) throw new Error(unknownPreset(params.preset, discovery));
          const model = parseModel(params.model) ?? preset?.model ?? ctx.model;
          const thinking = parseThinking(params.thinking) ?? preset?.thinking ?? ctx.thinkingLevel;
          const tools = parseTools(params.tools) ?? preset?.tools;
          const systemAppend = preset ? composeSystemAppend(ctx.cwd, trusted, preset.systemAppend) : undefined;
          const id = a.spawn(params.message, childInvocation(ctx.cwd, model ?? undefined, thinking, {
            tools,
            systemAppend,
          }), preset?.name);
          text = startingReply(id, model ?? undefined, preset?.name);
        } else if (params.action === 'presets') {
          const trusted = ctx.isProjectTrusted?.() ?? false;
          text = presetsReply(discoverPresets({ cwd: ctx.cwd, trusted }));
        } else if (params.action === 'list') {
          text = listReply(a.list());
        } else {
          if (!params.id) throw new Error(`id is required for ${params.action}.`);
          switch (params.action) {
            case 'read': text = a.read(params.id); break;
            case 'send': await a.send(params.id, params.message ?? ''); text = `${params.id}: input accepted in the same conversation.`; break;
            case 'stop': await a.stop(params.id); text = `${params.id} stopped.`; break;
            default: throw new Error('Unknown subagent action.');
          }
        }
        return { content: [{ type: 'text', text }], details: undefined };
      } catch (error) {
        throw new Error(sanitize(error instanceof Error ? error.message : String(error)));
      }
    },
  });

  pi.registerCommand('agents', {
    description: 'Observe and steer existing subagents (TUI only)',
    handler: async (args, ctx) => {
      if (ctx.mode !== 'tui') {
        ctx.ui.notify('/agents requires native TUI. Use the subagent tool in RPC mode.', 'info');
        return;
      }
      const { openViewer } = await import('./viewer.ts');
      await openViewer(registry(), ctx, args.trim() || undefined);
    },
  });
}
