import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { Agents, childInvocation, type Status } from './agents.ts';

export function completionNotification(id: string, status: Status) {
  return `<system-notification>\nSubagent ${id} ${status}. Result/diagnostic available; use subagent read when needed.\n</system-notification>`;
}

/** "provider/model" (model ids may contain slashes); undefined keeps the parent model. */
export function parseModel(spec?: string): { provider: string; id: string } | undefined {
  if (spec === undefined) return undefined;
  // Control characters (notably NUL) cannot be passed to a subprocess argv.
  if (/[\u0000-\u001f\u007f]/.test(spec)) throw new Error('model must not contain control characters.');
  const match = /^([^/\s]+)\/(\S.*)$/.exec(spec.trim());
  if (!match) throw new Error('model must be "provider/model", for example "anthropic/claude-sonnet-4-5".');
  return { provider: match[1], id: match[2].trim() };
}

export default function (pi: ExtensionAPI) {
  let agents: Agents | undefined;
  const registry = () => agents ??= new Agents((id, status) => {
    pi.sendMessage({ customType: 'mini-subagent-completion', content: completionNotification(id, status), display: true },
      { triggerTurn: true, deliverAs: 'followUp' });
  });

  pi.on('session_start', () => { registry(); });
  pi.on('session_shutdown', async () => {
    if (agents) await agents.shutdown();
    // Session replacement owns a fresh registry, never the old handles.
    agents = undefined;
  });

  pi.registerTool({
    name: 'subagent', label: 'Subagent',
    description: 'Persistent background Pi children in this cwd. spawn: task in message, optional model "provider/model" (default: parent model); list; read: latest result/error or recent activity; send: steer/follow up in the same conversation; stop: terminate. Completion notifies without results. Put restrictions/file ownership in task prompts, not enforced here.',
    parameters: Type.Object({
      action: StringEnum(['spawn', 'list', 'read', 'send', 'stop'] as const),
      id: Type.Optional(Type.String()),
      message: Type.Optional(Type.String()),
      model: Type.Optional(Type.String({ description: '"provider/model" for this child; defaults to the parent model.' })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const a = registry();
      let text: string;
      if (params.action === 'spawn') {
        const model = parseModel(params.model) ?? ctx.model;
        const id = a.spawn(params.message ?? '', childInvocation(ctx.cwd, model, ctx.thinkingLevel));
        text = `${id} starting. Parent may continue; completion will notify. Results require read.`;
      } else if (params.action === 'list') {
        text = a.list().map(c => `${c.id} ${c.status}: ${c.task}`).join('\n') || 'No subagents.';
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
