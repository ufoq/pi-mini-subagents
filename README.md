# pi-mini-subagents

A small Pi extension for **persistent, observable and steerable background
subagents**. One model-facing tool, one human viewer, one in-memory registry.
No scheduler or orchestration framework.

**Status:** verified with Pi **1.4.0** and **1.5.2**, Node
**24.20.0**, Linux.
Native TUI and native RPC parents load the same extension; children are persistent
Pi RPC processes. See [verification](#verification) for what was actually tested.
Public package: `@ufoq/pi-mini-subagents`. Canonical upstream:
https://github.com/ufoq/pi-mini-subagents. The development copy is `origin`.

## Try it without installing

From this checkout, start a **separate** Pi session:

```sh
pi -e ./index.ts
```

For a headless parent, use an RPC client that keeps stdin open and continuously
drains stdout/stderr:

```sh
pi --mode rpc --no-session -e ./index.ts
```

The parent needs a configured model and credentials usable by ordinary child Pi
processes. No build or runtime dependency installation is needed: Pi supplies its
public libraries and TypeScript loader. For isolated testing, add
`--no-extensions --no-mcp --no-skills --no-prompt-templates --no-themes`; explicit
`-e ./index.ts` still loads this extension.

A deliberate installation can use `pi install npm:@ufoq/pi-mini-subagents`, or
`pi install /absolute/path/to/pi-mini-subagents` from a checkout; remove the
declaration with the matching `pi remove …`. With explicit loading, simply omit
`-e` next time to disable it. `--no-extensions` disables installed/discovered
extensions but intentionally does not disable explicit `-e` paths.

## Model controls

Ask the parent to delegate a task with explicit boundaries, for example:

> Spawn a subagent to review `rpc.ts` for cleanup bugs. Read only; do not edit
> files or use the network. I will keep working on documentation.

The single tool is:

```ts
subagent({ action: "spawn" | "list" | "read" | "send" | "stop" | "remove" | "presets",
           id?: string, message?: string, model?: string, preset?: string,
           thinking?: string, tools?: string })
```

| Action | Required input | Effect |
| --- | --- | --- |
| `spawn` | `message` task brief | Returns a timestamped id immediately; the child is `active` while launch completes. Optional `preset` supplies launch defaults; `model`, `thinking` and `tools` override the same preset fields for this child only. At eight registry entries, spawn is rejected until `remove` frees a slot. |
| `presets` | — | Lists valid user/project presets with defaults and malformed preset files. Does not start a child. |
| `list` | — | Short ids, `active`/`stopped` state, preset names and task labels; no transcripts. Also shows available preset names and reminds that `remove` releases a stopped child. |
| `read` | `id` | Latest result/diagnostic, or an attributed transcript (`assistant:`, `tool bash:`, `user:`). Works while active and after stop; stopped output is retained until `remove` or parent shutdown. Bounded to about 8,000 characters. |
| `send` | `id`, `message` | Same child/context. Native steering while `active`; a `stopped` child with a live process starts a new turn. A stopped child whose process died can be read, but cannot resume; `read` it and `remove` it. |
| `stop` | `id` | Aborts the current turn with Pi `clear_queue` + `abort`, keeps a live process/context, and retains the partial answer. Idempotent; no completion notice. |
| `remove` | `id` | Kills the process and deletes the transcript and id. Allowed in either state; frees a registry slot immediately. |

After `spawn` or `send`, continue independent work. When only child-dependent
work remains, end the turn instead of waiting with shell `sleep` or repeated
`list`/`read` polling; a completion notice starts a new turn and wakes an idle
parent.

A natural turn settles the child to `stopped`, not destroyed: while its process
remains alive, the process and context stay available for `send`, and `read`
still works. `stopped` does not imply success; the completion notice outcome is
`finished` or `failed`, and failures retain diagnostics for `read`. `stop` aborts
a turn but also leaves the child `stopped` and resumable while the process is
alive. `remove` is the only operation that releases the process and transcript. A
rejected steering command is reported to its caller, not treated as proof that
the existing work stopped.

On settlement or process failure, the only automatic parent-context message is:

```text
<system-notification>
Subagent j1-mg2k4x9p finished. Result/diagnostic available; use subagent read when needed. Stopped children stay readable; send resumes a live child; subagent remove releases the process and transcript.
</system-notification>
```

It contains identity, outcome and result availability. It never contains result
bodies or progress; a failed notice may include a short sanitized diagnostic. Pi's
`triggerTurn: true`, `deliverAs: "steer"` delivery wakes an
idle parent and, when busy, delivers at the next message boundary after the
current assistant turn and its tool calls. Notices from the same turn are
coalesced into one message; while idle, a short burst window batches
near-simultaneous completions. The parent explicitly fetches results.

A child still `active` after 10 minutes produces a reminder at the same message
boundary:

```text
<system-notification>
Subagent j1-mg2k4x9p has been running for 10 minutes. Use subagent read to check progress; subagent stop if it is stuck.
</system-notification>
```

The reminder repeats every 10 minutes while the child is `active`. It is a
notification, not a deadline: nothing is cancelled automatically. Reminders and
completions share one message per burst; the latest reminder for a child replaces
an older queued one, and a completion or stop removes it. Explicit stop/remove
and shutdown do not send a completion wakeup. Submission through
Pi's void API is not a delivery/consumption acknowledgment.

## Presets

A **preset** is optional, user-defined launch configuration, not a separate
agent identity or runtime. Presets are read from Markdown files with YAML
frontmatter:

```text
~/.pi/agent/subagent-presets/*.md
<trusted-project>/.pi/subagent-presets/*.md
```

The nearest project directory wins; project presets load only when the project
is trusted. A project preset with the same name overrides the user preset. No
presets ship with the extension.

Project presets follow Pi's own project-trust result. The extension adds no
second trust rule. Pi treats a project whose only resource is
`.pi/subagent-presets` as trusted. On Pi 1.5.0+ a saved trust decision or
explicit approval override prevails; on Pi 1.4.0 such a project is auto-trusted
before saved decisions are consulted. Use user-level presets when repository
presets should not override them.

```markdown
---
name: oracle
description: Read-only engineering consultant.
model: provider/model
thinking: high
tools: read, grep, find, ls
---

You are Oracle, an independent senior engineering consultant...
```

- `name` and `description` are required. The Markdown body is the prompt appended
to Pi's normal system prompt. The optional frontmatter `system_append` field can
be used instead of the body; it is **not** a tool argument.
- `model` and `thinking` are optional; omitted means the parent's value.
- `tools` is optional and accepts `read, grep, find, ls` or a YAML list. It
defaults to all built-in coding tools. An explicit `tools` argument overrides it.
- A preset's `system_append` is added after the normally applicable
`APPEND_SYSTEM.md`; selecting a preset does not replace the normal append.
- Explicit `model`, `thinking` and `tools` arguments override the corresponding
preset field. The preset `system_append` still applies. `action`, `id` and
`message` are always per-call values.
- Presets are reread on every `spawn`/`presets` call; an existing child keeps the
configuration it started with.
- Preset tool restrictions are launch configuration, not a sandbox. A preset that
includes `bash` can still mutate the workspace.

Example:

```ts
subagent({ action: "spawn", preset: "oracle",
           message: "Review this patch. Read only." })
subagent({ action: "spawn", preset: "oracle", tools: "read",
           message: "Answer with one file: rpc.ts" })
```

Use `subagent({ action: "presets" })` for full details and invalid files, or
`subagent({ action: "list" })` for a compact name list. Unknown or invalid
presets fail before any process starts.

## Human controls: `/agents`

- `/agents` opens the existing child list, newest child first (`j2-...` above
  `j1-...`). Up/down selects; Enter opens. Rows and the detail heading show the
  preset name when one was used.
- `/agents j1-mg2k4x9p` directly opens that child when it exists.
- The conversation shows earlier user/assistant messages, thinking, tool
  arguments/results, and live assistant/tool updates using public Pi renderers.
- Type at the **>** prompt and press Enter to send to that same child; the status
  line says whether that steers an active child or starts a new turn.
- **Page Up / Page Down** scroll; **Ctrl+Y** follows live output.
- **Ctrl+X** aborts the selected child’s current turn; the child remains `stopped` and accepts a new turn. `remove` is only available through the tool, not the viewer.
- **Escape** returns to the list; Escape again closes the viewer. Neither stops
  the child. Reopening observes the same process and history.

The viewer uses a temporary overlay, not a replacement parent footer/editor.
Human viewing never sends child history into parent model context. Images are
not displayed; text results and native truncation/full-output-path notices are.
Observer rows do not start execution clocks, so closing them leaves no renderer
timers behind.

Child ids use a session counter plus a base36 millisecond timestamp, for example
`j1-mg2k4x9p`. A restarted or resumed parent session cannot silently reuse an
old `j1`. Ids are opaque: pass the full id to `read`, `send`, `stop` or `remove`;
there are no bare-counter aliases.

`/agents` is guarded by `ctx.mode === "tui"`. In RPC mode it emits only an
informational UI notification; model controls, children and completion delivery
still work. **There is no web/extension-service RPC API yet.** Stock parent RPC
does not expose arbitrary extension state. `Agents.snapshot()`, `subscribe()` and
controls are separate from the TUI for a later explicit adapter.

## Execution and safety

- Fresh child conversation, same cwd, parent's model and thinking at launch.
  `spawn` may override `model`, `thinking` and `tools`, or apply those defaults
  from a named preset. The remaining launch configuration is fixed. Follow-up
  reuses that child. No parent-transcript fork.
- Children do **not** inherit the parent's selected tool subset. Unless a preset
  or spawn argument supplies `tools`, they launch with all built-in coding tools
  (`read`, `bash`/`powershell`, `edit`, `write`, `grep`, `find`, `ls`). Skills,
  prompt templates and themes are inherited. Extensions stay off, and because Pi
  implements MCP as a built-in extension, MCP is not available in children
  either. That also means no `subagent` tool, so a child cannot delegate.
  Project instruction discovery stays enabled. Children run with `--no-session`,
  so their conversations never appear in Pi's `/resume` picker and write no
  transcript; inspect them live in `/agents` or with `subagent read`. RPC children
  cannot answer Pi's project-trust prompt, so trust-gated project skills load only
  when a saved decision or `defaultProjectTrust` allows them; user-level skills
  always load.
- **Prompt restrictions are not a sandbox.** State read-only intent, allowed
  files/actions and ownership in the task brief. Children can mutate the shared
  workspace and use the parent's configured credentials/network access.
- Registry, results and live state are memory-only. Children are ephemeral
  (`--no-session`), so nothing is written to Pi's session storage. No result
  directories, mailboxes, recovery or resume API.
- **Child spend is invisible to the parent's footer.** Subagent tokens/cost are
  part of the same provider quota, but the parent's session cost display excludes
  them because children are separate, ephemeral sessions. There is no per-child
  usage accounting in this extension.
- `remove` and normal `session_shutdown` (including session replacement/reload)
  clean up owned processes; `stop` deliberately keeps them. Linux cleanup snapshots
  the live descendant tree as well as process groups, since Pi bash tools create
  detached groups. A 300 ms termination grace precedes hard-kill cleanup; it is
  not a task deadline.
- Admission is capped at eight registry entries, including stopped children.
  There is no queue, automatic eviction, byte cap, budget, automatic task deadline,
  writer lock, worktree, recursion framework, permission profile or parent-Escape
  policy. The 10-minute reminder is notification-only and never stops or reassigns
  a child. A single child’s transcript can still grow without a byte limit.

## Development

```sh
./scripts/test                     # all deterministic offline tests
./scripts/test rpc.test.ts         # one test file
./scripts/test native-rpc.test.ts  # real Pi processes + local mock SSE provider
node scripts/probe-tui.ts          # separate native TUI/PTy probe; local mock only
```

The suite needs Node 24+ and installed Pi 1.4.0 or 1.5.2 on PATH
(transport/controller files alone need only Node). The optional TUI probe also
needs Python 3 with Unix `pty`. No test framework/build toolchain or external provider requests.
Tests use separate subprocesses and synthetic data under ignored `tmp/`.

Real-model smoke is **separate and opt-in**, consumes provider tokens, and uses
the launching user's configuration without changing it:

```sh
MINI_SUBAGENTS_LIVE_MODEL=provider/model node scripts/probe-live.ts
```

It explicitly loads this extension in a separate native-RPC parent, disables
other resources, keeps scratch files under `tmp/`, and checks tool results,
notifications, idle wakeup, retained context and stop. Optional
`MINI_SUBAGENTS_PI_CLI=/absolute/path/to/pi-coding-agent/dist/cli.js` pins the
host and verifies the observed child invocation;
`MINI_SUBAGENTS_EXTENSION=/absolute/path/to/candidate` loads an extracted package
outside this checkout. These allow running the same driver from a fresh Unix
user/home with isolated config, cwd and credentials, as verified below. Its harness deadlines do
not impose extension runtime deadlines. Logs may include project context; keep
them private. Do not copy auth stores or session logs into published artifacts.

### Verification

Current baseline: Pi **1.4.0** and **1.5.2**, Node **24.20.0**, Linux.

- Deterministic offline suite: **86/86** on Pi 1.5.2, including native RPC parent
  processes against a mock provider; the native TUI mock probe passes.
- Installed-package lease check: Ubuntu 24.04.5, Node 24.20.0, Pi 1.5.2, and
  `@ufoq/pi-mini-subagents@0.2.4`; the full suite passed **86/86**. The lease TUI
  probe's "reopen same child" step failed with both Pi 1.4.0 and 1.5.2 in that
  lease; local TUI probes pass on both, so no lease TUI pass is claimed.
- Earlier real-provider and third-party-extension probes ran on Pi 1.4.0 and are
  historical, not 1.5.2 validation. No live-provider calls were made on 1.5.2.
- `npm pack --dry-run --json`: payload includes source modules, package metadata,
  README, DESIGN, LICENSE and CHANGELOG; not tests, fixtures, scratch logs or
  research notes.

Current architecture and invariants are in
[docs/DESIGN.md](docs/DESIGN.md).

## Remaining limitations

Linux is the cleanup target; other OS process-tree behavior is not verified.
Orderly stop/shutdown is covered, not recovery after parent SIGKILL/container
loss, or deliberately daemonized/reparented descendants. There is no durable
registry or cross-restart control. Stopped children with a live process stay
resumable until `subagent remove` or parent shutdown; a child whose process died
remains readable but cannot resume. There is no idle reaper. Histories
stay in memory until removal or shutdown, bounded only by the eight-entry cap;
the simple viewer rebuilds on updates, and very large transcripts can cost memory
and rendering time. Concurrent actors share native Pi steering semantics, not
transactional task control. Providers installed only by a parent extension (or
runtime-only credential overrides) are not automatically inherited. Existing
third-party footer/editor extension combinations have not been exhaustively
compatibility-tested.

**Pi 1.5.1+ cache warming:** a stopped child kept for follow-up may keep eligible
provider caches warm for up to 30 minutes between runs. Warming only happens when
the model declares a cache lifetime and Pi expects the refresh to pay for itself;
the refresh usage can be billable and counts toward the child's usage totals but
is not included in parent context or the parent footer. It cannot be disabled per
child; set the global `cacheWarming` setting to `"streaming"` or `"off"` to stop
idle warming (this also affects the parent).

**Known upstream interaction:** pi-powerline-footer 0.17.1 throws
`Cannot read properties of undefined (reading 'replace')` in its
`before_agent_start` handler when a run is started by a custom message with no
user prompt, which is exactly how completion notices wake an idle parent. Pi
catches per-handler errors, so the notice is still delivered and only a log line
appears. The guard (`event.messageType === "custom"`) is present from 0.22.0;
upgrade that extension to avoid the noise. No dashboard, publication or rollout
is included.

Current design and scope: [docs/DESIGN.md](docs/DESIGN.md). This README is the
usage reference; [CHANGELOG.md](CHANGELOG.md) records release changes.

## License

MIT. See [LICENSE](LICENSE).
