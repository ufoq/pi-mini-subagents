# Pi subagents: research

Checked: 2026-11-01
Scope: agent-first delegation, occasional human observation/steering, future web
access to the same workers, in-memory runtime coordination.
Method: live search, source inspection, and installed CLI version checks.
No package installation, dashboard/service launch, or new model benchmark.
Cloned source snapshots and fetched pages are under `tmp/pi-subagents-design/`
(ignored by git). Findings below are not claims of production stability.

The broader follow-up is [LANDSCAPE.md](LANDSCAPE.md), with a source-pinned
[implementation inventory](IMPLEMENTATIONS.md). It adds existing web/session
daemons, RPC-process hosts, attachable terminal clients, small bridges, reverse
relays/tunnels, ACP clients, and alternative client protocols. In particular,
`jmfederico/pi-web` is a different project from `agegr/pi-web` below; Un Bien
already demonstrates remote terminal rendering with Pi components. The older
sections remain source findings, not an exhaustive current shortlist.

## Findings that change the discussion

1. A subagent must be an addressable conversation, not only a one-shot job.
   Task/run completion and conversation/session lifetime are different things.
2. Steering does not require the experimental pi-server. Supported CLI RPC and
   the SDK already expose it. Neither supplies a ready-made multi-agent web UI.
3. "Normal Pi TUI" has two meanings: attach the actual child terminal, or view
   the same live conversation through a Pi-like observer. Existing projects do
   both, with different costs.
4. A TUI overlay is not automatically a web feature. A separate access path must
   expose identity, snapshot/history, live updates, and input/control.
5. In-memory ownership is compatible with a web bridge or a separate host. It
   rules out file coordination, not networking or multiple viewers.
6. We may reuse existing work instead of inventing an entire hub. But the most
   relevant projects differ on persistence, process ownership, and contracts;
   combining packages is not automatically simpler than a small adapter.

## 1. Supported Pi primitives (installed 1.4.0)

### Experimental server versus supported interfaces

Pi 1.2.0 removed its unreleased experimental server/client/plugin stack and
stopped releasing `@earendil-works/pi-server`, `pi-client`, and `pi-protocol`.
This is stronger evidence than "it used to be experimental". It does NOT mean
that ordinary SDK or `pi --mode rpc` is experimental or removed.

Sources: [1.2.0 removal](https://pi.dev/changelog/releases/1.2.0),
[SDK](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/sdk.md),
[RPC](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/rpc.md).

### CLI RPC: a persistent, steerable worker process

- `pi --mode rpc --no-session` provides JSONL commands/events over stdin/stdout
  without a session file. Unlike print mode, it remains available for input.
- Commands include `prompt`, `steer`, `follow_up`, `abort`, `get_state`, and
  `get_messages`. Events include message/tool streaming and settlement.
- Acceptance of a prompt/steer is not proof the model has consumed it, nor proof
  that a task succeeded. Steering normally applies at an agent step boundary;
  it is not a mechanism for interrupting an unresponsive tool immediately.
- Core RPC controls ONE Pi runtime's active session. A worker registry and
  parent-child discovery are additional application capabilities.
- It is a private stdio connection to its owner, not a multi-client network hub.
  One owner can relay events and controls to multiple observers.
- Public `RpcClient` exists in 1.4.0, so a custom implementation need not invent
  every request/response method. Its default spawning/stopping code does not
  provide a process-group supervisor; hard-stop policy still needs attention.

### SDK: direct access to sessions

`createAgentSession`, `SessionManager.inMemory`, session subscriptions,
`prompt`, `steer`, `followUp`, and `abort` support an in-memory session owner.
This is the smallest data/control path. It shares the owner's event loop and
failure domain; cancellation is cooperative, not an independently killable
worker boundary. A hard-kill requirement cannot be satisfied by relabeling an
SDK session's status.

[Session persistence example](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/examples/sdk/11-sessions.ts),
[public RPC client](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/modes/rpc/rpc-client.ts).

### Exposing extension capabilities is not automatic

- `pi.events` is an in-process inter-extension bus. A bridge extension/SDK host
  can translate a defined request/event contract to a browser transport.
- Stock CLI RPC has a fixed command dispatch, not arbitrary extension methods.
  It does not automatically publish an extension's `list_children` or event bus.
- RPC's `ctx.ui.custom()` returns `undefined`; custom terminal components do not
  cross the wire. Some basic extension UI requests have RPC representations,
  which is different from rendering an arbitrary child-conversation overlay.
- Opening a session file in another Pi creates/reopens another runtime. It is
  NOT attachment to the live session that is currently using that history.
  Never design "observe" by starting another writer on the child's transcript.

[Extension bus example](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/examples/extensions/event-bus.ts),
[RPC mode implementation](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/modes/rpc/rpc-mode.ts),
[TUI API](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/tui.md).

## 2. tintinweb/pi-subagents: agent tools + a human observer

Snapshot: `f7cae2f2a327b0bef3380074c2f45b48a76e29e4` (2026-10-31).

- SDK child sessions; task tools and a navigable FleetView share the manager.
- Selecting a child opens its live conversation without replacing the parent
  session or pausing either agent. Viewer offers steering and stopping.
- `src/ui/fleet-list.ts` passes the SAME live session to `ConversationViewer`
  and routes input through `manager.steer(record.id, message)`.
- Cross-extension request/reply channels expose spawn, stop, consume, and steer
  over `pi.events`. This is explicitly NOT network or stdio RPC. Some payloads
  even carry functions/AbortSignals, so they cannot be forwarded verbatim as JSON.
- Its full product also has persisted transcripts, resume, roles, queues, and
  workflows. Those features are not requirements for our slice.

**Useful pattern:** one manager, model-facing controls, optional human viewer.
**Not established:** that its existing bus is sufficient for a complete remote
observer. Snapshot/transcript access and a serialization-safe external adapter
would still need checking. Do not equate "has RPC channels" with web-ready.

Sources: [FleetView docs](https://github.com/tintinweb/pi-subagents/blob/f7cae2f2a327b0bef3380074c2f45b48a76e29e4/README.md#fleetview),
[viewer wiring](https://github.com/tintinweb/pi-subagents/blob/f7cae2f2a327b0bef3380074c2f45b48a76e29e4/src/ui/fleet-list.ts#L395-L449),
[bus contract and limitations](https://github.com/tintinweb/pi-subagents/blob/f7cae2f2a327b0bef3380074c2f45b48a76e29e4/docs/rpc.md).

## 3. BlackBeltTechnology/pi-agent-dashboard: bridge an existing Pi TUI

Snapshot: `400cfca993225dd2a3d761caea30a4d39166f1e0` (2026-11-01), package 0.11.0.

- Bridge extension runs in an existing Pi session, forwards structured events
  to a separate dashboard server, and routes browser commands back to Pi.
  Unlike a web-only session host, it can coexist with the normal terminal UI.
- Subagent lifecycle channels are explicitly subscribed to and forwarded. Its
  subagents plugin also declares ordered per-entry and live-block delta streams.
- A `subagent_resync_request` asks the owning bridge for its retained snapshot:
  opening an inspector after launch need not miss the previous conversation.
- Bus forwarding is an explicit contract, not magic wildcard interception.
  Arbitrary extension widgets and private state are not automatically exposed.
- Inspector expects producer `@blackbelt-technology/pi-dashboard-subagents`
  (per-entry/delta contract >=0.4.0), NOT arbitrary subagent extensions. Similar
  lifecycle channel names do not prove drop-in tintinweb compatibility.
- This is a large platform: a separate server, preferences/metadata on disk,
  historical discovery, auth, plugins, Electron, and more. Borrowing its bridge
  pattern does not require adopting all that. Inspection here verified the
  bridge/observer paths, not every child-specific control end to end.

**Useful pattern:** TUI remains usable; an adapter exposes the SAME owner to a
web frontend. This directly addresses "through main Pi" without pi-server.

Sources: [overview](https://github.com/BlackBeltTechnology/pi-agent-dashboard/blob/400cfca993225dd2a3d761caea30a4d39166f1e0/README.md),
[event forwarding](https://github.com/BlackBeltTechnology/pi-agent-dashboard/blob/400cfca993225dd2a3d761caea30a4d39166f1e0/packages/extension/src/flow-event-wiring.ts),
[resync/control dispatch](https://github.com/BlackBeltTechnology/pi-agent-dashboard/blob/400cfca993225dd2a3d761caea30a4d39166f1e0/packages/extension/src/bridge-handlers/dispatch.ts#L382-L427),
[subagent stream declaration](https://github.com/BlackBeltTechnology/pi-agent-dashboard/blob/400cfca993225dd2a3d761caea30a4d39166f1e0/packages/subagents-plugin/src/bridge/index.ts).

## 4. agegr/pi-web: web host owns parent and children

Snapshot: `d128bae47cd3abbdfe7135443ac793f547c14e47` (2026-10-29).
There are multiple unrelated projects named pi-web; this section is this repo.

- Despite the `rpc-manager.ts` name, this version creates SDK sessions in the
  web process. Its controller registers each child in the same session registry
  as ordinary chats, so the UI can view the child as a real session.
- It exposes child GET/status and POST steer/abort routes, and session event
  streams over SSE. Reusing the ordinary conversation surface avoids a wholly
  separate worker viewer.
- Stream setup subscribes before publishing its streaming-message snapshot and
  buffers intervening events; backpressure can disconnect and re-snapshot a slow
  observer rather than retain an unbounded queue.
- It requires a persisted parent session, appends child metadata/results to Pi
  history, and can reopen histories. Not an in-memory-only drop-in.
- The inspected child setup accesses parent `modelRuntime` via an `unknown`
  cast. Do not copy that as though ExtensionContext had a public runtime field.
- Loading an existing CLI history here is not proof of attaching its currently
  running TUI process. The web host owns the live SDK objects it controls.

**Useful pattern:** children are ordinary sessions in one owner, so ordinary
chat/stream/control UI can be reused. **Mismatch:** hosting/persistence and a
private-field access; no independently killable child in this path.

Sources: [runtime](https://github.com/agegr/pi-web/blob/d128bae47cd3abbdfe7135443ac793f547c14e47/lib/subagent-runtime.ts#L423-L440),
[child registration](https://github.com/agegr/pi-web/blob/d128bae47cd3abbdfe7135443ac793f547c14e47/lib/subagent-runtime.ts#L604-L619),
[child routes](https://github.com/agegr/pi-web/blob/d128bae47cd3abbdfe7135443ac793f547c14e47/app/api/subagents/%5Bid%5D/route.ts),
[SSE snapshot/stream](https://github.com/agegr/pi-web/blob/d128bae47cd3abbdfe7135443ac793f547c14e47/lib/agent-event-stream.ts).

## 5. HazAT/pi-interactive-subagents: actual child terminals

Snapshot: `c100577ebf7393a11d098ad9810ec6c269dcfc30` (2026-05-13).

- Launches real interactive Pi instances in supported multiplexer backends.
  Human interaction is the actual child TUI, not a reimplemented transcript UI.
- Parent-side orchestration watches session histories and `.exit` sidecars;
  child extension records atomic activity snapshots in files. Completion/help
  tools write sidecars and shut the child down; some modes also auto-exit.
- This proves the terminal-first interaction, but its file-based coordination
  conflicts with our no-state-directory requirement. Replacing that path with
  live IPC would be new work, not a configuration toggle.

**Useful pattern:** literal native TUI access. **Tradeoff:** parent supervision
and dashboard discovery still need structured signals, not screen scraping.

Sources: [project](https://github.com/HazAT/pi-interactive-subagents/tree/c100577ebf7393a11d098ad9810ec6c269dcfc30),
[child completion](https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/subagent-done.ts),
[activity files](https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/activity.ts).

Our own `agent-terminal` was subsequently source-reviewed from a private
development repository at
`5eb3b27008880510327e7e9cf7cacd39d0cb6fc6` (v0.1.6). It already handles terminal
hosting, ownership, input, and pane cleanup. It does not expose Pi settlement,
a lossless event stream, public human attach, or web control, and unconditionally
uses file-backed terminal metadata. See [AGENT-TERMINAL.md](AGENT-TERMINAL.md)
for reuse details and the native-TUI + structured-live-bridge alternative.

## 6. Agent of Empires: terminal and structured paths are different

Snapshot: `ee916d9640b6cf51aadf7f766b3b285fd9a461ff` (2026-10-31).

- Terminal path exposes real tmux-backed sessions. Current web rendering uses
  `pipe-pane` into a VT grid where available, with capture-pane fallback, plus
  input/control. It is NOT simply an xterm.js attach implementation.
- Its terminal automation API documents status/screen polling and taking the
  trailing screen as the reply. That is insufficient as authoritative task
  completion for the parent-agent workflow we want.
- Structured path uses ACP adapters and detached session workers; Pi uses
  `pi-acp` (adapter dependency pinned to 0.0.34 in this snapshot).
- Web and native clients receive control-state projections, transcript snapshot
  + deltas, and use server-side prompt dispatch. That is the useful separation:
  runtime owns the state; UIs observe and control it.
- Worker records/sockets/logs, persisted event history, daemon reattachment, and
  recovery policies make this much larger than an in-memory extension registry.
- Supporting Pi through ACP does not automatically discover children launched
  by arbitrary Pi extensions; child relationships/events still need integration.

**Useful patterns:** one owner and multiple observers; distinguish native
terminal access from structured agent control. Do not adopt its persistence and
worker-supervisor machinery unless those requirements are actually ours.

Sources: [terminal view](https://github.com/njbrake/agent-of-empires/blob/ee916d9640b6cf51aadf7f766b3b285fd9a461ff/docs/guides/web/terminal.md),
[structured ownership and projections](https://github.com/njbrake/agent-of-empires/blob/ee916d9640b6cf51aadf7f766b3b285fd9a461ff/docs/development/internals/structured-view.md),
[terminal subagent automation](https://github.com/njbrake/agent-of-empires/blob/ee916d9640b6cf51aadf7f766b3b285fd9a461ff/docs/api.md#driving-a-session-as-a-subagent),
[Pi ACP dependency](https://github.com/njbrake/agent-of-empires/blob/ee916d9640b6cf51aadf7f766b3b285fd9a461ff/acp-worker/adapters/pi-acp/package.json).

## 7. OMP: shared registry plus local/remote adapters

Source verification caveat: `omp --version` reports 17.2.11, but the separately
readable Bun-global source tree has package metadata 17.0.5. The inspected
`agent-registry.ts` and `collab/host.ts` match upstream tag v17.0.5 byte-for-byte,
not v17.2.11. These claims are pinned to THAT source, not assumed executable
internals. The earlier discussion did not distinguish these installations.

- In-memory registry holds live sessions, status, identity, and parentId.
- Local hub and remote collaboration access the same registry. The host mirrors
  roster snapshots and handles chat/kill/revive commands; chat ensures the
  session is live, then prompts it with steering behavior.
- Conversation observation uses transcript files. Park/revive also needs saved
  sessions, so OMP is not a wholly memory-only implementation of our requirements.
- Its agent hub is not the separate shell-process launch broker.

**Useful pattern:** central identity/control shared by model tools, local hub,
and remote access. Not a reason to copy OMP's lifecycle/IRC/broker subsystems.

Sources: [registry v17.0.5](https://github.com/can1357/oh-my-pi/blob/v17.0.5/packages/coding-agent/src/registry/agent-registry.ts),
[collaboration host](https://github.com/can1357/oh-my-pi/blob/v17.0.5/packages/coding-agent/src/collab/host.ts#L556-L668).

## 8. RPC/ACP and simultaneous native TUI/web access

Follow-up inspection is in [INTERFACES.md](INTERFACES.md).

- Native RPC is the smaller custom Pi-only integration. The inspected
  `svkozak/pi-acp` at `04d0a15d6bb42bb65cce5c9caedcdcb2cdcb6905` adds an ACP-to-Pi-RPC
  translator and defaults to persistent sessions plus a session-map file.
  ACP can still reduce total work when an existing ACP client is the target.
- A bridge extension can expose a native Pi TUI's SAME runtime to a structured
  web UI; pi-agent-dashboard is evidence. Docker does not create that interface
  automatically, and our current worker blueprint has no HTTP endpoint.
- A headless owner can serve terminal and browser clients concurrently, but
  stock Pi 1.4.0 has no native `serve`/`connect` pair. Its InteractiveMode expects
  a local AgentSessionRuntime, not a remote RPC endpoint. A custom terminal
  client/adapter is needed; the official basic RPC TUI example is a starting
  point, not a shared-server attach implementation.
- Neither RPC nor ACP automatically supplies multi-client sharing, discovery,
  authentication, or parent-child inventory. Those are owner responsibilities.
- Follow-up verification confirms the user's native pi-server memory: it did
  exist upstream and nicobailon's subagents bundled it for a Pi 0.85.0 packaging
  workaround. Native commit `7472cda0d6e51dfbf53c03f46b47aa42ac64bf64` removed the
  stack on October 12; current upstream main and latest release 1.4.0 have not
  restored it. Exact references and cached-search caveat are in INTERFACES.md.
- Keeping the parent native TUI in tmux plus a structured bridge is explicitly
  acceptable if simpler. Public extension APIs cover input/steering, abort,
  snapshots, and live observations without a private session cast. This is a
  scoped endpoint, not stock stdio RPC running simultaneously with the TUI.

## Context-economy implication (added requirement)

The rich surfaces above are NOT a proposed tool catalog. An owner's internal
API, a human viewer, and a dashboard transport can expose much more than the
model sees. Keep the delegation/control definitions small; snapshots and stream
subscriptions belong to observers, not automatically to the parent conversation.

A bounded model-requested inspection and a brief completion notice serve a
different purpose from the full human transcript. Reusing one giant payload for
all three would bloat context. Also audit child resource/tool inheritance:
loading every parent extension/MCP into every child repeats schema costs and
can introduce recursive delegation. None of the inspected projects was
benchmarked here for actual per-request schema/instruction token overhead.

## What remains unverified

- End-to-end integration of any chosen combination with our loaded extensions,
  models, and a specific dashboard; source review is not an integration test.
- Exact native-TUI fidelity of an extension-based observer versus a child Pi.
- Which existing package permits the desired memory/persistence policy without
  forking or taking on substantial unrelated behavior.
- Process-death and UI-disconnect policy, completed-child follow-up, capability
  inheritance, and automatic parent continuation: product decisions, not facts
  research can choose on the user's behalf.

See FEATURES.md for needs and OPTIONS.md for the smallest plausible solutions.
