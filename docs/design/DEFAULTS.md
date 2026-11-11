# Simple v1 decisions

Updated: 2026-11-02
Status: user-directed minimal scope; supersedes the earlier OmO/OMP-derived
policy defaults. The first slice is now implemented; see
[../VERIFICATION.md](../VERIFICATION.md) for tested behavior and limitations.

Implementation plan: [PLAN.md](PLAN.md). Source lives in the standalone
`pi-mini-subagents` repository, developed in its own dedicated environment.
Earlier shared-blueprint placement is superseded; do not modify other projects
or a shared blueprint.

## Keep

| Area | Decision |
| --- | --- |
| Project identity | Repository project: `pi-mini-subagents`; npm package: `@ufoq/pi-mini-subagents`. Canonical upstream: `https://github.com/ufoq/pi-mini-subagents`; local Git server is the development copy. |
| Packaging | Our own Pi extension, shared by exclusive native TUI and RPC parent modes. |
| Workers | Persistent Pi RPC subprocesses. Launch returns an id immediately (`j1-<base36 ms>`); parent keeps working. |
| State | One plain in-memory registry of child handles and conversation/progress data. No custom state/result directories or daemon. |
| Initial context | Fresh conversation plus the parent's task brief; parent model/thinking by default, with optional per-spawn `model`, `thinking` and `tools` overrides. No transcript fork. |
| Tools and permissions | Ordinary coding tools. Parent states allowed actions, read-only intent, file ownership, etc. in the task prompt. No permission profiles or enforcement machinery. Prompt restrictions are instructions, not a sandbox. |
| Resources | Children inherit the parent's tools, skills, templates and themes, but not its extensions. Extensions stay off, which also excludes MCP (implemented as a built-in extension) and our `subagent` tool, so a child cannot delegate. |
| Presets | Optional user-defined Markdown presets under `~/.pi/agent/subagent-presets/` or a trusted project's `.pi/subagent-presets/`. A preset supplies launch defaults for `model`, `thinking`, `tools` and a preset-only `system_append`; explicit spawn args override matching fields. Preset append is added after the normal `APPEND_SYSTEM.md`. Project trust follows Pi's `isProjectTrusted()` result; the extension adds no second rule. No built-in presets, preset editor, inheritance or auto-routing. Preset tool allowlists are launch configuration, not a sandbox. |
| Workspace | Same working directory. Parent coordinates assignments in prompts; no writer locks or automatic worktrees. |
| Steering/follow-up | Send input to the same child using Pi's native prompt/steering behavior. A natural settle or explicit stop leaves the child `stopped` but resumable; only `remove` destroys it. |
| Observation | Child list, existing messages/tool activity, then live events. Agent and human controls use the same registry. Human viewing adds nothing to parent model context. |
| Completion | Send only a concise `<system-notification>` that the child finished and its result is available. Include the child id, not the result body. Busy-parent notices are coalesced and delivered at the next message boundary with `steer`; an idle parent is woken after a short burst window. A child that stays `active` for 10 minutes emits a notification-only reminder every 10 minutes until it settles or is stopped. Parent retrieves results when needed. |
| Stop / remove | `stop` aborts the current turn with `clear_queue` + `abort`, keeps the process and partial answer, and is resumable with `send`. `remove` kills the process and deletes the transcript/id. Both are independent of parent Escape behavior. |
| History | A parent keeps its ordinary Pi transcript; children are ephemeral (`--no-session`) and leave nothing on disk. No separate orchestration persistence or recovery. |
| Capacity | One admission cap of eight registry entries, including `stopped` children. `remove` frees a slot; no queue, eviction, byte cap or scheduler. |
| Cleanup | `remove` and `session_shutdown` release owned processes; explicit `stop` does not. No elaborate session/branch handoff machinery. |

The notification tag is text inside an ordinary Pi notification/custom message,
not a new privileged message role. Example:

```text
<system-notification>
Subagent j1-mg2k4x9p finished. Its result is available; retrieve it when needed.
</system-notification>
```

Use Pi's `steer` delivery so busy-parent notices enter at the next message
boundary instead of waiting for the whole run; coalesce pending notices into one
message and use a short idle window to batch near-simultaneous completions.
Long-running reminders share the notifier, replace older reminders for the same
child, and are removed by completion or stop. Results/errors stay with the child
for explicit retrieval through the existing inspection surface. Do not automatically inject
result bodies, progress streams or child transcripts into parent context.

## Explicitly out of v1

- Admission queues and scheduling: the parent decides what to start within the
  eight-entry cap; `remove` is the explicit release path.
- Request/token budgets, wrap-up counters and forced-yield policies.
- Automatic task deadlines, idle eviction, auto-stop or auto-reassignment. Stop
  is explicit. The 10-minute reminder is notification-only.
- Read-only enforcement, tool-permission profiles and file ownership locks.
- Parent Escape interception, stop/resume propagation and auto-wake suppression.
- Retry/outbox ledgers, delivery acknowledgments or expensive lifecycle checks
  before sending a notification.
- Automatic parking/revival, eviction policies and cross-restart recovery.
- Worktrees, team/DAG orchestration, recursion/depth-policy frameworks.
- A polished dashboard, Docker integration, or full native RPC parity as a
  prerequisite for the first working extension.

Basic input validation, RPC error reporting and process cleanup still belong in
v1. They are not an agent-policy framework. Extra supervision/retention policies
can be added after using the simple version.

## First demonstration

Parent starts a child and continues working. Open that child's conversation,
watch its messages/tools, steer the same worker, receive its completion notice,
and explicitly stop it when requested.

The OmO/OMP sources remain implementation references, not a requirement to
reproduce their lifecycle, budget or persistence systems. Their upstream URLs
and pinned snapshots are recorded in the research inventory; the old host's
scratch checkouts are not shipped as dependencies.
