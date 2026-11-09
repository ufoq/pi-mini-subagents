# Verification record

Checked 2026-11-02 in the project checkout of its dedicated development
environment. Pi 1.4.0, Node 24.20.0, Linux. This is implementation evidence, not a
claim of exhaustive production readiness.

## Commands actually executed

- `./scripts/test rpc.test.ts`
- `./scripts/test extension.test.ts`
- `./scripts/test native-rpc.test.ts`
- `./scripts/test` — **29 passing tests**, deterministic offline suite (includes real Pi processes
  against a loopback mock SSE endpoint; no external provider).
- `node scripts/probe-tui.ts` — actual native TUI in a separate PTY with mock
  provider; successful logs in ignored `tmp/native-probe-UrcNNR/` and a later
  full reruns in `tmp/native-probe-PYPfnf/` and `tmp/native-probe-bdPVqw/`.
- `MINI_SUBAGENTS_LIVE_MODEL=<provider>/<model> node scripts/probe-live.ts`
  — one successful small real-provider run. Private synthetic evidence in
  `tmp/live-probe-ObADCh/`. That run predates ephemeral children, so its child
  transcript is historical evidence; current runs assert a bash marker file and
  that no child session was written.
- `npm pack --dry-run --json` — no publication and no global installation.
- `git diff --check`.

A later separate-user real-model run is recorded below, including its exact
packaged artifact, host, route and cleanup. The saved scripts reproduce these
probes without changing the active development agent's extension runtime. Mock probes use isolated HOME, Pi/XDG config and child
session storage under `tmp/`, with only synthetic model configuration. The
real-model probe uses existing credentials/config without copying or editing
those files and directs its child session storage to `tmp/`.

## Verified behavior

### Transport and registry

A fake JSONL subprocess proves launch returns an id synchronously, while startup
and prompt acceptance happen asynchronously. Tests cover split UTF-8 (including
Chinese/emoji), embedded U+2028/U+2029, CRLF, request correlation, failures and
idempotent cleanup. A real detached descendant signals readiness only after installing its TERM
handler; stop then kills that TERM-resistant process via hard-kill fallback.
Seven children start directly with no inherited queue/cap. Restrictions in the
task brief are preserved verbatim. Snapshots are independent copies; subscription
removal does not stop a child. `agent_end` alone sends no completion notice.

### Real native RPC + deterministic mock provider

The parent executes the actual `subagent` tool through Pi's model/tool loop,
continues before the held child finishes, and receives only an id/status notice.
An idle parent makes a new request and responds to the notice; no child result
appears until explicit `read`. A held busy parent request stays active across
child completion and then consumes the normal custom follow-up. Pi's RPC
`queue_update`/`pendingMessageCount` describe user queues, not these custom
messages; the test does not falsely assert those expose custom follow-ups.

Follow-up requests include the original task and the new input, with only
read/bash/edit/write declared in the child. `/agents` under RPC sends an
informational notification, not terminal UI. Closing only parent stdin (without
killing the entire process group) exits and releases a second active child plus
its actual detached native bash/sleep descendants, verifying the extension's
`session_shutdown` hook rather than only harness cleanup.

### Actual native TUI + deterministic mock provider

The PTY probe opens `/agents` after launch, opens the existing child's preceding
conversation and real live bash output, sends a correction, and verifies that
correction in that child's next native provider request. It closes the viewer
while the child request remains pending, reopens the same child, resizes the
terminal to 40 columns, scrolls and restores width. Completion wakes the parent
without injecting the result; explicit read retrieves it. Follow-up retains
original and human-steering messages. Ctrl+X stops the child; `/quit` exits Pi.
Component tests separately exercise long tool output and widths 12/30/80.

The probe uses explicit loading and disables unrelated extensions. This proves
our overlay does not replace parent footer/editor APIs; it does **not** prove
compatibility with every installed third-party UI extension.

A test caught native bash renderer timers leaking when observer components were
marked as executing. The observer now does not start execution clocks; completed
and live output still use public Pi renderers. Tests terminate without forced
runner exit. Another early PTY probe submitted input before Pi startup finished;
the saved driver waits for startup's title instead. Failed test jobs were stopped;
a process listing after probes showed no leftover project test children.

### Real provider smoke

Model/provider: a small configured live route for both parent and child, thinking off.
That route has since been repointed upstream, so it is not a reusable provider target.
The parent settled before the first completion notice. The notice contained no
result; `read` returned `CHILD_READY`. A follow-up in the same child returned the
original random remembered word. Inspection of the one normal child transcript
confirmed a successful actual bash tool result:

```text
CHILD_TOOL_OKCHILD_TOOL_DONE
```

There were three child assistant messages (bash call, initial response, retained
word response), all on the intended provider/model. Reported tokens including
cache: parent 14,426, child 9,797. Explicit stop returned `j1 stopped`.

This was not a real-provider native-TUI probe, a provider reliability survey, or
a large-workload benchmark. The live script now asserts the actual bash result via a
marker file the child writes, since children no longer keep a transcript; those
checks were independently performed against the saved run above when added.

### Separate Unix user + DeepSeek real-provider run

Following the shared testing guide, a fresh test account (unique UID/GID, no
extra groups) was created for a second real-provider test. Unlike the earlier
small-route run in the default environment, this used separate Unix permissions as well as a minimal `env -i` environment,
HOME, Pi config, XDG paths, cwd and child session storage. Explicit permission
checks confirmed that this account could not read the live agent's `models.json`
or `auth.json`. Only the selected provider/model configuration was provisioned;
no auth store, project instructions or unrelated extension settings were copied.

Tested extension runtime came from an extracted `npm pack` artifact of commit
`f17d39d`, SHA256
`1f4ce9496ce6e38034f4398f792afb07fa15cb38b5193a1117b61818eb20cee7`. That hash
identifies the historical pack used in this run, not the registry's current
bytes (see the republish note in the deployment rehearsal below).

The full archive listing was reviewed before extraction as the test user (not
root). The host was explicitly pinned to
`/opt/node/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`, Pi 1.4.0,
Node 24.20.0. Observed child argv used that same Node/CLI, the ordinary four tools,
an Ollama Cloud route to DeepSeek V4.1 Flash, thinking off and resource-disabling
flags.

A test-only loopback relay streamed requests to the configured provider. It
recorded route, response model, status, tool names, timestamps and usage, **not
headers, credentials or prompt bodies**. One READY completion checked loading
and provider readiness before the extension flow. Final successful run:

- **16 requests, all HTTP 200**, all requesting and returning DeepSeek V4.1
  Flash.
- Actual successful child bash tool result `CHILD_TOOL_OKCHILD_TOOL_DONE`.
- Parent settled before completion; only result-free notices were delivered.
- Explicit initial/result reads, a remembered random word on follow-up in the
  same child conversation, explicit stop, then parent settlement/EOF.
- Reported parent/child tokens including cache: **16,102 / 5,056**. Including the
  READY check: **21,609 total**, **474 output**, **16,816 cached input**. No dollar
  cost was inferred from potentially zero-priced local metadata.
- Driver and wrapper exited **0**. No remaining processes for the test UID.

The run exposed a test-harness issue: the older smoke driver closed parent stdin
as soon as the stop tool returned, cutting off the final parent acknowledgment
stream. The driver now waits for `agent_settled` after stop. An earlier relay
logging bug was also corrected. The final route/status check passed after those
harness fixes; **no extension runtime source changes were needed**.

Private evidence is preserved in an ignored `tmp/` run directory: setup/artifact
hash, adapted relay/run scripts, prior-attempt logs, wire metadata, and the
probe's summary, RPC events and normal child session. Only synthetic task data
was used. The temporary account/home, selected-provider
credential config and terminal job were removed after copying evidence. No live
agent config was changed. This remains a native-RPC real-model test; native TUI
still has real-Pi/mock-provider coverage, not real-model coverage.

To adapt `scripts/probe-live.ts` to another test user, copy it to that user's
`harness/scripts/` and copy the candidate's `rpc.ts` to `harness/rpc.ts`. From the
isolated cwd, set `MINI_SUBAGENTS_PI_CLI` to the pinned host,
`MINI_SUBAGENTS_EXTENSION` to the extracted candidate directory and
`MINI_SUBAGENTS_LIVE_MODEL` to the selected provider/model. Provision/isolate all
other axes following the shared guide; setting these variables alone does not
create user/config/credential isolation.

## Measured wire catalog size

In the synthetic native-TUI probe, the serialized OpenAI `tools` array containing
only the parent's `subagent` declaration was **552 bytes** (description + schema
+ wire wrapper). The child's ordinary read/bash/edit/write declarations were
**2,841 bytes**, with no launcher/MCP catalog. These are UTF-8 JSON byte counts,
not tokenizer counts or a claim that the parent's other normal tools disappear.
No separate parent instruction/catalog injection is added by this extension.

## Package and scope

Tarball dry-run contains `index.ts`, `agents.ts`, `rpc.ts`, `viewer.ts`,
`package.json` and README only. Host-provided public libraries are peers, no build
or bundled Pi copy. Supported/tested baseline is explicit; peer `*` follows Pi's
package guidance and does not imply every Pi version was verified.

Only repository files, dedicated subprocesses, scratch config/transcripts and
local-origin commits/pushes are in scope. No public GitHub push, npm publication,
environment rollout, credential edits or active-runtime installation occurred.

## Real-model native TUI and third-party extension combo (2026-11-05)

Two opt-in probes were added and run against the released tree with
`litellm/ollama-cloud/deepseek-v4.1-flash` (thinking off), real inference:

```sh
MINI_SUBAGENTS_LIVE_MODEL=<provider>/<model> node scripts/probe-tui-live.ts
MINI_SUBAGENTS_LIVE_MODEL=<provider>/<model> node scripts/probe-combo.ts
```

- `probe-tui-live.ts` drives real Pi in a PTY with an isolated session directory
  and only this extension loaded. Passed: spawn returned immediately and the
  parent continued; `/agents` listed the child and showed its existing/live bash
  activity; a typed human steering message rendered in the same child
  conversation; completion arrived as a result-free notice; an explicit `read`
  returned the child's answer; after steering plus a follow-up, an explicit read
  returned the remembered word; Ctrl+X stopped the child; `/quit` exited 0.
- `probe-combo.ts` repeats the loop with the same third-party packages the
  development environment normally loads (powerline footer, a context extension,
  a terminal bundle) alongside this extension, using a temp agent directory with
  symlinks to installed packages and isolated XDG/session storage. Passed the
  same assertions with no extension load failure, and the editor/exit path stayed
  functional. Extension presence was confirmed independently: the context
  extension created its store in the temp XDG dir, the footer rendered, and
  `get_commands` listed its commands plus this extension's `agents` command; the
  terminal bundle's compatibility flag (`--no-lsp`) was accepted.

Both probes are harness-time bounded, use normal transcripts under ignored
`tmp/`, and change no settings. Evidence remains in `tmp/tui-live-probe-*/` and
`tmp/combo-probe-*/`.

## Per-spawn model override (2026-11-05)

`spawn` accepts an optional `model` as `"provider/model"`; omitted keeps the
parent model. Model ids may themselves contain slashes, so only the first slash
separates provider from id. Invalid forms are rejected with an actionable error
before any process starts.

Covered by:

- Unit assertions on the parser (`undefined`, plain, slash-containing id, the
  three malformed forms, and embedded control characters such as NUL).
- `model-override.test.ts`: a native RPC parent on provider `mock` spawns with
  `model: "mock2/mock-alt"`, where `mock2` is a **second provider on a different
  port**. The child's only requests arrive at that second endpoint with model
  `mock-alt`, no child request touches the parent's provider, and the parent keeps
  `mock` — proving both provider and model forwarding.
- Regression tests that a child whose process cannot be constructed (e.g. invalid
  argv) is not retained: spawn reports an actionable error, `list` stays empty and
  shutdown does not touch a half-registered child. A second case covers a factory
  that reports failure synchronously and then throws: the child is discarded, the
  completion notification is discarded with it, and observers never see the
  provisional entry. A third case covers a factory that reports failure
  synchronously but still returns a process: the child is retained and its single
  failure completion is published after launch, so it is neither lost nor emitted
  for an unknown id. Further cases cover a callback queued by a factory that then
  throws (never reaches observers or the parent), a throwing completion notifier
  (the retained child survives), and startup never overwriting a synchronous
  terminal state with `running` or submitting work for it. Viewer coverage pins the
  newest-first list, a cursor that stays on its id when new children arrive, the
  full-width selection highlight at truncating widths, state-specific input labels
  (`Steer>`, `Message>`, `Stopped>`), narrow-width hints that always fit, and
  model-facing list labels that are escape-free, one line and code-point bounded.
  Layout is also bounded by the overlay's own 90% height cap at 7, 12, 24 and 80
  terminal rows, and the frame's 32-column threshold is pinned. The composer is
  verified visible from 1 to 16 terminal rows, the highlight covers every inner
  column after truncation inserts resets, and a draft survives a run-finish
  transition with its caret intact. The heading is sanitized against escape injection,
  a long draft scrolls inside the composer rather than being truncated after the fact,
  error text stays visible beside the one-word intent, and a warm render reuses the
  cached snapshot instead of cloning the conversation. The composer assertions were
  checked against the pre-fix revision (`732b8b7`), which loses the caret marker and
  truncates the draft tail at 16–22 columns; `agents.test.ts` waits for the tool
  result text itself rather than tool creation, removing an observed timing race.
- Children advertise every built-in coding tool (`read`, `bash`, `edit`, `write`,
  `grep`, `find`, `ls`) and never `subagent`, so a child cannot delegate further.
  Verified from the tool declarations a real child sends to the provider.
- A child with skills enabled advertises the inherited skill catalog in its system
  prompt (verified by capturing the provider request: `web-search/SKILL.md` and its
  description were present), while `--no-extensions` still leaves it without the
  `subagent` tool.
- MCP is deliberately not inherited. A minimal stdio MCP server with a synthetic
  tool was used to confirm why: with `--no-extensions` the child advertises no MCP
  tool at all, because Pi implements MCP as a built-in extension. Loading
  `-e builtin:mcp` would add it (verified for both `direct` and default `codemode`
  exposure), but that also means carrying extension machinery and the
  `codemode`/`tool_search` tools, so the simpler `--no-extensions` configuration
  was kept. The busy-parent probe now waits for the child's final provider answer
  instead of a fixed sleep, and the status line shrinks its intent so a 20-column
  overlay still shows a failed child's diagnostic.

### Ephemeral children (later change)

Children now start with `--no-session`, so they no longer appear in Pi's
`/resume` picker. Verified in the offline suite with a real Pi RPC child:
`get_state` still returns an ephemeral session id, prompts and tool calls work,
and the session directory receives **zero** `.jsonl` files. The consequence is
that a stopped or finished child leaves no on-disk transcript; inspect it through
`/agents` while the child exists or with `subagent read`. Earlier real-model
evidence above relied on persisted transcripts and was produced before this
change.

This is an optional per-spawn argument, not a role/agent-definition registry; the
rest of the launch configuration stays fixed.

## Deployment rehearsal (private registry + disposable container)

A deployment path was rehearsed without touching npmjs or any active runtime,
using a private package registry and a disposable container. This validates the
registry -> install -> load path; it is not a public release and not a rollout.

- Published `pi-mini-subagents@0.1.0` to the private registry under its own
  account. The published tarball contains only the six shipped files (no tests,
  fixtures, scripts or `tmp/`).
- Container: Ubuntu 24.04.5, 8 CPUs; installed Node 24.22.2 and npm 11.19.1
  inside it (its stock Node was 18), then `@earendil-works/pi-coding-agent@1.4.0`
  from the same registry.
- `pi install npm:pi-mini-subagents` resolved the package from the private
  registry and wrote `packages: ["npm:pi-mini-subagents"]` plus
  `~/.pi/agent/npm/node_modules/pi-mini-subagents/`.
- Clean-room RPC smoke with the mock provider used the **installed** package
  (no `-e`, no repo checkout): spawn returned immediately, the parent settled
  before the child finished, the child ran a real bash command (tool result in
  its normal Pi transcript), only a result-free notice was delivered, explicit
  `read` returned the child result, `stop` succeeded, and Pi exited 0.
- The container was deleted afterwards. The private registry publication and
  the npm user config pointing at it remain (private only).
- Republish cycle verified after the operator clarified that private-registry
  artifacts are disposable rather than immutable releases: `npm unpublish
  pi-mini-subagents@0.1.0 --force` removed the package (it had one version), and
  `npm publish` recreated it immediately with no cooldown. The republished
  tarball's six files are byte-identical to commit `e46aa4c`; its integrity
  hash differs from the first upload because the tarball was rebuilt. Consumers
  should trust the registry's own integrity value, not a previously recorded
  tarball hash. Nothing was published to public npmjs.

A first smoke attempt failed on an assertion in the test driver, not the
package: parent RPC events do not include child tool events. The driver was
corrected to prove execution from the child's follow-up request and its stored
`toolResult`. One further known gap remains before a public release: third-party
footer/editor extension combinations and a real-model native-TUI run.

## Remaining limitations

- Linux process ownership is tested. Deliberately daemonized/reparented processes,
  parent SIGKILL and container loss are not recovery scenarios; there is no orphan
  scan or durable registry.
- The in-memory history/viewer is intentionally simple. No retention cap or
  huge-transcript benchmark; full snapshots/rebuilds can be expensive.
- Images, clickable tool expansion and execution timers are not implemented in
  the human viewer. Text/tool output is expanded and scrollable.
- Runtime-only model/provider or credential overrides supplied by a parent
  extension are not inherited; ordinary configured providers must be usable by
  a standalone child Pi.
- No explicit web/RPC observer adapter, simultaneous parent modes, public
  publication, automatic rollout, or exhaustive third-party UI compatibility.
- Notification submission is not acknowledged consumption. Native delivery is
  reused; no retry/outbox ledger or special Escape handling is present.
