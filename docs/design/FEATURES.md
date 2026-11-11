# Pi subagents: requirements

Updated: 2026-11-02
Status: our own Pi extension, shared by mutually exclusive native TUI and RPC
parent modes. Children use Pi RPC subprocesses; a future thin gateway can
supply web access (not implemented in v1). DEFAULTS.md records the user's simplified v1 scope: steerable,
observable workers, not a scheduler or policy framework. It supersedes the
OmO/OMP-derived defaults. The first slice is implemented; actual checks and
limitations are in [../VERIFICATION.md](../VERIFICATION.md). The concrete plan is
in [PLAN.md](PLAN.md). Implementation now belongs in the standalone
`pi-mini-subagents` repository, with experiments restricted to its dedicated
development environment. The previous shared-blueprint placement is superseded.

## Goal

The main Pi agent delegates work and manages its subagents. The human usually
stays in the main conversation, but can occasionally open a subagent, see what
is really happening, and send a steering prompt.

A future workers dashboard (roughly pi-web + Agent of Empires) should be able to
show and control these same subagents when the main session is accessed there.
It must not become a second, disconnected inventory of workers.

## Preferred deployment direction

Each development container hosts the parent and children. The subagent feature
is packaged as our own Pi extension, also usable outside containers. Startup
selects one of two exclusive parent modes:

- Native TUI: ordinary Pi in tmux loads the extension.
- Headless: a thin network gateway owns a `pi --mode rpc` parent, which loads
  the same extension. SDK embedding is not the initial headless backend.

In both modes the extension owns one in-memory child registry and supervises
persistent Pi RPC subprocesses. The model facade is mode-independent; TUI/web
views render the same structured child data.

- Ordinary observer disconnect/reconnect does not terminate or replace work.
- Web is the intended primary human UI. Native TUI remains available before
  the web UI exists and for emergencies; simultaneous native TUI/RPC is not
  required, and no replacement terminal client is a prerequisite.
- Stock parent RPC does not expose arbitrary extension state. Child discovery,
  snapshots, updates and controls need a small explicit extension API, relayed
  by the gateway without creating a second registry or model-context traffic.
- A mode switch replaces the parent process. Basic shutdown cleanup stops its
  children; no custom handoff protocol is part of v1. Normal Pi transcripts may
  preserve conversation history, not live queues/registry.
- Registry and coordination remain memory-only; no crash recovery is implied.
- This records the design direction, not an instruction to modify workers yet.
  See DEFAULTS.md for behavior; INTERFACES.md and OPTIONS.md retain earlier
  alternatives/research rather than overriding this direction.

## Confirmed needs

### F1. Agent-first delegation

- The main agent is the primary user of subagents, not the human.
- Launch does not block the main agent from doing other work.
- The parent receives a completion notice when work finishes or fails, without
  a status-polling loop. It retrieves the result explicitly when needed.
- The notice wakes an idle parent and serves as a reminder when it is busy;
  result bodies are not automatically inserted into parent context.
- Children still running after 10 minutes emit notification-only reminders every
  10 minutes; the parent decides whether to inspect or stop them.
- Child ids include a base36 millisecond timestamp so a restarted session cannot
  reuse an old `j1`.
- The model-facing interface should stay small; no mandatory workflow language
  or orchestration bookkeeping.

### F2. Optional, real observation

- The human can discover which subagents belong to a main session.
- Opening one shows its conversation and tool activity, not just a `running`
  label or a synthetic progress percentage.
- The intended experience is Pi-like: understand the work, inspect tool calls/
  results, and intervene. This is a human view of structured worker data, NOT a
  requirement to attach a native child Pi terminal.
- Opening or closing an observer must not launch another agent or restart work.

### F3. Steering

- The human can send a prompt to the same live subagent they are observing.
- This is not merely cancel-and-relaunch with a new context.
- Steering should be reachable through the main Pi integration and eventually
  the dashboard, using structured commands rather than terminal keystrokes.
- Reuse Pi's native prompt/steering behavior rather than creating another
  input scheduler or abort-and-replay mechanism.

### F4. Observe and stop first

- Show the conversation/tool activity and provide direct child stop/termination.
- Parent/human inspection is the v1 supervision mechanism. Active output is not
  proof of useful progress, so inspecting the actual conversation matters.
- No concurrency limits, request budgets, automatic runtime deadlines, or drift
  detection in v1. The model decides how many workers to spawn.
- Do not intercept parent Escape or implement stop/resume propagation yet.

### F5. One capability, multiple access paths

- Delegation, observation, and control should not be buried inside a TUI-only
  widget. A future web frontend needs access to the same underlying workers.
- Prefer one container-local owner for the main session and its subagents,
  rather than an unrelated service per child.
- Parent-child relationships, identity, state, conversation, and controls come
  from the extension's shared registry/API. Its exact transport remains to be
  implemented; parent/child Pi control uses native RPC.
- Browser and terminal views should operate on the same conversations; a
  transcript copy that cannot steer the worker is insufficient.
- Do not assume a custom TUI overlay automatically appears in RPC/web clients.

### F6. In-memory runtime

- No custom job-state directories, file mailboxes, result-file protocol, or
  filesystem-based coordination.
- Live registry, handles, activity, and supervision state live in memory.
- The extension owns this state; the web gateway does not duplicate it.
- Normal Pi parent/child transcripts are allowed by the working defaults. They
  are not a custom result-file protocol or automatic orchestration recovery.

### F7. Simplicity and reuse

- Start with requirements, then compare the smallest solutions that meet them.
- Prefer existing Pi session/control/rendering mechanisms where they fit.
- Avoid making a daemon, web platform, role registry, scheduler, or workflow DSL
  a prerequisite for basic delegation.
- Prefer not to depend on the experimental `pi-server` project. Research its
  current status and distinguish it from supported CLI RPC and the SDK.

### F8. Context and token economy

- Do not clutter the model's context with many tools, MCPs, enormous schemas,
  repeated instructions, or a large catalog of worker-management operations.
- The model-facing surface should be a few compact definitions. Rich internal
  and dashboard capabilities must not all become separate model tools.
- Do not automatically inherit every parent extension/MCP into each child.
  Start with ordinary coding tools; task-specific restrictions such as read-only
  intent are instructions in the parent's task prompt, not permission machinery.
- Send a concise completion notice with child id and result availability, not
  the result itself. Parent fetches results/errors on demand; no activity chatter,
  full transcripts, or repeated copies of cumulative worker output.
- Inspection should reveal bounded detail on demand. A human opening a viewer
  must not inject that conversation into the parent model's context.
- Apply this to both parent and child prompts. A tiny launch schema is not a
  win if every child receives an enormous inherited tool catalog.
- Do not replace schema bloat with an elaborate string DSL or a giant tool
  description. Favor small, understandable, validated inputs.
- Exact tool count and byte/token budgets remain open; measure the actual
  definitions and messages rather than claiming a savings from tool count alone.

### F9. Separate control from observation

- Worker communication uses native Pi RPC. ACP is not an initial dependency.
- Control sends prompts, steering/follow-up, and cancellation to an addressable
  worker. It must work without any human viewer or terminal attached.
- Observation exposes structured messages, tool calls/results, activity, and
  lifecycle state. Human UIs render this data rather than parse terminal output.
- Main Pi and future dashboards are clients of the same underlying runtime.
  A human's steering composer sends a command through the control path; it does
  not become a separate controller of a terminal screen.
- Control and observation may share one connection and one in-memory owner.
  This separation does not require two services or a new event-bus framework.
- The structured protocol is not the model tool catalog. The parent model gets
  a compact facade and completion notices; results and UI event traffic stay
  outside its context unless inspection is explicitly requested.
- Native terminal hosting/agent-terminal is not a prerequisite for subagents.
  A native parent Pi TUI may coexist with the owner/bridge in one process;
  automation must still use structured commands/events, not terminal contents.
  This does not require an interactive TUI for every child.

## Derived requirements to validate

These follow from the intended workflow, but their exact surface is not agreed:

- The parent needs a way to inspect, steer, and stop accepted workers too; those
  cannot all be human-only slash commands if the agent is the main operator.
- An observer attaching after launch needs an initial snapshot plus subsequent
  updates; listening only for new events loses earlier conversation.
- Concurrent human/model inputs must address the same worker with explicit
  steering/follow-up semantics, not race two independent controllers.
- Worker and owner failures must be distinguishable from normal completion.
- Main context gets completion/status notices, not automatic result bodies,
  child transcripts or live tool events. Result retrieval is explicit.
- Keep observation and result handling simple. Advanced retention, parking and
  eviction policies are deferred rather than prerequisites for delegation.

## Working defaults and remaining details

The user explicitly simplified the reference-based proposal. DEFAULTS.md now
records the minimal loop: spawn, observe, steer/follow up, stop, and notify.
Completion sends only a `<system-notification>` that the child is done and its
result is available. Pi's existing `steer` delivery wakes an idle parent and
enters a busy parent at the next message boundary; pending notices are coalesced
into one message. Long-running reminders share the notifier and are superseded
by completion or stop. Parent fetches results on demand. There is no retry ledger
or Escape policy.

Parent prompts govern allowed actions and task ownership. The model decides
fan-out. Concurrency caps/queues, request budgets, automatic deadlines and
advanced lifecycle/retention machinery are not v1 requirements. Basic validation,
RPC errors and child cleanup remain ordinary implementation responsibilities.
Our own extension is selected; further architecture research is not a blocker.

## Scenarios the eventual solution must demonstrate

- Parent launches two independent tasks and continues working.
- A child completes while the parent is busy; its completion notice reaches the
  parent, which can retrieve the result without polling for status.
- A child completes while the parent is idle; the notice wakes the parent. No
  result body is injected unless the parent explicitly fetches it.
- Human opens a child halfway through and sees preceding messages plus live
  tool activity; sends a correction that reaches that same child.
- Parent notices unproductive work and can inspect/redirect/stop it.
- A hung child can be stopped and does not remain falsely `running` forever.
- A future dashboard opens the main session, discovers its current children,
  observes one, and sends steering without starting a duplicate worker.
- Closing an observer does not stop the child. Owner termination follows an
  explicit policy, rather than accidentally orphaning children.
- Disconnect every UI, let work continue, then reconnect via GUI or a protocol
  terminal client to the SAME parent/children without restarting work.
- If exclusive native TUI/RPC modes are used, demonstrate a safe cold handoff:
  one history writer, an explicit active-child policy, and no claim that history
  resume restores live queues, tools, or the in-memory registry.
- Compare actual added tool-schema/instruction size in parent and child requests;
  operating the feature should not require loading a large management catalog.
- Human observation produces no parent-context traffic. The agent requests
  extra worker detail only when useful, rather than receiving a live transcript.
- Launch, inspect, steer, and stop work without any human UI or terminal capture;
  opening a later UI renders the existing worker's structured state/history.

## Not decisions

Earlier sketches chose one-shot JSON children, passive delivery, 15-minute
limits, read-only tools, specific retention sizes, and human-only commands.
Those earlier sketches are not requirements. Some values recur as working
choices in DEFAULTS.md; that file, not the old sketches, governs current
proposals. One-shot print mode alone cannot meet live steering.

See RESEARCH.md for source findings and OPTIONS.md for solution tradeoffs.
The wider host/client survey is in LANDSCAPE.md; IMPLEMENTATIONS.md records
pinned sources and which claims were code-inspected versus only documented.
