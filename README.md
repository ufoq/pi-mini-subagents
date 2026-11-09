# pi-mini-subagents

A small Pi extension for **persistent, observable and steerable background
subagents**. One model-facing tool, one human viewer, one in-memory registry.
No scheduler or orchestration framework.

**Working vertical slice:** verified with Pi **1.4.0**, Node **24.20.0**, Linux.
Native TUI and native RPC parents load the same extension; children are persistent
Pi RPC processes. See [verification](#verification) for what was actually tested.
Not published to npm or GitHub. Planned public upstream:
https://github.com/ufoq/pi-mini-subagents. `origin` is the local development copy.

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

This task does **not** install into the running coding agent, alter its
settings, or deploy to another environment. A deliberate future local installation
can use `pi install /absolute/path/to/pi-mini-subagents`; remove that declaration
with `pi remove /absolute/path/to/pi-mini-subagents`. With explicit loading,
simply omit `-e` next time to disable it. `--no-extensions` disables installed/
discovered extensions but intentionally does not disable explicit `-e` paths.

## Model controls

Ask the parent to delegate a task with explicit boundaries, for example:

> Spawn a subagent to review `rpc.ts` for cleanup bugs. Read only; do not edit
> files or use the network. I will keep working on documentation.

The single tool is:

```ts
subagent({ action: "spawn" | "list" | "read" | "send" | "stop",
           id?: string, message?: string, model?: string })
```

| Action | Required input | Effect |
| --- | --- | --- |
| `spawn` | `message` task brief | Returns `j1`, etc. immediately, before startup/model completion. Optional `model` (`"provider/model"`) overrides the child's model for this child only; omitted means the parent's model. |
| `list` | — | Short ids, states and task labels; no transcripts. |
| `read` | `id` | Latest result/diagnostic; while running, recent messages/tools. Bounded to about 8,000 characters. |
| `send` | `id`, `message` | Same child/context. Native steering when busy, new turn when idle. |
| `stop` | `id` | Explicitly terminates the owned process tree; id remains inspectable. |

A finished turn leaves the child alive. `finished` means Pi settled, **not** that
its assignment succeeded or the answer is correct. Failures retain diagnostics
for `read`. Launch/startup errors may arrive after the launch tool has returned.
A rejected steering command is reported to its caller, not treated as proof
that the existing work stopped.

On settlement or process failure, the only automatic parent-context message is:

```text
<system-notification>
Subagent j1 finished. Result/diagnostic available; use subagent read when needed.
</system-notification>
```

It contains identity/status/result availability, never result bodies, progress
or diagnostics. Pi's normal `triggerTurn: true`, `deliverAs: "followUp"` delivery
wakes an idle parent and queues behind busy work. The parent explicitly fetches
results. Explicit stop/shutdown does not send a completion wakeup. Submission
through Pi's void API is not a delivery/consumption acknowledgment.

## Human controls: `/agents`

- `/agents` opens the existing child list, newest child first (`j7` above `j1`).
  Up/down selects; Enter opens.
- `/agents j1` directly opens that child when it exists.
- The conversation shows earlier user/assistant messages, thinking, tool
  arguments/results, and live assistant/tool updates using public Pi renderers.
- Type at the **>** prompt and press Enter to send to that same child; the status
  line says whether that steers a running child or starts a new turn.
- **Page Up / Page Down** scroll; **Ctrl+Y** follows live output.
- **Ctrl+X** explicitly stops the selected child.
- **Escape** returns to the list; Escape again closes the viewer. Neither stops
  the child. Reopening observes the same process and history.

The viewer uses a temporary overlay, not a replacement parent footer/editor.
Human viewing never sends child history into parent model context. Images are
not displayed; text results and native truncation/full-output-path notices are.
Observer rows do not start execution clocks, so closing them leaves no renderer
timers behind.

`/agents` is guarded by `ctx.mode === "tui"`. In RPC mode it emits only an
informational UI notification; model controls, children and completion delivery
still work. **There is no web/extension-service RPC API yet.** Stock parent RPC
does not expose arbitrary extension state. `Agents.snapshot()`, `subscribe()` and
controls are separate from the TUI for a later explicit adapter.

## Execution and safety

- Fresh child conversation, same cwd, parent's model and thinking at launch.
  `spawn` may override the model per child with `model: "provider/model"`
  (the rest of the launch configuration is fixed). Follow-up reuses that child.
  No parent-transcript fork.
- Children inherit the parent's tools, skills, prompt templates and themes, but
  not its extensions: all built-in coding tools (`read`, `bash`/`powershell`,
  `edit`, `write`, `grep`, `find`, `ls`) and skills such as `web-search` are
  available. Extensions stay off, and because Pi implements MCP as a built-in
  extension, MCP is not available in children either. That also means no
  `subagent` tool, so a child cannot delegate. Project instruction discovery stays
  enabled. Children run with `--no-session`, so their conversations never appear
  in Pi's `/resume` picker and write no transcript; inspect them live in
  `/agents` or with `subagent read`. RPC children cannot answer Pi's project-trust
  prompt, so trust-gated project skills load only when a saved decision or
  `defaultProjectTrust` allows them; user-level skills always load.
- **Prompt restrictions are not a sandbox.** State read-only intent, allowed
  files/actions and ownership in the task brief. Children can mutate the shared
  workspace and use the parent's configured credentials/network access.
- Registry, results and live state are memory-only. Children are ephemeral
  (`--no-session`), so nothing is written to Pi's session storage. No result
  directories, mailboxes, recovery or resume API.
- Explicit stop and normal `session_shutdown` (including session replacement/
  reload) clean up owned processes. Linux cleanup snapshots the live descendant
  tree as well as process groups, since Pi bash tools create detached groups.
  A 300 ms termination grace precedes hard-kill cleanup; it is not a task deadline.
- No concurrency cap, admission queue, budget, automatic task deadline, writer
  lock, worktree, recursion framework, permission profile or parent-Escape policy.

## Development

```sh
./scripts/test                     # all deterministic offline tests
./scripts/test rpc.test.ts         # one test file
./scripts/test native-rpc.test.ts  # real Pi processes + local mock SSE provider
node scripts/probe-tui.ts          # separate native TUI/PTy probe; local mock only
```

The suite needs Node 24+ and installed Pi 1.4.0 on PATH (transport/controller
files alone need only Node). The optional TUI probe also needs Python 3 with
Unix `pty`. No test framework/build toolchain or external provider requests.
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

Actually executed during development:

- Offline transport/controller tests: immediate launch, split UTF-8 and LF-only
  framing, concurrent request correlation, command/protocol/provider/process
  errors, seven children without a cap, bounded reads, same-child steering/
  follow-up, and termination of an owned detached TERM-resistant descendant.
- Viewer component tests: late snapshot, live tool output, widths 12/30/80,
  long output, scrolling, close/reopen, steering and stop; no parent-context
  traffic from observation.
- Native Pi + mock provider, **RPC**: real tool execution, idle wake, busy queued
  completion, explicit read, ordinary child tools, retained follow-up and parent
  EOF shutdown with an active child.
- Native Pi + mock provider, **TUI**: actual PTY, `/agents` list/conversation/live
  bash output, human steering, close/reopen, resize/scroll, idle wake, explicit
  read, follow-up and human stop.
- Real provider (**an earlier small live route**, since repointed upstream), native RPC: actual successful child
  bash result (`CHILD_TOOL_OKCHILD_TOOL_DONE`), result-free notification after the
  parent settled, explicit read, remembered random word on follow-up in one child
  transcript, and explicit stop. Parent/child reported tokens including cache:
  **14,426 / 9,797**.
- Real provider **DeepSeek V4.1 Flash** (Ollama Cloud route), native RPC as a
  **fresh Unix user**, isolated HOME/Pi/XDG/cwd, minimal environment,
  and extracted package tarball: loading/READY, actual bash result, idle wake,
  explicit reads, retained context and stop all passed. Pinned Pi 1.4.0 was
  observed in the child's argv. A test-only relay verified **16 HTTP 200**
  responses with the exact requested/returned DeepSeek model. Total usage:
  **21,609 tokens including cache** (474 output; 16,816 cached input). Temporary
  test account/home and selected-provider credential config were removed.
- Deployment rehearsal (private registry + disposable container): published
  `0.1.0` to a private registry, installed it with `pi install
  npm:pi-mini-subagents` into a disposable Ubuntu 24.04 container (Node 24.22.2,
  Pi 1.4.0), and passed a clean-room RPC smoke using the installed package only.
  The container was deleted afterwards; nothing was published to npmjs. A later
  unpublish + republish of `0.1.0` also succeeded on the private registry (its
  artifacts are disposable; public npmjs is never writable from here).
- Real provider **DeepSeek V4.1 Flash**, native **TUI** (real PTY): spawn and
  immediate parent return, existing/live activity in `/agents`, rendered steering,
  notice-only completion, explicit read, retained word after steering plus
  follow-up, human stop, clean exit.
- Same real-model TUI loop with third-party extensions loaded (powerline footer,
  a context extension, a terminal bundle) in an isolated temp agent dir: viewer
  open/close, editor and exit remain functional; no extension load failure.
- `npm pack --dry-run --json`: payload includes only source modules, package
  metadata and README; not tests, fixtures, scratch logs or design research.

See [docs/VERIFICATION.md](docs/VERIFICATION.md) for evidence/limitations and the
[implementation plan](docs/design/PLAN.md) for the original acceptance gates.

## Remaining limitations

Linux is the cleanup target; other OS process-tree behavior is not verified.
Orderly stop/shutdown is covered, not recovery after parent SIGKILL/container
loss, or deliberately daemonized/reparented descendants. There is no durable
registry or cross-restart control. Histories stay in memory until parent shutdown,
and the simple viewer rebuilds on updates; very large transcripts can cost memory
and rendering time. Concurrent actors share native Pi steering semantics, not
transactional task control. Providers installed only by a parent extension (or
runtime-only credential overrides) are not automatically inherited. Existing
third-party footer/editor extension combinations have not been exhaustively
compatibility-tested.

**Known upstream interaction:** pi-powerline-footer 0.17.1 throws
`Cannot read properties of undefined (reading 'replace')` in its
`before_agent_start` handler when a run is started by a custom message with no
user prompt, which is exactly how completion notices wake an idle parent. Pi
catches per-handler errors, so the notice is still delivered and only a log line
appears. The guard (`event.messageType === "custom"`) is present from 0.22.0;
upgrade that extension to avoid the noise. No dashboard, publication or rollout
is included.

Authoritative scope: [HANDOFF.md](HANDOFF.md), [DEFAULTS.md](docs/design/DEFAULTS.md),
[FEATURES.md](docs/design/FEATURES.md), [PLAN.md](docs/design/PLAN.md). Research is
optional reference material, not an additional feature checklist.
