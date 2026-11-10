# Pi subagents: implementation plan

Updated: 2026-11-02
Status: working vertical slice implemented and verified on Pi 1.4.0. See
[../VERIFICATION.md](../VERIFICATION.md) for actual runs and limitations. The
placement notes below supersede earlier blueprint-based experiments.
Decisions: [DEFAULTS.md](DEFAULTS.md). Requirements: [FEATURES.md](FEATURES.md).

## 1. Project identity, goal and hard boundaries

- Repository project: **`pi-mini-subagents`**; npm package name: **`@ufoq/pi-mini-subagents`** (scoped, published with `access: public`).
- Planned canonical upstream: **https://github.com/ufoq/pi-mini-subagents**.
- A private development remote hosts the working copy. `upstream` uses
  `https://github.com/ufoq/pi-mini-subagents.git`.
- GitHub creation, public pushes and npm publication are separate, explicit
  future operations. The initial commit does not claim any of them happened.

Build a small Pi extension: spawn a child without blocking, observe its actual
conversation/tools, steer it, read its result on demand, and explicitly stop it.

- Source lives in the standalone **pi-mini-subagents** repository, not inside a
  shared blueprint.
- Development happens in a dedicated container and this checkout; the host
  operator owns container lifecycle, not extension code.
- **Do not modify any other project or environment.** No bulk commands, shared
  service restarts, network/firewall changes, volume deletion or pruning.
- Do not modify a shared blueprint or operator-provided instructions.
- Load the prototype explicitly in dedicated test Pi sessions. Do not hot-install
  it into the coding agent's own runtime or share it across active workers.
- Keep runtime coordination in memory. A parent may keep its ordinary Pi
  transcript; children are ephemeral (`--no-session`) and leave no session behind.
  No custom job directories, result files, mailboxes or recovery daemon.

The implementation worker must be able to work from this checkout alone. No
host scratch checkouts, external scripts or a Docker socket are required for its
core implementation/tests. See [../../HANDOFF.md](../../HANDOFF.md).

## 2. Architecture

```text
Parent Pi: native TUI OR native RPC
  our extension
    compact model tool ----+
    /agents human viewer --+-- one in-memory controller
                              |-- persistent Pi RPC child j1
                              |-- persistent Pi RPC child j2
                              +-- completion notices to parent
```

Both parent modes load the same extension. No SDK parent backend, native Pi
patch, replacement terminal client, simultaneous TUI/RPC bridge, or separate
session host is required for this slice.

Children use the same Pi CLI/version, working directory, configured credentials,
model and thinking level as the parent. Start fresh sessions, not transcript
forks. Inherit the parent's tools, skills, prompt templates and themes: all built-in
coding tools (`read`, `bash`/`powershell`, `edit`, `write`, `grep`, `find`, `ls`)
plus the inherited skill catalog. Disable extensions, which also excludes MCP
(Pi implements it as a built-in extension) and our own `subagent` tool, so a child
cannot delegate. Parent prompts describe read-only intent, allowed files and task
ownership; those instructions are not a sandbox. Do not load our launcher in a
child.
Keep normal project-instruction discovery. Start children with `--no-session` so
they never clutter `/resume` and persist no transcript. This is a small fixed
launch configuration, not a role/permission/inheritance framework.

### Minimal code layout

```text
pi-mini-subagents/
  index.ts          Pi registration, tool, /agents, notification, shutdown hook
  agents.ts         plain registry and shared controller operations
  presets.ts        Markdown preset discovery, validation and formatting
  rpc.ts            subprocess ownership and the small native RPC subset
  viewer.ts         child list/conversation/steering UI, TUI only
  *.test.ts         offline controller/transport/formatting tests
  fixtures/         fake RPC subprocess used by tests, not shipped at install
  scripts/test      node --test wrapper, full suite or a selected test file
  package.json      minimal Pi extension metadata, added with implementation
  docs/design/      requirements, decisions, plan and reference research
  README.md         usage, limits, development and test commands
```

Merge modules if that makes the actual code smaller. No backend abstraction,
plugin registry, scheduler, event framework or new build toolchain.

## 3. Small interfaces

### Model-facing tool

Start with one compact tool, provisionally `subagent`:

```text
subagent({ action: "spawn" | "list" | "read" | "send" | "stop" | "presets",
           id?: string, message?: string, preset?: string,
           model?: string, thinking?: string, tools?: string })
```

| Action | Meaning |
| --- | --- |
| `spawn` | `message` is the task brief. Register/start a child and return its id immediately; do not await its model run. Optional `preset` supplies launch defaults; explicit `model`, `thinking` and `tools` override the matching preset fields. |
| `presets` | List valid user/project presets and malformed files. |
| `list` | Return ids, short task labels, preset names and current state, not transcripts. |
| `read` | Return the identified child's latest result/error; while working, return a short recent-activity view. No status-polling requirement. |
| `send` | Deliver `message` to the same conversation, steering when busy or starting a new turn when idle. |
| `stop` | Terminate that child and release its process resources. This is not parent Escape handling. |

Validate required fields and unknown ids. Keep descriptions and results short.
A bounded model-facing read is output/context hygiene, not a request budget.
The human viewer can inspect the full conversation independently.

### Presets

Optional Markdown presets live under `~/.pi/agent/subagent-presets/` and, when
the project is trusted, `<nearest-project>/.pi/subagent-presets/`. Project
presets override user presets by name. Fields are `name`, `description`,
`model`, `thinking`, `tools`, and either the Markdown body or a frontmatter
`system_append`; the body is the conventional prompt. A preset sets launch
defaults only: explicit spawn arguments win field by field, and `system_append`
is preset-only and never a tool argument. No built-in presets, preset editor,
inheritance, auto-routing or permission enforcement. A preset tool allowlist is
launch configuration, not a sandbox. Presets are reread on each spawn/discovery
call; running children keep their launch configuration.

### Shared controller

Expose ordinary in-process functions for spawn/list/read/send/stop, conversation
snapshot and event subscription. Tool and viewer call the same functions and
address the same ids. A plain map holds process handles, task text, minimal
state and display/result data. No serialized copy or global inventory.

## 4. RPC behavior and completion

Implement only the commands needed here: startup state, `prompt`,
`get_messages`/`get_last_assistant_text`, and shutdown/control. Send later input
with native `prompt` plus `streamingBehavior: "steer"`; Pi handles busy versus
idle without a check-then-send race or a custom input scheduler.

Subscribe before the first prompt. RPC has no JSON-mode session header; use
`get_state` for startup identity. An accepted `prompt` is not completion.

- Forward message and tool events to observers. Keep authoritative completed
  messages and the currently streaming message, not a retained raw event log.
- Use `agent_settled` for the finished-run signal, not intermediate `agent_end`.
  This is subscribing to Pi's existing lifecycle, not building another one.
- Cache the latest result/error before sending a notice. A settled turn leaves
  the child alive and available for follow-up. Idle is not proof of task success.
- On a startup/protocol/provider failure or unexpected exit, retain a useful
  diagnostic for `read` and show failure honestly instead of leaving `running`.

Use one short custom message through `pi.sendMessage`, with `display: true`,
`triggerTurn: true`, and `deliverAs: "followUp"`:

```text
<system-notification>
Subagent j1 finished. Its result is available; retrieve it when needed.
</system-notification>
```

Include identity/status only, never the result body or diagnostics. The parent
fetches them through `read`. Pi queues the notice when busy and wakes the parent
when idle. No parent busy/idle checks, Escape policy, completion batching,
retry/outbox ledger, delivery acknowledgment or continuation loop. The API
returns void; do not claim submission proves model consumption.

For process ownership, use a small native-RPC transport in `rpc.ts`, with strict
LF/UTF-8 JSONL framing, request ids and continuously drained stdout/stderr.
Pi 1.4.0's public `RpcClient` is the protocol reference, but does not expose a
process-group spawn/stop hook. Do not access its private fields or build a full
replacement client. Own the subprocess directly so explicit stop can terminate
the Linux process group, including bash descendants. A short termination grace
and hard-kill fallback are cleanup mechanics, not an automatic job deadline.

Keep child stdin open during use. Close/terminate owned processes on explicit
stop or `session_shutdown`. Attach terminal/error handlers early, reject pending
RPC requests on process failure, and make cleanup idempotent. No orphan scan,
branch bookkeeping, generation ledger, parking or crash-recovery machinery.

## 5. Human observation

`/agents` opens a simple child list, then a scrollable live conversation with a
steering input and an explicit stop action. Show previous messages, assistant
output, tool names/arguments/results and current state, not only a status label.

Reuse public Pi message/tool renderers and Pi TUI scrolling/input components
where practical. Do not replace the footer/editor used by existing extensions.
Subscribe while open; unsubscribe when closed. Closing the viewer changes no
worker state. Guard custom terminal UI with `ctx.mode === "tui"`.

In RPC parent mode, the model tool, child execution and completion notices work
without that viewer. **This does not automatically expose children to a web
client.** Keep snapshot/subscription/control functions separate from the TUI so
an explicit transport adapter can be added later. Stock parent RPC has no
arbitrary extension-service dispatcher. Do not smuggle child snapshots or live
streams through parent-context messages to pretend otherwise.

## 6. Build order and acceptance gates

### A. Offline core and RPC transport

- [x] Add the root extension modules and minimal controller/transport.
- [x] Test against a fake RPC subprocess, without Docker or model requests.
- [x] Prove immediate launch, late inspection, live events, send/follow-up,
      failure reporting, and explicit stop including descendants.
- [x] Add the `scripts/test` wrapper and document full-suite/single-test commands
      in this repository's README and `AGENTS.md` when tests are introduced.

### B. Pi tools and notification

- [x] Register the compact tool and basic shutdown cleanup.
- [x] Test notification-only delivery, including result availability before
      notification and no result text injected automatically.
- [x] Start more than five fake children: no inherited cap or admission queue.
- [x] Keep permission instructions verbatim; add no read-only gate, budgets,
      automatic deadlines or parent Escape handler.

### C. TUI observer

- [x] Implement `/agents` using the shared controller, snapshot and events.
- [x] Open halfway through; show preceding activity and subsequent live output.
- [x] Send a correction to that same worker; close/reopen without restarting it.
- [x] Verify scrolling, long tool output, narrow width, and no footer/editor
      conflict with existing third-party extensions. Mock-provider component and
      native-TUI probes cover scrolling/long output/narrow widths and resize; a
      real-model combo probe loads a powerline footer, a context extension and a
      terminal bundle alongside this extension and passes the same loop.

### D. Dedicated project-worker live probes

- [x] Work in this repository inside the dedicated development environment;
      preserve its settings, models, packages, credentials and transcripts.
- [x] Load with an explicit extension path in a separate native-TUI test session
      and prove the complete loop; do not alter the coding agent's own runtime.
      Verified in a real PTY with deterministic mock provider, not real inference.
- [x] Load the same extension in a dedicated native-RPC parent probe with its
      own session/stdin/stdout. Do not reuse the TUI parent's history writer.
      Verified with mock provider, a small configured live-model smoke, and a
      packaged-candidate DeepSeek live run as a fresh isolated Unix user;
      `scripts/probe-tui-live.ts` and `scripts/probe-combo.ts` add opt-in
      real-model native-TUI coverage, including third-party extensions.
- [x] Prove an idle parent wakes on the notice and can retrieve the child result;
      a busy parent receives the ordinary queued notice without custom routing.
- [x] Prove follow-up retains context, observer disconnect leaves work running,
      and explicit stop/shutdown releases owned processes.

Use scratch tasks/data and logs under this repo's ignored `tmp/`, never another
worker's workspace. Real model probes are opt-in integration tests and consume
provider tokens. Test-harness timeouts may bound experiments; they do not become
extension runtime policy.

### E. Standalone packaging, without rollout

- [x] Add minimal Pi package metadata with `name: "@ufoq/pi-mini-subagents"`, repository
      URL `https://github.com/ufoq/pi-mini-subagents`, and the extension entry
      point; make the supported Pi version explicit. Do not use a scoped alias,
      private remote URL, or internal environment name as the package identity. No
      separate bundle/build is needed unless a concrete dependency requires one.
- [x] Document explicit `pi -e ./index.ts` loading, installation, disabling,
      limitations and test commands. Keep tests/fixtures out of install payloads.
- [x] Validate loading from this checkout in the dedicated project worker.
- [x] Keep blueprint seeding, global deployment, package publication and migration
      of other workers outside this task. The host operator may integrate the
      finished standalone package later.

A working core/TUI extension is the first milestone, not a polished dashboard or
worker-mode rewrite. Later work can wire exclusive worker launcher modes and a
network gateway. An RPC launcher must have a real owner for stdin/stdout; merely
putting JSON RPC in tmux or starting it with closed stdin is not a web server.

## 7. Validation commands

Available offline wrapper (Node 24+; installed Pi 1.4.0 for adapter/native tests):

```sh
./scripts/test                # all project offline tests
./scripts/test rpc.test.ts    # one test file
```

Use built-in `node --test` and Node-24-compatible erasable TypeScript. Pi loads
source through its existing loader; no new build step or test framework.
Runtime loading commands:

```sh
pi -e ./index.ts                             # separate native TUI test session
pi --mode rpc --no-session -e ./index.ts      # parent probe; keep stdin open
```

Run probes under an explicit harness with separate session history as needed;
do not repurpose the development agent's active session. These commands describe
explicit loading; the native probes are saved in `scripts/probe-tui.ts`,
`scripts/probe-live.ts`, `scripts/probe-tui-live.ts` and `scripts/probe-combo.ts`
(opt-in inference), and `native-rpc.test.ts`.

Container lifecycle and any host-side runtime probe are operator tasks and stay
outside this repository's commands. No host lifecycle, reseed or other-project
operation is required to implement or test the extension.

## 8. Explicitly not in this implementation

No concurrency controls, scheduler, request/token budget, automatic job/idle
timeout, read-only enforcement, writer lock, automatic worktree, role/depth
framework, parent Escape interception, pause/resume propagation, completion
batching/retry ledger, automatic eviction/parking/revival, durable recovery,
ACP backend, SDK host, full RPC reimplementation, or rollout to active workers.

## References checked

- The original shared blueprint and local-extension seed pattern were inspected as
  references. They are not source dependencies or an instruction to modify them.
- The standalone repository/dedicated-worker handoff supersedes the earlier
  the earlier blueprint-based implementation location and single-environment experiment scope.
- Pi 1.4.0 [extensions](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/extensions.md),
  [RPC commands](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/rpc-commands.md),
  [JSON/RPC events](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/json.md),
  [TUI](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/tui.md),
  and exported RPC client/extension declarations in the installed release.
- Broader inspirations remain in [LANDSCAPE.md](LANDSCAPE.md) and
  [IMPLEMENTATIONS.md](IMPLEMENTATIONS.md); they do not expand v1 scope.
