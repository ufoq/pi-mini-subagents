# Pi control interfaces and simultaneous TUI/web access

Checked: 2026-11-01 against installed Pi 1.4.0, official docs/examples, and
source snapshots below. No integration test, package installation, server,
container change, or model run performed.

Follow-up: [LANDSCAPE.md](LANDSCAPE.md) compares existing implementations rather
than only Pi's stock interfaces; [IMPLEMENTATIONS.md](IMPLEMENTATIONS.md) pins
the sources. Stock native-TUI attachment is still absent, but third-party
attachable terminal clients and session-owning web hosts do exist.

## Short answer

- For custom Pi-only control, native RPC is simpler than adding an ACP adapter.
- ACP can simplify CLIENT reuse when an existing ACP UI/editor is the target.
- Stock Pi's native TUI is not a remote frontend: there is no built-in
  `pi serve` / `pi connect` pair in 1.4.0.
- An existing native TUI CAN coexist with a structured web UI through a bridge
  extension. This is not attaching stdio RPC to an already-running TUI.
- A server owning sessions with independent terminal and browser clients is
  feasible, but stock native Pi TUI does not attach to such a server unchanged.

## UI priority update

Web is the intended primary human interface. Native TUI is interim/emergency
access, not a mandatory simultaneous client. OPTIONS.md compares a TUI bridge,
a native RPC host with a basic emergency terminal client, and exclusive stock
RPC/TUI modes. Full native TUI parity should not inflate the emergency client.

Switching stock modes is a cold runtime replacement, not live attachment. Pi
transcripts can preserve history if enabled, but live tools/queues and an
in-memory registry do not transfer automatically. Ordinary client reconnect
must still preserve the running owner. No handoff has been runtime-tested.

## Interfaces

| Interface | What it controls | Tradeoff |
|---|---|---|
| Native RPC | Long-lived Pi subprocess; prompt, steer, follow-up, abort, state/history, streaming events | Built in and independently killable; private stdio transport, not a multi-client network service. |
| SDK | In-process AgentSession objects with direct methods/subscriptions | Least IPC for a TS host; cooperative cancellation and shared failure domain. A network API is the host's responsibility. |
| ACP adapter | Pi through a standard agent-client protocol | Existing ACP clients can be reused; adapter/version/capability differences and persistence policy need checking. |
| Extension bridge | The SAME runtime already running a native Pi TUI | Add live command/event transport using public extension APIs; preserve native terminal UI, but host lifetime is still tied to that process. |
| Print / JSON modes | A single invocation | Simple batch output; not the ongoing steering/control path required here. |

Terminal keystrokes/screens are a separate automation interface, not the chosen
structured control protocol. MCP support in Pi is not itself a server exposing
Pi's conversation/runtime to external clients.

RPC/ACP schemas are APPLICATION traffic, not automatically model prompt content.
Keep a compact model-tool facade regardless of the internal protocol selected.

## Why native RPC is simpler for our Pi-only case

The inspected `svkozak/pi-acp` adapter runs this stack:

```text
ACP client -> ACP adapter -> Pi native RPC -> Pi runtime
```

Using native RPC removes one translator and keeps Pi's exact steering/lifecycle
semantics. Pi also exports a typed `RpcClient` and checked client examples.

This is not a universal verdict against ACP. If the target is Zed or another
already-built ACP frontend, implementing native Pi support there may be MORE
work than using the adapter. ACP itself does not require a state directory.

The PARTICULAR adapter inspected here creates persistent Pi sessions and saves
`~/.pi/pi-acp/session-map.json`. Its spawn parameters expose cwd, piCommand, and
sessionPath, not a no-session switch. It is therefore not an unchanged fit for
our in-memory runtime requirement. Another adapter or a modification could have
a different policy; do not attribute this requirement to ACP as a standard.

Snapshot: `svkozak/pi-acp` commit
`04d0a15d6bb42bb65cce5c9caedcdcb2cdcb6905` (2026-10-05).
Source: `src/pi-rpc/process.ts`, `src/acp/session.ts`,
`src/acp/session-store.ts`, and its README. No runtime compatibility test with
Pi 1.4.0 performed.

## Existing Pi TUI in Docker: can a web UI connect?

Not automatically to an unmodified stock TUI. Docker changes process/network
access, not Pi's application interface.

Two different integrations are possible:

1. **Browser terminal:** attach to the same tmux/PTY session. This mirrors the
   terminal, including its input/focus/resize behavior; it is NOT a structured
   conversation/dashboard API. Do not make it the agent-control path.
2. **Structured web bridge:** a Pi extension forwards events and state, and
   routes authenticated browser commands to that same runtime. Native TUI and
   browser can both remain usable. `pi-agent-dashboard` demonstrates this with
   an extension's WebSocket connection and prompt/steer/abort routing.

Our worker blueprint currently runs native Pi in tmux with no HTTP service or
published application port. A bridge needs a reachable, authenticated route
(for example an outbound connection to a dashboard host); it does not require
an application port on every child merely to send events.

Opening the same history with `pi --session ...` or starting another Pi using
`docker exec` creates/reopens a runtime. It does NOT attach to the existing live
one. Never use a second session-file writer as a substitute for live attachment.

## Server-first: terminal and browser clients at the same time

The preferred deployment keeps ownership inside each worker container. The
user also explicitly accepts a native Pi TUI in tmux exposing a bridge server
if that is simpler. The fully headless-host variant is shown here; it is not an
implementation or transport selection:

```text
Terminal client ----+
                    +---- in-memory owner/service ---- Pi runtime(s)
Web client ---------+                 |                 via RPC (or SDK)
                                      +---- state/events to both clients
```

The owner serializes/routes commands, retains bounded state/history for late
observers, and fans out observations. Multiple observers must not become
multiple competing readers/writers of a worker's raw stdio. Permission/dialog
responses also need one designated responder rather than duplicate answers.

This does not require the removed experimental pi-server. A host can use the
supported RPC subprocess interface or SDK. Server lifetime and persistence are
separate: a service can own entirely in-memory state.

The missing stock feature is the native TUI as an independently attachable
remote client. `InteractiveMode` currently expects an `AgentSessionRuntime`
with a local `AgentSession`; the CLI selects it OR `runRpcMode`. It has no
built-in remote connection mode. Supporting that experience requires a custom
terminal client or an adaptation of Pi's TUI/runtime boundary.

There is an official basic RPC TUI example: `examples/rpc-extension-ui.ts`.
It proves structured terminal rendering and dialog responses are possible, but
it currently SPAWNS its own child; it is not a ready-made shared-server attach
client. Public message/tool components may also be reused. Full native TUI and
arbitrary extension-UI parity must not be assumed: RPC does not serialize custom
TUI components, footers, editor implementations, etc.

The wider search found Un Bien's `unbien-cli`, an actual attachable terminal
client using Pi's `AssistantMessageComponent`, `UserMessageComponent`, and
`ToolExecutionComponent`. It speaks its own bridge/relay contract, not stock
Pi RPC, so adaptation is required. This reduces the presentation work compared
with a from-scratch terminal client; it does not make stock Pi a remote client.
See LANDSCAPE.md for pinned implementation sources.

## IPC in the earlier blueprint

Source checked: the shared blueprint's container startup, interactive, and
network helper scripts.

Current startup launches native Pi in tmux and exits when that tmux session
ends. `attach` enters the same tmux session; readiness also checks tmux. The
headless-server variant instead makes server lifetime/readiness authoritative,
and `attach` would launch/connect a client, not start another agent. The
TUI-hosted bridge variant can preserve tmux lifetime/attachment and add endpoint
readiness; it need not replace the native terminal frontend.

There are TWO transport boundaries, not one protocol choice:

| Boundary | Smallest candidate | Status |
|---|---|---|
| Container owner -> Pi parent/subprocess workers | Native Pi RPC over stdio | Proposal; uses the existing protocol and hard-killable processes. |
| TUI/GUI -> container owner | JSON commands/events over WebSocket | Proposal; one browser-compatible connection can carry control and observations. |

HTTP commands + SSE updates is another reasonable client transport. Unix
sockets or a Docker-exec stdio relay preserve a private local access path, but
browsers still need a gateway/adapter. Do not implement all transports up front.

A TUI client could initially run INSIDE the container via `docker exec` and
connect to its local server. That preserves no-host-port terminal attachment;
the client process may exit without terminating the server or Pi runtime.

A later web gateway can reach worker endpoints on `myb-workers-network` using
Docker DNS; every container may use the same internal port. This does not need
host port allocation per worker. A host browser does not resolve Docker DNS
automatically: it needs a reachable authenticated gateway, tunnel, or explicit
publication. No gateway/listener/port has been configured by this research.

Introducing a network control endpoint changes today's Docker-daemon-only
attach authorization. Network membership alone must not be treated as user
authentication: other members can directly contact each worker. Authenticated
access and a deliberate bind/proxy policy are required.

## Native pi-server status: rechecked against current upstream

The user correctly remembered a REAL native server addition and subagent
references to it. It was not merely a similarly named third-party package.

- Native `packages/server` was still being developed on October 1, 2026 (the
  experimental client/server was ported to pi-durable then).
- Commit `7472cda0d6e51dfbf53c03f46b47aa42ac64bf64`, October 12, removes that
  server/client/protocol stack. Pi 1.2.0 documents the removal.
- Current upstream main checked at `6291b9bcc3ee9480c2caba8676fc2f6cd321eaa9`
  has no server/client/protocol packages. Latest GitHub release checked remains
  1.4.0, October 21. Do not infer current availability from cached search hits
  that still display the old `packages/server/README.md` at a `main` URL.
- `nicobailon/pi-subagents` really did bundle the native pi-server as a workaround
  for a Pi 0.85.0 packaging issue. Its 0.68.0 changelog (September 15) says that
  copy was dropped because Pi 0.85.1 supplied it. Current source checked at
  `a37a28853822d470d15ae1764c97aed258087699` does not declare that dependency.

Separately, `marcfargas/pi-server` is an alpha third-party RPC/WebSocket wrapper
with its own Ink TUI. At `5b5424c89f95acb973a59bc1424c5da2a1821252`, its actual
`ws-server.ts` rejects a second simultaneous client. It is not the native server
and not an unchanged fit for concurrent terminal/web access. No runtime test.

## TUI-hosted control server: lower-change alternative

```text
worker container / persistent tmux
  Pi parent + bridge extension
    + native Pi TUI (human attaches through tmux)
    + structured socket/WebSocket endpoint (GUI / remote controls)
    + in-memory child registry -> RPC subprocess workers
```

This keeps the existing full terminal frontend without forcing automation to
use it. The distinction between control and observation is a logical API
boundary, not a requirement that the native UI and runtime occupy different
processes. Terminal detach leaves Pi and its endpoint alive; `/quit` does not.

Public APIs cover the important slice: `pi.on()` for message/tool/lifecycle
events; read-only session projections/entries for snapshots;
`pi.sendUserMessage(..., {deliverAs: "steer" | "followUp"})` for input; `ctx.abort()`
for cooperative cancellation. Model/thinking/tool controls also have public
methods. No private AgentSession cast is required for that slice.

Do NOT run stock `runRpcMode()` alongside the TUI: both own process I/O. This
extension exposes a separate transport and deliberately mapped control subset,
not automatically the complete stock RPC command surface. Session navigation
and replacement need command-capable contexts; arbitrary session/UI parity
cannot be promised from a plain event context.

Lifecycle caveats: start the endpoint on `session_start`, dispose idempotently
on `session_shutdown`, and explicitly handle `/reload` and session replacement.
The endpoint shares Pi's event loop/failure domain. If the parent process hangs,
its bridge may hang too; Docker remains the out-of-process stop boundary.
A bridge itself need not register ANY model-facing tools. Only the compact
delegation facade contributes model schema overhead.

## Practical distinction

- **Preserve native Pi TUI today + add web:** bridge extension is the smaller
  adaptation; native Pi remains the runtime owner.
- **Independent terminal and browser clients of a headless owner:** server-first
  fits the desired separation, but a terminal frontend is additional work.
- **Subagents controlled by the parent:** native RPC works without either UI.

This is a hosting/client decision, separate from selecting RPC vs ACP. Neither
protocol automatically provides multi-client discovery, parent-child rosters,
network authentication, or a ready-made dashboard.

## Sources

- [Pi 1.4.0 RPC](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/rpc.md)
- [Pi CLI integration](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/cli-integration.md)
- [Pi SDK](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/sdk.md)
- [RPC TUI example](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/examples/rpc-extension-ui.ts)
- [RPC UI limitations](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/rpc-extension-ui.md)
- [ACP protocol overview](https://agentclientprotocol.com/protocol/overview)
- [Native server removal commit](https://github.com/earendil-works/pi/commit/7472cda0d6e51dfbf53c03f46b47aa42ac64bf64)
- [Pi 1.2.0 removal notes](https://pi.dev/changelog/releases/1.2.0#removed)
- [Subagent native-server history](https://github.com/nicobailon/pi-subagents/blob/a37a28853822d470d15ae1764c97aed258087699/CHANGELOG.md#0680---2026-09-15)
- [Third-party server single-client restriction](https://github.com/marcfargas/pi-server/blob/5b5424c89f95acb973a59bc1424c5da2a1821252/packages/server/src/ws-server.ts#L97-L104)
- [Pi extension API/lifecycle](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/extensions.md)
- [Pi ACP adapter](https://github.com/svkozak/pi-acp/tree/04d0a15d6bb42bb65cce5c9caedcdcb2cdcb6905)
- [Dashboard bridge overview](https://github.com/BlackBeltTechnology/pi-agent-dashboard/blob/400cfca993225dd2a3d761caea30a4d39166f1e0/packages/extension/README.md)
- [Dashboard bridge command routing](https://github.com/BlackBeltTechnology/pi-agent-dashboard/blob/400cfca993225dd2a3d761caea30a4d39166f1e0/packages/extension/src/command-handler.ts#L940-L990)

Local runtime/mode declarations inspected under the installed 1.4.0 package.
Docker worker configuration verified from `workers/README.md`, not from a live
container inspection. Existing dashboard source review is evidence of its
bridge architecture, not a production stability or drop-in compatibility claim.
