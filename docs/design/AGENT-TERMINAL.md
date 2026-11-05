# Can our agent-terminal host Pi subagents?

Checked: 2026-11-01. Source inspection only; no terminal jobs, services, model
calls, or tests launched for this review.

Later direction agreed on the same date: use RPC/ACP for structured control and
observation; human UIs render that data. Native terminal-hosted Pi is NOT the
core design. This note preserves the terminal reuse research, not a current
recommendation to put every agent in agent-terminal.

## Source

- Private development repository (clone URL not recorded here)
- Default branch `main`, commit `5eb3b27008880510327e7e9cf7cacd39d0cb6fc6`
  (2026-09-10, release v0.1.6).
- Read-only research checkout: ignored scratch directory.
- Installed Pi bundle package reports 0.1.6. The CLI's own `--version` reports
  0.1.0; that alone is not evidence the package is outdated.

## Answer

Yes: reuse it for terminal/process hosting, NOT as the Pi agent-control protocol.
A parent agent should not have to operate a child's TUI by screen reading and
keystrokes when structured commands/events can be used instead.

These are separate concerns:

```text
Parent agent -> compact tools -> main owner -> live bridge -> child Pi session
                                     |                         |
                            agent-terminal lifecycle       native Pi TUI
                                                               |
                                                         human terminal
```

This is a possible design, not an approved architecture. The bridge/attach
integration does not already exist in agent-terminal.

## What the existing code saves

| Existing capability | Source | Benefit |
|---|---|---|
| Named jobs scoped by project/session | `src/paths.rs`, `src/state/model.rs` | No model bookkeeping of Zellij IDs; default Pi scope comes from `PI_SESSION_ID`. |
| Background Zellij startup and held panes | `src/commands/start.rs`, `src/zellij/cli.rs` | Existing PTY/process hosting and readable fast exits. |
| Ownership checks and reconciliation | `src/reconcile.rs` | Checks session/pane/non-plugin/title identity before targeting a job. |
| Literal paste and named keys | `src/commands/send.rs`, `src/commands/press.rs` | Useful for genuine terminal interaction; not a Pi task API. |
| Stop and cleanup | `src/commands/stop.rs`, `src/reconcile.rs` | Ctrl+C, up to 5 s grace, close pane, verify absence; last-job session cleanup. |
| Small CLI, no added Pi tool schema | `pi/npm/src/index.ts`, `src/cli.rs` | Adapter sets PATH/compatibility flags and ships a skill; it does not register six model tools. |

The owner can call this CLI internally. The parent model need not learn terminal
session IDs or receive a separate model tool for every terminal operation.

## What it does NOT provide

- **Pi activity/settlement/results.** Its states are `running` and `exited`.
  An interactive Pi waiting for another prompt is still a running process.
- **A reliable JSONL event stream.** `read` captures terminal-rendered content,
  ANSI-strips it, and bounds it to 200 lines / 32 KiB. Output is not a lossless
  stdout/stderr transport; those streams share the PTY screen.
- **Automatic completion notifications.** It has no event subscription or
  notification service. Repeated `read` is polling, not the desired workflow.
- **A public human attach/open operation.** CLI has only start/read/send/press/
  stop/list. Session and pane IDs are deliberately private, and Zellij uses a
  per-scope socket namespace. A main-Pi "open worker" action needs an explicit
  attach/focus integration, not guessed private paths/IDs.
- **Web access or parent-child discovery.** No HTTP/socket API or browser terminal
  is implemented here. A future dashboard still needs a host integration.
- **Proof of descendant-process containment.** Stop verifies pane/session
  disappearance. The wrapper does not itself implement a cgroup or independent
  process-group SIGTERM/SIGKILL supervisor; do not turn pane absence into a claim
  that every detached descendant was killed.

## Why not just run RPC in its terminal?

Pi 1.4.0 selects `runRpcMode` OR `InteractiveMode` in `dist/main.js` around
lines 774-797. Stock CLI does not run a native TUI and core stdio RPC concurrently.

- `agent-terminal start child -- pi ...`: actual TUI, but agent-terminal's input
  is terminal input, not structured Pi commands.
- `agent-terminal start child -- pi --mode rpc ...`: possible process hosting,
  but the pane shows the RPC stream, not a native Pi TUI. Using send/read as an
  RPC client would reintroduce lossy screen transport and polling.

To get both native Pi UI and structured model control, keep ONE live Pi session
and add a small extension bridge over live IPC. It can subscribe to Pi events,
accept prompts/steering through public extension APIs, and request cooperative
abort. Terminal stop remains a separate fallback. This is RPC-like application
control, not an assertion that stock stdio RPC works beside the TUI.

A different valid route is RPC workers plus an observer UI. In that route the
terminal layer may add little value; it should not be mandatory just because it
already exists. JSON print mode alone still does not support ongoing steering.

Never start a second Pi runtime on the same session file to fake attachment.

## In-memory constraint: existing mismatch

The current CLI creates `StateStore` unconditionally. It stores `state.json`,
locks, and Zellij config/layout under the OS state directory; screen capture
also uses a temporary file. This is fundamental to its stateless CLI/recovery
contract, not an optional save-history switch.

Two different policies must not be conflated:

1. **No NEW subagent files; existing terminal infrastructure may keep its own
   metadata.** Then unchanged agent-terminal can host panes while all Pi task
   records/events/results remain in the owner's memory.
2. **Strictly no file-based runtime coordination, including terminal metadata.**
   Then unchanged agent-terminal does not qualify. Reuse/adapt its Zellij backend
   under an in-memory owner, or use another terminal owner; a state-dir override
   (including tmpfs) does not remove the file protocol.

The user has not relaxed the in-memory requirement. Do not silently choose (1).

## What this changes in the complexity discussion

- Existing terminal hosting is a real saving; do not estimate as though we must
  build Zellij ownership/start/input/cleanup from scratch.
- Native terminal access does NOT require the MODEL to drive a screen. Human UI
  and model control can be two access paths to the same Pi session.
- Remaining work is explicit: live Pi bridge, human open/attach, parent routing
  and supervision, memory policy, and eventual dashboard adapter.
- Compare that missing work against RPC + a conversation viewer. Neither is
  automatically simpler just because its UI or protocol already exists.

Follow-ups should prototype the missing bridge/attach or observer path, not
rebuild a terminal manager or expose a large management tool catalog.
