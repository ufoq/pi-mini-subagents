# Design

Current design for `@ufoq/pi-mini-subagents`. Usage and examples live in
[../README.md](../README.md); this document records architecture, invariants and
scope. Package version is in `package.json`; release changes are in
[../CHANGELOG.md](../CHANGELOG.md).

## Purpose

A small Pi extension for persistent, observable and steerable background
subagents. The parent delegates work, keeps working, can inspect or steer a child,
and explicitly retrieves results. It is not a scheduler, workflow engine, web
platform or policy framework.

## Architecture

A native Pi TUI parent or a native RPC parent loads the same extension. Both use
one in-memory controller and launch children as persistent Pi RPC subprocesses.

```text
parent Pi (TUI or RPC)
  └── extension
        ├── model-facing `subagent` tool
        ├── in-memory controller/registry
        └── `/agents` viewer
              └── child Pi RPC processes
```

Source layout:

| Module | Responsibility |
| --- | --- |
| `index.ts` | Tool schema/actions, notices, viewer registration, Pi event wiring |
| `agents.ts` | Child registry, lifecycle, control chain, reminders, admission cap |
| `rpc.ts` | JSONL subprocess transport and owned-process cleanup |
| `presets.ts` | Markdown preset discovery, validation and append composition |
| `viewer.ts` | Secondary `/agents` human surface |

The controller is UI-agnostic. A future web UI must consume the same controller
through an explicit adapter; it must not create a second registry or inject child
traffic into parent context.

### Child launch

A child starts with a fresh conversation, the same working directory, and the
parent's model/thinking by default. `spawn` can override `model`, `thinking` and
`tools`, or take those defaults from a preset.

Children launch with `--mode rpc --no-session --no-extensions`. They do **not**
inherit the parent's selected tool subset: unless a preset or spawn argument
supplies `tools`, they get all built-in coding tools (`read`, `bash`/`powershell`,
`edit`, `write`, `grep`, `find`, `ls`). Skills, prompt templates and themes are
inherited. Extensions remain off, which also excludes MCP and the parent's
`subagent` tool, so a child cannot delegate.

No child session transcript is persisted. That does not prevent ordinary tools
from writing files, and preset system prompts use a temporary `0600` file.

### Transport and ownership

The extension owns its subprocess directly instead of wrapping Pi's private
`RpcClient` fields. The transport implements the JSONL subset the extension uses,
drains stdout/stderr continuously, correlates requests, rejects pending requests
on process failure, and performs idempotent cleanup. Cleanup terminates the owned
process group with `SIGTERM`, waits a short grace period, then uses `SIGKILL`;
that grace is cleanup, not a runtime task deadline.

`get_state` supplies startup identity. Prompt acceptance is not completion.
`agent_settled` identifies a finished run; intermediate `agent_end` is not the
completion signal. The latest result/error is cached before a completion notice
is sent.

## Lifecycle

There are exactly two public states:

- **`active`** — the child is working.
- **`stopped`** — the child is not working; its process and context are retained
  and readable, and normally resumable.

`finished`/`failed` is an outcome, not a state. `removed` is not a state: the
entry, process and transcript are gone.

| Event or action | Result |
| --- | --- |
| `spawn` | Returns a timestamped id immediately; child starts `active`. |
| Natural turn settlement | `stopped`; notice outcome `finished` or `failed`. |
| Provider/run error | `stopped` with diagnostic; `send` can retry in the same context. |
| Fatal transport/startup failure | `stopped` and readable; not auto-removed. A dead process cannot resume, so `read` then `remove`. |
| `send` | Same child/context; native `streamingBehavior: "steer"` starts a turn when idle or queues while active. |
| `stop` | `clear_queue` then `abort`; keeps process/context, retains partial output, sends no notice, idempotent. |
| `remove` | Cancels pending notices/reminders, deletes the entry, then kills/cleans the process; no notice. |
| Parent shutdown | Releases all remaining children. |

Startup prompt, `send` and `stop` share one per-child FIFO control chain. The tail
survives rejected operations, so a queued send cannot escape a later stop.

Admission is exactly eight registry entries, including stopped and dead-but-
readable children. The ninth spawn is rejected before process creation with a
read/remove hint; `remove` frees the slot immediately. There is no queue,
eviction, auto-stop, byte cap or idle reaper. Ids are
`j<counter>-<base36 milliseconds>` so a restart cannot reuse an old id.

## Model-facing surface and notices

One compact `subagent` tool exposes `spawn`, `list`, `read`, `send`, `stop`,
`remove` and `presets`. Usage is documented in the README; the design constraints
are: bounded reads, no automatic result/transcript injection, and no status-
polling requirement.

A completion notice contains identity, outcome and result availability. It never
contains result bodies or progress; failures may include a short sanitized
diagnostic. Notices use an ordinary Pi custom message with `triggerTurn: true`
and `deliverAs: "steer"`, which wakes an idle parent and delivers at the next
message boundary when busy. The `<system-notification>` tag is text inside that
message, not a privileged Pi role.

Notices coalesce at `turn_end`, the next `agent_start`, `session_compact` /
`session_compact_failed`, and `agent_end`. While idle, a short 100 ms window
batches near-simultaneous completions. A child that remains `active` for ten
minutes produces a notification-only reminder every ten minutes. The timer is
anchored at spawn, is not reset by steering or retries, and is cleared by
settlement, failure, stop and shutdown. A completion or stop removes any queued
reminder for that child.

## Presets

Presets are optional named launch configuration, not identities or runtimes.
They are Markdown files with YAML frontmatter:

- User: `~/.pi/agent/subagent-presets/*.md`
- Project: `<nearest-project>/.pi/subagent-presets/*.md`, only when Pi reports the
  project trusted.

Project presets override user presets by name. Trust follows Pi's
`ctx.isProjectTrusted()` result; a saved trust decision or explicit approval
override prevails over auto-trust. No presets ship with the extension.

Fields are `name`, `description`, `model`, `thinking`, `tools`, and either the
Markdown body or a frontmatter `system_append`. The body is the conventional
`system_append`. A preset supplies defaults only: explicit spawn `model`,
`thinking` and `tools` win field by field. `system_append` is preset-only and is
never a tool argument.

Preset append is added after the normally applicable `APPEND_SYSTEM.md`, then
passed to the child through a per-child `0600` temporary file. It is removed on
failed launch, settlement, stop, remove and shutdown. Presets are reread on
`spawn`/`presets`; running children keep their launch configuration.

Preset tool restrictions are launch configuration, not a sandbox. A preset that
allows `bash` can still mutate the workspace.

## Human viewer

`/agents` is a secondary surface for occasional lookups. It shows the shared
registry, existing messages/tool activity and live updates. The human can steer
an `active` child or start a turn on a `stopped` child, and can stop a turn.
`remove` is intentionally tool-only. Opening or closing the viewer starts no
child and adds nothing to parent model context. A web UI remains a deferred goal.

## Safety and scope

The workers are trusted sandboxed workers. Prompts and tool allowlists reduce
mistakes; they are not permission enforcement. The extension adds no second
project-trust rule, no read-only enforcement, writer lock or worktree isolation.
Pi 1.5.1+ defaults `cacheWarming` to `"idle"`; idle stopped children can keep
eligible provider caches warm for up to 30 minutes, with billable usage outside
parent context. This is global Pi configuration, not a per-child extension
setting.

Explicitly out of scope:

- admission queues, schedulers, request/token budgets, automatic deadlines,
  idle eviction, auto-stop or auto-reassignment;
- read-only enforcement, permission profiles or file-ownership locks;
- parent Escape interception, stop/resume propagation or completion retry
  ledgers;
- durable recovery, cross-restart registry, parking/revival policies;
- worktrees, team/DAG orchestration, recursion frameworks or a full RPC/server
  implementation.

Basic validation, actionable errors and owned-process cleanup remain required
correctness, not orchestration policy.

## Support baseline

Verified on Pi **1.4.0** and **1.5.2**, Node **24.20.0**, Linux. The local
deterministic suite is **86/86** and the native TUI mock probe passes. A
disposable Ubuntu 24.04.5 lease with the installed `0.2.4` package passed
**86/86**; its TUI "reopen same child" check failed on both Pi 1.4.0 and 1.5.2,
so no lease TUI pass is claimed. No live-provider calls were made on 1.5.2.
The package declares peer dependencies as `*` following Pi's guidance; that does
not mean every Pi version was verified.
