# Worker task: implement the simple first slice

Updated: 2026-11-02
Project: `pi-mini-subagents`; npm package: `@ufoq/pi-mini-subagents`
Planned canonical upstream: `https://github.com/ufoq/pi-mini-subagents`
`origin`: private development remote, not the canonical public repository.
Working tree: this checkout.

## Why this repository exists

The design was developed alongside a shared blueprint. Implementation then moved
into its own repository and dedicated environment. This checkout contains the
full design/research handoff, with current requirements/defaults/plan updated for
the move. Earlier blueprint-based placement is superseded. No other project or
shared blueprint is in scope.

## Task

Implement the vertical slice in `docs/design/PLAN.md`, beginning with offline
core/transport tests, then the Pi adapter and TUI observer. Do not implement a
web dashboard, Docker gateway, scheduler or policy framework first.

Demonstrate this loop:

1. Parent spawns a child and continues working.
2. Human opens that child's actual conversation/tool activity midway through.
3. A steering message reaches that same child; follow-up retains its context.
4. Completion sends only an id/status notification and wakes an idle parent.
5. Parent explicitly retrieves the result; no result or transcript was injected
   automatically into its context.
6. The child can be explicitly terminated, including owned bash descendants.
7. The extension also works in a dedicated native-RPC parent test session without
   invoking terminal-only UI APIs.

A single compact `subagent` tool with spawn/list/read/send/stop is the proposed
starting interface. `/agents` is the human viewer. Reuse native Pi behavior and
public renderers; change provisional names/module splits if it reduces code.

## Work sequence

- Read `AGENTS.md` and the three authoritative design files.
- Inspect the installed Pi version/docs. Keep the supported version explicit.
- Add the smallest test wrapper and fake RPC fixture; implement transport/core.
- Add tool registration and notification-only completion.
- Add live observation/steering with TUI guards.
- Run offline tests; run small, deliberate integration probes in this worker.
- Document commands, actual results, remaining limitations and usage.
- Commit/push reviewable milestones to local `origin`. Do not install into other
  workers, push to public `upstream`, create the GitHub repo, or publish to npm
  without an explicit publication step. Use `@ufoq/pi-mini-subagents` for package name
  and the GitHub upstream for package repository metadata when added.

## Scope limits

Do not add concurrency caps, queues, request budgets, automatic timeouts, read-only
profiles, writer locks, worktrees, Escape interception, parent pause/resume logic,
completion outboxes, recovery, or automatic retention/parking policies. The model
decides fan-out and writes permissions/task boundaries into prompts.

Basic parsing/validation, error reporting, result availability before notification,
and process cleanup are normal correctness, not an orchestration subsystem.
Pi's `agent_settled` identifies finished automatic work; idle does not prove the
assignment succeeded. Keep diagnostics available for explicit result reads.

## Research use

`docs/design/README.md` identifies the reference-only files. The inventory contains
upstream URLs and inspected commit ids; the old host's scratch checkouts are not
part of this repository. Fetch a source only when needed to answer a concrete
implementation question. Do not reproduce all features of the inspirations.
