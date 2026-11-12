# Agent guide: pi-mini-subagents

## Mission and authoritative documents

Maintain a small Pi extension, not an orchestration framework. Read in order:

1. `README.md`
2. `docs/DESIGN.md`
3. `CHANGELOG.md`

These current documents supersede older planning/research notes; those are kept
only in Git history. Keep the implementation simple and do not reintroduce the
architecture survey or adopt a framework.

## Project identity

- Project name: `pi-mini-subagents` (repository). npm package: `@ufoq/pi-mini-subagents` (scoped, public).
- Planned canonical upstream: `https://github.com/ufoq/pi-mini-subagents`.
- `origin` is the private development remote. `upstream` points to the public
  GitHub repository; it is not an instruction to create/fetch/push that
  repository or publish.
- Package metadata uses `name: "@ufoq/pi-mini-subagents"` and the GitHub upstream as
  the repository URL, never a private remote address.

## Scope and safety

- Source belongs in this standalone repository, not inside a shared blueprint.
- Work only in this project checkout and its own test Pi subprocesses.
- Do not touch other projects, shared live mounts, service configuration, host
  networking, credentials, or a shared blueprint.
- Processes run as an unprivileged user with a disposable home. No host Docker
  socket is available or required; container lifecycle is an operator task.
- Do not change globally installed Pi/extensions or deploy the prototype into
  the development agent's own active extension runtime. Use explicit `-e`
  loading in dedicated test sessions until an intentional install is requested.
- No automatic publication or rollout. Normal commits/pushes to this project's
  origin are allowed. Never force-push the protected default branch.

## Fixed v1 behavior

- Persistent native Pi RPC subprocesses; parent can be native TUI or RPC.
- Launch returns immediately; registry and coordination are in memory.
- Observe messages/tools and steer the same child; keep context for follow-up.
- Completion: short `<system-notification>` with id/outcome and result availability,
  never automatic result bodies. Use Pi's normal delivery to wake an idle parent.
- Parent fetches results explicitly. Human viewing creates no parent-context
  traffic. Keep model schemas small.
- Ordinary coding tools; restrictions and file ownership belong in task prompts.
- `viewer.ts` is a secondary surface: keep it good enough for occasional lookups, do not
  expand it into a UI project. A web UI is a later goal and out of v1 scope; the
  controller (`agents.ts`) is UI-agnostic and `viewer.ts` is only one consumer.
- No queue, request budget, runtime deadline, read-only enforcement, writer lock,
  worktrees, recursion framework, parent Escape policy, completion retry ledger,
  durable recovery, or full RPC/server implementation. Admission is capped at
  eight registry entries; `remove` frees a slot. `stop` aborts the current turn
  but keeps the child resumable; only `remove`/shutdown release its process and
  transcript.
- Basic validation, actionable errors and owned-process cleanup still apply.

## Engineering

- Prefer a few TypeScript modules and Pi/Node built-ins. No build toolchain unless
  evidence shows it is necessary. No private-runtime casts or monkey patches.
- Read the installed Pi documentation/examples and confirm exact public APIs
  before implementing against them. Baseline is Pi 1.4.0 and 1.5.2 / Node 24+.
- Start with deterministic offline tests and a fake JSONL RPC subprocess.
- Run `./scripts/test` for the full deterministic offline suite, or
  `./scripts/test rpc.test.ts` for one file (Node 24+, no provider calls).
  No build step is required. Keep opt-in live probes separate from this suite.
- Keep live provider calls separate from offline tests and record what was
  actually verified. A successful prompt submission is not task completion.
- Keep scratch data/logs in `tmp/` (ignored), not custom runtime state directories.
- Preserve unrelated edits, make small commits, and keep README and design docs
  honest about implemented versus planned features.
