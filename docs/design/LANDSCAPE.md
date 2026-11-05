# Pi session hosts, bridges, and remote clients: wider landscape

Checked: 2026-11-01
Status: research, not a selected architecture or installation recommendation.
Requirements: [FEATURES.md](FEATURES.md). Snapshot inventory: [IMPLEMENTATIONS.md](IMPLEMENTATIONS.md).

## TLDR: what the wider search changed

We should evaluate existing hosts/clients before building our own server or UI.
The useful new candidates are not mainly subagent extensions:

| Need | Most useful reference | Important qualification |
|---|---|---|
| Web-first host with parent/child sessions | **jmfederico/pi-web** | Separate session daemon, SDK runtimes, substantial persistent application state |
| Server-owned, independently killable Pi processes | **milanglacier/pi-tau-web-server** | Already a web UI plus native-RPC host; default persistence/auth/cleanup policies need review |
| A frontend independent of SDK versus RPC | **laurentftech/pi-outpost** | Explicit runtime/capability boundary; not already our multi-child owner |
| Attachable, Pi-like emergency terminal | **georgeharker/un-bien** | Uses Pi's own renderers; speaks its own bridge/relay protocol, not an unmodified native TUI |
| Existing parent TUI plus structured endpoint | **vanillagreencom/kendex: pi-session-bridge** | Public-API bridge; filesystem discovery/history and tmux-only command fallbacks need adaptation |
| No inbound worker listener | **pi-agent-dashboard / reverse relays** | Outbound connection to a relay; security/discovery are explicit contracts |

**Most important correction:** a native Pi TUI cannot attach to a remote runtime
unchanged, but attachable terminal clients and reusable Pi renderers already
exist. "We must build a replacement terminal UI from scratch" is too pessimistic.

**Most important non-correction:** putting WebSocket around native RPC does not
by itself provide session ownership, multiple clients, child discovery, or
safe reconnect. Those are small but real host responsibilities.

## Scope and evidence

This pass used 22 saved discovery searches, npm registry metadata, public source
snapshots, and the installed Pi 1.4.0 implementation. The local inventory now
contains 55 repository snapshots, including previous candidates, an index, and
our own terminal project, plus four extracted published npm packages. These
are NOT 55 independent implementations, nor 55 complete code/security audits.
Identical names do not establish either shared ancestry or compatibility.

[IMPLEMENTATIONS.md](IMPLEMENTATIONS.md) distinguishes relevant code inspection,
earlier source review, and README-only screening. Links are pinned to the
inspected commits/versions. Scratch material and full hashes are in
`tmp/pi-subagents-design/landscape/`, especially
`source-snapshots-2026-11-01.json`.

No dependencies were installed, no third-party implementation was executed,
and no worker/server/networking configuration was changed. A source check can
establish architecture and obvious boundary problems, not production stability
or compatibility with our models/extensions. This is a broad discoverable
landscape, not a claim to enumerate every private or unindexed project.

## 1. Existing web hosts are more relevant than we assumed

### jmfederico/pi-web: a session daemon behind the web process

Snapshot: `8646931`, package `1.202610.9`; dependency targets Pi `^1.4.0`.
This is NOT the previously reviewed `agegr/pi-web`.

Its architecture separates the web/API frontend from `sessiond`, which owns
live SDK runtimes. The internal daemon endpoint defaults to HTTP over a Unix
socket; TCP can be configured. Browser lifetime is not session lifetime.

Tracked children are ordinary sessions in the same service, not hidden jobs:

- `spawn_subsession` returns a child identity and lets the parent continue.
- The human can open the child using the existing conversation UI.
- The parent has explicit list/check/read/stop/resume/join operations.
- Completion delivery hooks into safe turn/settlement boundaries. A manually
  stopped or failed parent is not automatically resumed by that hook.
- Notices deliberately report lifecycle, not unconditionally "task succeeded".
  Results/transcripts are inspected separately.
- Its own delegation tools are gated by creation provenance, including tracked
  children. Other inherited extension/MCP tools still need a separate audit.

This is the closest newly found **whole-product** reference for our workflow.
The separate daemon also means a web frontend restart need not restart agents.

**Do not adopt unchanged:** SDK children share the daemon's failure domain;
there is no independent process kill per SDK session. Projects, archives,
unread state, owner markers, and child relationships have persistence policies.
The model surface also includes more management/inspection tools than we have
agreed to expose. Default unlimited-per-field transcript inspection is not our
context-budget policy. In-memory coordination is not established by its use of
an `active` Map; the surrounding durable services must also be accounted for.

**Borrow:** sessiond/web separation, children as first-class conversations,
explicit creation provenance, capability gates, and boundary-aware delivery.
Do not import its entire application/data layer just for delegation.

Sources: [session daemon][jmf-daemon], [daemon transport][jmf-transport],
[tracked-child lifecycle][jmf-children], [model facade][jmf-tools],
[completion delivery][jmf-delivery].

### Pi Tau Web Server: native RPC already behind a usable browser UI

Snapshot: `c1619a9`, package `1.1.10`; declared Pi range `>=0.86.0 <2.0.0`.

`LiveSessionManager` owns a Map of `PiRpcSession` objects/processes. Web clients
are a separate Set: removing a client does not terminate the sessions. It has
session creation/resume, event forwarding, state/snapshot routes, pending
command correlation, basic extension dialogs, and a PWA-style web frontend.
It uses `agent_settled`, not just the first `agent_end`, for terminal lifecycle.

This is much closer to our desired **container-local RPC session host** than a
per-browser stdio relay. It already demonstrates most of the web/RPC plumbing
we were discussing as hypothetical.

**Do not adopt unchanged:** persisted Pi histories/settings are part of its
product; child ownership/delegation is not automatically our contract. Auth is
optional and the documented default bind is all interfaces: configure auth,
private reachability, and TLS rather than treating Docker networking as auth.
Termination escalates signals to the direct child, not an explicitly created
process group. Our descendant cleanup and bounded-memory requirements still
need validation/adaptation.

**Borrow:** persistent process owner separate from subscribers, dialog lifecycle,
resume coalescing, and reusing a ready-made ordinary chat UI for each worker.

Sources: [live-session owner][tau-sessions], [server routes][tau-server],
[configuration/security][tau-readme].

### Pi Outpost: one frontend can use SDK or RPC honestly

Snapshot: `283d271`; server dependency targets Pi `^1.4.0`.

Outpost already implements the boundary we were reasoning toward:

```text
Browser protocol -> AgentRuntime -> embedded SDK OR native-RPC subprocess
```

The runtime provides a normalized snapshot, events, and commands. The RPC
adapter bootstraps before advertising readiness, retains an in-flight assistant
projection for late viewers, and fails closed on transport failure. It does
not silently replay a prompt or switch backends after a failure.

Capabilities are explicit: if a backend cannot implement a control, the server
reports that rather than silently pretending. Examples include provider login,
active-tool publication, tree navigation, and extension renderers. This is a
useful answer to "what do we lose with a custom API?": make the differences
observable, not a collection of undocumented no-ops.

`PiRpcProcess` separates framing, request correlation, deadlines, stderr tail,
stdin backpressure, and cleanup from the runtime's session semantics. Its
transport is useful source material, not a reason to build a universal backend
framework before we need one.

**Limits:** this inspected boundary serves the active runtime; it is not already
our multi-child registry. Process signaling is direct-child signaling, not a
complete descendant supervisor. The record limit is generous, not our chosen
memory budget. Persistence/resource policies still need review.

Sources: [runtime interface][outpost-interface], [RPC implementation][outpost-rpc],
[process transport][outpost-process].

## 2. Emergency terminal access does not require stock-TUI attachment

### Un Bien: use Pi's rendering components in an actual remote client

Snapshot: `d5695b1`; extension package `0.22.0`.

`unbien-cli` has a genuine attachable session client, event reducer, transcript
replay, input handling, and terminal rendering. Its renderer imports
`AssistantMessageComponent`, `UserMessageComponent`, and
`ToolExecutionComponent` from Pi. Built-in tool definitions are constructed for
rendering only; the client does not execute those tools locally.

The Pi extension supplies snapshots/events and routes accepted remote input
through `pi.sendUserMessage`. It explicitly acknowledges that this API returns
void: submission is not proof a model call started or completed.

**New option:** an emergency terminal client can preserve Pi-like message/tool
presentation without converting all of `InteractiveMode` into a network client.
We should evaluate reusing/adapting this approach rather than cost the UI as a
fresh terminal application.

**Limits:** its relay/session protocol is not native Pi RPC. The complete product
includes identity, pairing, mesh messaging, storage, browser/extension features,
and additional model tools. Native component reuse does not transport arbitrary
third-party TUI renderers, keybindings, editors, or extension closures. Reuse the
client/presentation pattern, not automatically the whole mesh stack.

Sources: [terminal rendering][unbien-render], [client/reducer][unbien-client],
[live extension/input semantics][unbien-extension].

### Other terminal and multi-runtime clients

- **jbn/piface:** another independent terminal frontend around Pi; useful
  evidence that CLI rendering/control can be separated from the agent. Do not
  infer shared-live-owner attachment merely from remote/SSH execution support.
- **Toad:** an existing ACP terminal UI, so ACP can save presentation work when
  that client is the target. It does not automatically make one Pi runtime
  available to both Toad and a browser.
- **rcarmo/vibes:** multi-agent web frontend with runtime-specific adapters. Its
  Pi path uses native Pi RPC; other agents use different adapters. This shows we
  do not need to force every runtime through ACP to share a human UI.
- **Harness Remote:** desktop/web/Android control plane using ACP for Pi and
  several other harnesses. Its documentation clearly distinguishes native
  session continuity from a live turn: gateway restart interrupts a turn; later
  resume is not preservation of the running process. Broad product, not a small
  in-memory component.

Pinned source links and review depth are in [the inventory](IMPLEMENTATIONS.md).

## 3. A native TUI plus a bridge remains a real, smaller alternative

### pi-session-bridge in Kendex

Snapshot: `923bb71`; npm package `@vanillagreen/pi-session-bridge`.

The implementation exposes Unix-socket JSONL commands and a structured event
stream from a running Pi extension, with a matching CLI. It uses Pi's public
send/abort/context APIs for the conversation slice; it does not reuse
`runRpcMode`'s internal dispatcher. Browser HTTP/WebSocket access would be an
additional gateway. This is a concrete example of the extension the user suggested.

**Important boundary:** some special slash/session operations use tmux dispatch.
That is not an acceptable general structured control path for our agents.
There are also file-backed endpoint discovery and retained-history features.
Those must be removed/replaced or explicitly excluded to meet F6.

Its installer appends management instructions to the system prompt. A bridge
with no giant JSON schema can still add context overhead: installation policy
matters as much as transport. The inspected instructions file is 3,165 bytes;
that is a byte count, not a measured token cost.

**Borrow:** small public-API control endpoint, command/event separation, bounded
history/backpressure handling, and a CLI for operator diagnostics. Do not copy
filesystem coordination or the keystroke fallback.

Sources: [bridge implementation][kendex-bridge], [package/installer][kendex-package].

### Related bridges clarify the tradeoffs

- **mitsuhiko/agent-stuff control extension:** small local-control precedent;
  useful when comparing a scoped bridge against complete RPC parity.
- **kkkiio/pi-web-ui:** live native-TUI mirror via an extension, with its own
  command/event mapping. Not the native dispatcher on a different port.
- **tdiam/pi-web:** much wider custom RPC-compatible adapter, live/SDK-owned
  session management, and browser UI. The adapter is thousands of lines; full
  compatibility and history/session management are not merely a socket wrapper.
- **carderne/pi-nvim / pi-live:** editor/live-control integration references,
  but session reach-through/non-public assumptions require version-specific
  scrutiny before using them as evidence of a supported extension API.
- **pi-beacon:** a much smaller read-only Unix-socket status surface. It
  distinguishes working, compaction, retry backoff, and settled idle. It is NOT
  a prompt/steer/abort server, and it still uses metadata files for discovery.

The bridge pattern is valid without a Pi core patch. The amount of code depends
on whether we expose the small useful slice or emulate every native RPC control.

## 4. Access topology: outbound relay or local listener plus tunnel

The existing pi-agent-dashboard bridge and the Clever Cloud extension demonstrate
Pi connecting outward to a dashboard/relay, rather than each UI dialing an
inbound listener in the Pi process. A relay can multiplex worker identities:

```text
Worker A: owner/bridge -- outbound authenticated connection --+
Worker B: owner/bridge -- outbound authenticated connection --+-- UI gateway
                                                            +-- browsers
```

This is compatible with either a TUI-hosted owner or a headless owner. It does
not require publishing a host port for each worker or exposing its private
stdio connection. It is especially useful across machines/NAT boundaries.

For our existing Docker network, one gateway reaching a fixed internal worker
port by Docker DNS is already an alternative with no per-worker host ports.
An outbound relay is therefore an option, not automatically fewer moving parts.

`@monopi/web-remote` is a DIFFERENT variant: it starts a local structured web
server and can expose that listener through a tunnel, with a hosted frontend.
Do not confuse an application relay with a reverse tunnel. Both are useful
inspirations, but have different discovery, deployment, and trust boundaries.

**Source-quality warning:** the published Clever Cloud remote-control extension
also uses this pattern, but models its Pi API loosely, calls optional
`pi.abort?.()` rather than current public `ctx.abort()`, and marks a question
hook unconfirmed. Its README calls history replay pending. Treat it as a
transport/pairing reference, not a validated complete Pi control interface.
Its broker/auth stack is also far beyond what our local containers require.

Sources: [existing dashboard bridge][dashboard], [monopi bridge][monopi-remote],
[published Clever Cloud source][clever-source].

## 5. Two less obvious options: ownership handoff and another client protocol

### Wherever: separate live bridge ownership from server-owned sessions

Snapshot: `5ffe02a`.

Wherever combines a server/web workspace with a native-CLI bridge and explicit
ownership/lifecycle handling. This is a more useful hybrid reference than
pretending every frontend is always interchangeable. Inspect its CLI bridge,
server session pool, and ownership rules separately.

**Borrow:** only one authoritative writer; distinguish a live CLI-backed
conversation from a runtime the server itself owns. If control changes hands,
make the transition explicit. Its persistence/locking machinery is not our
in-memory design, and no code review here proves lossless transfer of active
tools, extension closures, queues, or child handles.

Source: [Wherever snapshot][wherever].

### pi-codex-app-server: reuse an existing client ecosystem

Snapshot: `ea8902a`, package `0.1.2`.

This project projects Pi sessions onto Codex app-server JSON-RPC, over stdio or
a shared WebSocket daemon. It also implements an outbound remote-control path.
That is a genuine alternative to "write a new dashboard protocol": adapt Pi to
an existing frontend ecosystem instead.

**Limits are unusually explicit:** the daemon is currently the history writer;
live native-TUI ownership handoff is future work. It uses a SQLite metadata
sidecar and endpoint files. Codex-only methods can return schema-valid neutral
results; Codex sandbox/approval settings do not acquire real enforcement just
because the client accepts them. Linux remote-control support is documented
as experimental. These are significant mismatches, not a drop-in recommendation.

**Lesson:** protocol compatibility must distinguish unsupported, neutral, and
actually enforced behavior. Schema validity alone is not semantic parity.

Sources: [protocol/limitations][codex-readme], [live-session manager][codex-sessions].

### ACP remains worthwhile when the existing client is the saving

The inspected `svkozak`, `Attamusc`, and `georgeharker` Pi ACP projects differ
in their runtime/lifecycle and extension integration. Do not treat them as one
interchangeable package. ACP can unlock Toad, AoE, editors, or Harness Remote;
it does not add multi-viewer ownership or shared parent/child discovery by itself.
For our Pi-only custom host, native RPC still avoids an adapter. For an existing
ACP GUI/TUI, the adapter may cost less than implementing that UI.

## 6. Children should use the ordinary session viewer

**Pi Chamber** (`89e78d7`) makes delegated children real SDK sessions in its
normal roster, with live conversation frames and a child identity on the
parent's tool card. It returns conclusions/cost to the model, not the transcript.
This independently reinforces the pattern in jmfederico/pi-web and agegr/pi-web:
**build one conversation surface, use it for parent and child alike.**

But the inspected Chamber tool awaits the child run before returning, and uses
cooperative SDK abort. It is inspiration for visibility, not already our
nonblocking/hard-stop implementation. Likewise, a JSON subprocess's progress
is not inherently invisible: an owner can forward its events. That limitation
belongs to a particular adapter, not to subprocesses as a category.

Source: [Chamber subagent implementation][chamber-subagent].

Tintinweb's viewer/control manager and BlackBelt's resync/subagent timeline
contract remain relevant. A generic parent RPC endpoint will not automatically
publish those internal registries: they need an explicit serialized contract.

## 7. Attractive names that do not satisfy our ownership requirement

| Implementation/path | What the inspected version actually establishes |
|---|---|
| `tohlh/pi-rpc-web` | Native RPC relay, but a browser connection gets its own child; not attachment to the existing native TUI |
| `SkeLLLa/pi-ws` | Native-RPC subprocess per connection; WebSocket close calls `peer.close()` |
| `marcfargas/pi-server` | Standalone RPC wrapper; not the removed native server or a ready shared parent/child host |
| `myk-org/pi-sidecar` | HTTP API with in-memory SDK sessions; the basic request/response path alone is not a full streaming multi-observer UI |
| `@noahsaso/pi-remote` | PTY/xterm terminal access; `/remote` stops/restarts Pi, rather than adding structured access to the same live runtime |
| `deflating/tau` | Repository explicitly says the standalone app is retired; distinguish it from the separate Pi Tau Web Server |
| Old native `pi-server` / `mini` pages | Historical surfaces, not current Pi 1.4.0 server/client support |

These can still supply useful code. They should not be selected merely because
"RPC", "remote", "server", or "resume" appears in the name.

## 8. Invariants worth copying, regardless of implementation

1. **Ownership outlives viewers.** A browser reconnect must not spawn a second
   writer or terminate work. Multiple requesters need distinct request-ID
   correlation; command responses are not blindly broadcast as unowned events.
2. **Snapshot plus stream, including in-flight state.** An observer needs prior
   conversation, current partial assistant/tool state, and pending dialogs.
   Handle the subscribe/snapshot race and slow clients explicitly.
3. **Run outcome is not conversation lifetime.** Idle is not necessarily success;
   a prompt receipt is not completion; an accepted steering prompt is not proof
   the model consumed it. Preserve failure/stop reasons.
4. **Do not replay uncertain mutations.** Reconnect can request a snapshot.
   A lost prompt receipt is not authorization to run the task again.
5. **Stopping has layers.** Cooperative agent abort, queue clearing, retry
   cancellation, process termination, and descendant cleanup differ. Direct
   `child.kill()` is not process-group cleanup. SDK timeout is still cooperative.
6. **Dialogs are operational state.** Late clients need pending questions;
   disconnect/abort/session replacement must not strand their promises. Basic
   native RPC UI requests help, but arbitrary TUI components cannot cross it.
7. **Capabilities must be honest.** Public extension APIs, SDK access, native RPC,
   ACP, and custom projections have different controls. Refuse unsupported
   mutations; do not turn missing enforcement into a successful-looking no-op.
8. **Memory and context are separate budgets.** Bound raw records, retained
   transcript/results, stderr, pending requests, and observer queues. Keep GUI
   events out of parent context; measure tool schemas AND injected instructions.
9. **Discovery files are still coordination files.** A Map does not make an
   implementation F6-compatible if discovery, ownership, mailboxes, or recovery
   also depend on application files. Ordinary Pi transcripts remain a separate
   policy question, as recorded in FEATURES.md.
10. **Private network is not authorization.** An endpoint can operate tools with
    the worker's permissions. Configure authentication, origin/transport policy,
    and explicit controller identity; do not mistake a project-path selector for
    filesystem isolation.

## 9. Revised shortlist and what remains open

For the web-primary requirement, evaluate these THREE shapes rather than design
another protocol first:

| Shape | Reference implementation(s) | Why keep it | Biggest mismatch to resolve |
|---|---|---|---|
| Existing web/session product | jmfederico/pi-web | Most of parent/child workflow and human UI already exists | Persistent application state, SDK hard-stop boundary, model-surface size |
| Container-local RPC owner + views | Pi Tau Web Server; Outpost runtime; Un Bien renderer/client | Reuses native process control and existing UI work | Need coherent child registry, memory policy, cleanup, compatible client contract |
| Native parent in tmux + scoped bridge | Kendex bridge; dashboard/monopi | Keeps our current terminal workflow while web is built | Adapter maintenance, coordination-file removal, some controls unavailable through plain extensions |

The second row is a comparison of reusable pieces, NOT an instruction to combine
three products. Copying their separate protocols/lifecycle stacks would be more
complex than choosing one small host boundary.

**No winner is established by source review.** The useful next validation is a
single parent plus one addressable child in an existing candidate, then: open
mid-stream, steer, disconnect every UI, reconnect, inspect a failure, and stop
a deliberately stuck child including descendants. Also verify our configured
providers and loaded extensions without importing their whole tool catalog into
every child. Only then compare adaptation cost against a thin custom owner.

No native-TUI/core refactor, ACP layer, central broker, database, or full RPC
emulation should become mandatory before that comparison.

[jmf-daemon]: https://github.com/jmfederico/pi-web/blob/8646931f1e197672245100b7252dd7cbb17775fd/src/server/sessiond.ts
[jmf-transport]: https://github.com/jmfederico/pi-web/blob/8646931f1e197672245100b7252dd7cbb17775fd/src/sessiond/config.ts
[jmf-children]: https://github.com/jmfederico/pi-web/blob/8646931f1e197672245100b7252dd7cbb17775fd/src/server/sessions/piSessionService.ts
[jmf-tools]: https://github.com/jmfederico/pi-web/blob/8646931f1e197672245100b7252dd7cbb17775fd/src/server/sessions/spawnSubsessionTool.ts
[jmf-delivery]: https://github.com/jmfederico/pi-web/blob/8646931f1e197672245100b7252dd7cbb17775fd/src/server/sessions/subsessionCompletionDelivery.ts
[tau-sessions]: https://github.com/milanglacier/pi-tau-web-server/blob/c1619a96353924e90f001b4745fc967e5008c336/src/server/sessions.ts
[tau-server]: https://github.com/milanglacier/pi-tau-web-server/blob/c1619a96353924e90f001b4745fc967e5008c336/src/server/server-main.ts
[tau-readme]: https://github.com/milanglacier/pi-tau-web-server/blob/c1619a96353924e90f001b4745fc967e5008c336/README.md
[outpost-interface]: https://github.com/laurentftech/pi-outpost/blob/283d271d2c71b267b132177d0e44bce97c7c051c/server/src/agentRuntime.ts
[outpost-rpc]: https://github.com/laurentftech/pi-outpost/blob/283d271d2c71b267b132177d0e44bce97c7c051c/server/src/rpcRuntime.ts
[outpost-process]: https://github.com/laurentftech/pi-outpost/blob/283d271d2c71b267b132177d0e44bce97c7c051c/server/src/piRpcProcess.ts
[unbien-render]: https://github.com/georgeharker/un-bien/blob/d5695b10f05c86ae349c53967b3faa860446261c/unbien-cli/src/render.ts
[unbien-client]: https://github.com/georgeharker/un-bien/tree/d5695b10f05c86ae349c53967b3faa860446261c/unbien-cli/src
[unbien-extension]: https://github.com/georgeharker/un-bien/blob/d5695b10f05c86ae349c53967b3faa860446261c/extension/src/index.ts
[kendex-bridge]: https://github.com/vanillagreencom/kendex/blob/923bb71a1bf2b6477cdea6943fe0c71925204151/pi-extensions/pi-session-bridge/extensions/session-bridge.ts
[kendex-package]: https://github.com/vanillagreencom/kendex/tree/923bb71a1bf2b6477cdea6943fe0c71925204151/pi-extensions/pi-session-bridge
[dashboard]: https://github.com/BlackBeltTechnology/pi-agent-dashboard/blob/400cfca993225dd2a3d761caea30a4d39166f1e0/packages/extension/src/bridge.ts
[monopi-remote]: https://github.com/ifiokjr/monopi/blob/9c360bae1baa164fe21f5b0168c66565abcf6e27/packages/monopi__web-remote/index.ts
[clever-source]: https://unpkg.com/@clevercloud/pi-remote-control@0.1.5/dist/index.js
[wherever]: https://github.com/wighawag/wherever/tree/5ffe02a52077c3a81c8d2e61042f22254b698aab
[codex-readme]: https://github.com/Lqm1/pi-codex-app-server/blob/ea8902a36aacd74e9b3daa9a635a490233440a63/README.md
[codex-sessions]: https://github.com/Lqm1/pi-codex-app-server/blob/ea8902a36aacd74e9b3daa9a635a490233440a63/src/pi/live-session-manager.ts
[chamber-subagent]: https://github.com/WillianQ/pi-chamber/blob/89e78d7fa3edef442d50fc42c6c3b7dbdaf9af80/packages/server/src/agent-service/plugins/subagent.js
