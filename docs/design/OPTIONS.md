# Pi subagents: simplest-solution shortlist

Research snapshot: 2026-11-01
Status: historical options, not the current decision list. Our own extension
with exclusive native TUI/RPC parent modes and persistent RPC children is now
selected. The user subsequently requested a minimal steerable/observable v1,
without concurrency/budget/permission/lifecycle policy machinery. Current
scope is in DEFAULTS.md and FEATURES.md; it supersedes open questions and
recommendations below. Source evidence and caveats remain in RESEARCH.md.
The wider implementation survey is in [LANDSCAPE.md](LANDSCAPE.md), with pinned
sources and review depth in [IMPLEMENTATIONS.md](IMPLEMENTATIONS.md).

## Agreed boundary: control and observation, not terminal automation

We want live, addressable worker conversations. A delegated task is a run inside
one of those conversations, not necessarily the conversation's entire lifetime.

- Control sends structured prompts/steering/cancellation through RPC or ACP.
- Observation exposes structured messages, tools, and lifecycle state.
- Main Pi's human viewer and future dashboards render those observations; their
  input composers send commands through the same control path as the agent.
- No attached terminal, screen scraping, or human viewer is required to operate
  workers. Native child Pi terminals are no longer a core requirement.

These are responsibilities, not separate services. One protocol connection and
one in-memory owner can handle both. Do not add a broker or event framework just
because the diagram separates commands from observations.

## The small common requirement, not a framework

All credible solutions need ONE authoritative owner for each live conversation.
The parent agent, human viewer, and future dashboard must reach that same owner:

```text
Parent agent -- small tool surface --+
                                    |
Human in main Pi -- viewer ---------+-- owner / in-memory registry -- workers
                                    |
Future dashboard -- adapter --------+
```

This is a responsibility diagram, not a module/protocol specification. The
preferred deployment now puts the owner inside each worker container, owning
its parent and children independently of TUI/GUI connections. A central daemon
is not required. Storage remains in memory; UI independence does not imply crash
recovery. See INTERFACES.md for existing blueprint integration and transports.

The viewer needs an initial conversation snapshot plus live updates. Controls
must target the existing worker. Neither `pi --resume <file>` nor copying
messages into another session is live attachment.

The user explicitly accepts keeping the native parent Pi TUI in tmux with a
bridge extension acting as the control endpoint if simpler. That preserves our
current terminal attachment while a GUI uses structured control/events. It does
not require TUI automation or an interactive pane per subagent. Compared with a
headless host, it saves terminal-client work but shares the parent's failure
and extension-reload lifecycle. See INTERFACES.md; this is an implementation
candidate, not a blueprint change.

## Protocol choice still open: native Pi RPC or ACP

- **Native Pi RPC:** first candidate for Pi-only workers; existing prompt,
  steer/follow-up, abort, messages, and streaming events. No ACP adapter needed.
- **ACP:** candidate if cross-agent interoperability is needed. Verify the
  chosen Pi adapter's steering, task lifecycle, tool output, and history
  capabilities rather than assuming protocol-level support guarantees parity.
- Do not implement both or invent a universal transport interface up front.
  The selected worker protocol does not automatically expose the main owner's
  child registry to a dashboard; that host integration is separate.

## Parent UI/hosting choices: web primary, terminal interim/emergency

These are independent of the child-runner alternatives below. Full native TUI
parity is no longer a prerequisite for the server-first design.

| Choice | What it buys | Actual cost / limitation |
|---|---|---|
| Native parent TUI in tmux + compact bridge | Existing terminal works now; GUI can control the same live parent | Own command/event adapter; native RPC dispatcher is not exposed to extensions. Queue/retry controls and dialogs need special attention. |
| Native RPC host + web + basic terminal client | Reuse built-in RPC semantics; emergency client reaches the SAME live runtime | Client adaptation remains, but Un Bien already demonstrates attachable Pi-like rendering. No need to start a replacement TUI from scratch. |
| Exclusive native RPC or native TUI | Reuse both stock modes; no simultaneous-mode bridge or full remote TUI | Mode change replaces the runtime. Safe history resume is possible only under an explicit transcript/handoff policy, not as live attachment. |

A dashboard does not require every Pi RPC command. The important initial slice
is identity/state, snapshot plus live messages/tools, prompt/steer/follow-up,
stop semantics, failures/attention, and supported user-confirmation dialogs when
extensions use them. Model/thinking selection and history management can be
added as needed. Parent-child inventory/control remains an extra contract even
when all native RPC commands are available.

A small extension bridge can cover the core conversation slice without a Pi
patch. It is not equivalent to native RPC: the public extension API has no
`clear_queue` or `abort_retry`, and no direct queue/retry event subscriptions.
`ctx.abort()` returns void; native RPC `abort` waits for idle. In RPC,
`clear_queue` and `abort` are separate operations, so abort alone is not a
"discard all queued work" action. Session changes need command-capable contexts.
Do not claim exact parity or reconstruct unknown state as authoritative.

Native RPC is already implemented: using that backend does not require building
all its UI controls, and its protocol schemas do not become model tool schemas.
A custom bridge is not inherently cheaper than relaying native RPC when the
native TUI is no longer the primary UI. Neither approach transports arbitrary
TUI components automatically; RPC supports a defined basic-dialog subprotocol.

### Native-mode handoff is not reconnect

Stop/quiesce the old owner before starting another writer on its transcript.
With ordinary Pi transcripts enabled, a new native TUI can resume the saved
parent history after the RPC runtime exits (and conversely). This does not
restore active tools, queued messages, sockets, or the in-memory child registry.
If the registry is inside the old parent, children need an explicit finish/stop
policy. Keeping them under an independent owner would be additional design.
With `--no-session` and no explicit export/import, history does not survive the
process change. This does not relax the ban on custom job-state directories.

### Current recommendation, not a decision

The wider search changes the next step: compare existing hosts before writing
another one. jmfederico/pi-web is the strongest newly found whole-workflow
reference (separate SDK session daemon, tracked children, ordinary conversation
UI). Pi Tau Web Server is a closer RPC-process-owner reference; Outpost already
separates runtime capabilities from its frontend. Un Bien demonstrates a real
attachable terminal client using Pi's own message/tool components.

These are not memory-only drop-ins, and combining their full stacks is not the
recommendation. Evaluate adaptation cost against one small custom owner. Native
RPC remains the smaller Pi-only process interface; keeping a TUI plus a scoped
bridge is still valid while web is built. Do not build complete RPC parity or a
new terminal renderer merely because we had not yet found these implementations.
Plan a quiescent native-mode cutover if needed, not an assumed hot handoff.

Evidence: Pi 1.4.0 `rpc-commands.md`, `rpc-extension-ui.md`, `json.md`, and exported
`extensions/types.d.ts`; links and source caveats are in INTERFACES.md. No mode
handoff, frontend, or worker change has been implemented or runtime-tested.

## A. Real Pi TUI workers + a small live bridge (research alternative)

**Status:** not the selected core direction. Retained to explain earlier
terminal research; native TUI hosting is not a prerequisite for the solution.

**Use when:** actual native child TUI access becomes a separate requirement.

- Launch ordinary interactive Pi instances in managed terminals/panes.
- Human observes and steers through the real Pi UI.
- A child extension reports structured state/results to the owner over live IPC;
  model control uses the same path rather than parsing terminal screens.
- Future dashboard can expose terminals and roster/control information.

**What we reuse:** Pi TUI itself and our own agent-terminal's existing Zellij
hosting, ownership, input, and pane cleanup. HazAT proves the interaction, and
AoE proves web access to terminal-backed sessions. Source review is recorded in
[AGENT-TERMINAL.md](AGENT-TERMINAL.md).

**What is still ours:** live parent-child signaling, Pi state/results and model
controls, human open/attach (not a public agent-terminal command today), owner
policy, and dashboard discovery. Current agent-terminal unconditionally uses
file-backed terminal metadata. Strict memory-only coordination requires an
adaptation, not just calling the CLI unchanged.

**Cost:** two surfaces to integrate (terminal and structured supervision), plus
a live bridge. Existing terminal plumbing is a real saving; do not cost it as a
new terminal manager. The MODEL need not drive the TUI: use structured IPC while
the human uses the same session's native terminal. Stock Pi RPC and interactive
mode are alternatives, so a native TUI needs a bridge extension for concurrent
structured control; running RPC inside a pane alone does not provide both.
Fewest custom rendering lines does not guarantee fewest total moving parts.

## B. Persistent RPC workers + an observer in main Pi

**Status:** candidate aligned with the agreed boundary, not a final choice over
ACP or a decision about who owns the processes.

**Use when:** structured Pi control/events and an independent termination
boundary are wanted; human UIs are views of those conversations.

- Owner retains each `pi --mode rpc --no-session` child and its in-memory state.
- Uses Pi's prompt/steer/follow-up/abort and message/event interfaces.
- Main Pi's viewer and future dashboard observe/control through that owner.
- A stuck process can be terminated independently; cooperative abort remains
  the normal first step. Process-group kill is cleanup, not a security sandbox.

**What we reuse:** supported Pi control protocol, public RPC client where useful,
message/tool events, and potentially public Pi rendering components.

**What is still ours:** background ownership, bounded memory, supervision,
result routing, and the observer UI / external adapter.

**Cost:** not an actual attachable Pi TUI. Reusing TUI components can reduce UI
work but does not supply a ready-made full interactive child screen. The parent
registry is not automatically exposed through stock main-session RPC.

## C. SDK child sessions + an observer in main Pi (research alternative)

**Status:** direct SDK-only control is not the selected communication boundary.
An SDK-backed host speaking the selected protocol is a separate possibility,
not something required for the first implementation.

**Use when:** minimum transport/process code matters, and cooperative stop is
acceptable for the chosen capabilities.

- Owner holds `AgentSession` objects with in-memory SessionManagers.
- Direct access to messages, subscriptions, prompts, steering, and abort.
- Viewer and model controls use the same objects; a later bridge exposes them.

**What we reuse:** typed Pi session APIs. tintinweb's FleetView is the closest
existing demonstration; agegr/pi-web demonstrates treating children as ordinary
sessions in one web host.

**Cost:** no independently killable child. If reliable termination of an
unresponsive worker is a hard requirement, SDK-only is not sufficient. Also
requires deliberate resources/provider inheritance; private runtime casts are
not a supported solution.

## Reuse existing packages before rebuilding?

Worth evaluating against the requirements, not automatically installing:

- **jmfederico/pi-web:** sessiond/web separation and tracked children already
  address much of the workflow. SDK failure containment, persistent application
  state, inherited resources, and model-schema size are remaining mismatches.
- **Pi Tau Web Server / Pi Outpost:** existing RPC host, UI, normalized runtime,
  and process-transport references. Neither automatically supplies our chosen
  parent-child supervision, memory, and context policy.
- **Un Bien / Kendex bridge:** respectively an existing attachable terminal
  presentation and a public-API live-TUI socket bridge. Different protocols,
  broader features, and file-backed discovery mean adaptation is still real.
- **tintinweb/pi-subagents:** already has model delegation/control and a human
  conversation viewer with steering. Check whether unused features and child
  persistence can be disabled, actual schema overhead, and remote observer
  access. SDK ownership is still a hard-stop limitation.
- **pi-agent-dashboard:** already bridges existing TUI sessions to web and has a
  subagent inspector contract. It is a large platform and expects its own
  subagent producer. Do not assume generic plugin compatibility or take on its
  persistence/server stack just to get a simple launcher.
- **HazAT:** real child TUIs, but removing file coordination is implementation
  work. **AoE:** useful dashboard reference, not a tiny replacement for the
  worker runtime inside main Pi.

The question is whether adapting one costs less than owning the small missing
slice. Source review alone has not answered that.

## Keep model context separate from the control surface

This is a hard requirement, not a later optimization:

- Conceptually the agent delegates, optionally inspects/sends/stops, and receives
  an outcome. This does not require one registered tool for every internal API
  method, every UI button, or every transport operation.
- Choose a few compact tool definitions. One versus two is not decided; compare
  actual schema/description size and usability, not just the count of names.
- Keep transport discovery, subscriptions, pagination machinery, terminal keys,
  provider management, and dashboard administration out of the default model
  catalog. No giant worker MCP suite as the price of delegation.
- Separate a concise parent outcome from bounded model inspection and the full
  human transcript. A human viewing live events should spend no model tokens.
- Do not inject progress on every tool call. Prefer meaningful completion,
  failure, and attention-needed signals; extra details are requested explicitly.
- Child tools/resources must be selected deliberately, not copied wholesale
  from the parent's MCP/extension catalog. Exact task policies remain open.
- Avoid hiding complexity in a large string DSL or making the model learn a
  second management CLI just to compensate for a small JSON schema.

Before accepting any solution, measure added schema/instruction bytes or tokens
for both parent and child, idle overhead, and typical notification/inspection
sizes. None of the shortlisted implementations has been measured here.

## Reject for the current needs

- One-shot print/JSON execution as the complete solution: no ongoing steering.
- Screen scraping as the primary parent-agent result/control protocol.
- State directories/file mailboxes as the runtime coordination mechanism.
- TUI-only controls with a vague promise that web clients will inherit them.
- A huge tool/MCP surface or full child transcript injected into parent context.
- A separate central orchestration/recovery platform merely to own one
  container's sessions. The preferred container-local server is not that.

## Next discussion, not implementation

Human views are based on structured worker communication, not native child
terminal attachment. Preferred ownership is a server inside each worker
container. Remaining decisions: native Pi RPC vs ACP, client transport/frontend,
server/parent failure policy, emergency terminal scope and cold-handoff policy,
auto-continuation, finished-child follow-up, and selected context/tools. Do not
freeze timeouts, schemas, retention sizes, or module layout yet.

The smallest validation should exercise a live worker's commands, events,
completion, and stop without any viewer. Then render that same worker's snapshot
and updates in one simple human view. A dashboard or terminal manager is not a
prerequisite, and UI activity must not become model-context traffic.
