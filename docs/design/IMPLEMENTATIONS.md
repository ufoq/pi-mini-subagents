# Pi remote-control landscape: source inventory

Checked: 2026-11-01. Analysis and shortlist: [LANDSCAPE.md](LANDSCAPE.md).

This records the discoverable implementations screened for live session control,
observation, server ownership, client reuse, and subagent integration. It is not
a claim of complete ecosystem coverage or a ranking of production quality.
Same-named projects are deliberately qualified by owner. A repository row is
not necessarily a distinct architecture; monorepos may contain several packages.

Review depth:

- **C**: inspected relevant implementation paths in this research pass, sometimes
  alongside tests. Not a whole-repository audit; no tests were executed.
- **P**: source-reviewed earlier in this design discussion; not comprehensively
  refreshed in this pass. Details are in RESEARCH.md / INTERFACES.md.
- **D**: README/package/docs screening only; do not infer advertised behavior was
  verified in implementation.
- **I**: discovery index, not an implementation.

Links pin inspected repository commits. Full commit IDs/timestamps/package
metadata are saved under `tmp/pi-subagents-design/landscape/`. There are 55
repository rows below, plus four published-package snapshots. Nothing was
installed or launched.

## Web/session hosts

| Project | Snapshot | Depth | Relevance / boundary |
|---|---|---|---|
| [jmfederico/pi-web](https://github.com/jmfederico/pi-web/tree/8646931f1e197672245100b7252dd7cbb17775fd) | `8646931` | C | Separate SDK session daemon, ordinary child conversations, tracked-subsession tools/delivery; persistent application state |
| [milanglacier/pi-tau-web-server](https://github.com/milanglacier/pi-tau-web-server/tree/c1619a96353924e90f001b4745fc967e5008c336) | `c1619a9` | C | Server-owned RPC processes, browser UI/PWA, snapshots/dialogs; client removal does not kill the session |
| [laurentftech/pi-outpost](https://github.com/laurentftech/pi-outpost/tree/283d271d2c71b267b132177d0e44bce97c7c051c) | `283d271` | C | Web UI with embedded SDK or RPC runtime behind explicit snapshot/event/capability boundary |
| [wighawag/wherever](https://github.com/wighawag/wherever/tree/5ffe02a52077c3a81c8d2e61042f22254b698aab) | `5ffe02a` | C | Web workspace, server-owned sessions and CLI bridge/ownership handling; substantial persistent application |
| [agegr/pi-web](https://github.com/agegr/pi-web/tree/d128bae47cd3abbdfe7135443ac793f547c14e47) | `d128bae` | P | SDK web host, ordinary-session children, SSE; persisted-parent and private-field caveats in RESEARCH.md |
| [ygncode/pi-web](https://github.com/ygncode/pi-web/tree/4a77ea5d662b2ef4fa20563b90dac823581614b7) | `4a77ea5` | C | Separate pi-web implementation/package; inspect its SDK/session/resource policy rather than infer compatibility from the name |
| [Gang-of-Beads/pi-web](https://github.com/Gang-of-Beads/pi-web/tree/b70a8e8178fa4689099e3c1f6fb38094cc827734) | `b70a8e8` | D | Additional pi-web product; screened, not established as a small in-memory host |
| [SASUKE40/pi-daemon](https://github.com/SASUKE40/pi-daemon/tree/47ea4dd99c11c2db87596a1586ab6cf806b587bb) | `47ea4dd` | C | Daemon-first process/session management; more lifecycle/state machinery than a transport relay |
| [tryingET/pi-server](https://github.com/tryingET/pi-server/tree/3ad5d4c426def74b6fb93033af2e504716261efb) | `3ad5d4c` | C | Pi app-server application protocol, session ownership/journaling; NOT the removed native pi-server |
| [duh17/oppi](https://github.com/duh17/oppi/tree/8575a1dcbe00431a2f4bd63713bb7eef1fb58070) | `8575a1d` | C | Native-client/server product around Pi RPC; useful lifecycle/client reference, not a tiny extension |
| [WillianQ/pi-chamber](https://github.com/WillianQ/pi-chamber/tree/89e78d7fa3edef442d50fc42c6c3b7dbdaf9af80) | `89e78d7` | C | SDK children are ordinary viewable sessions; inspected delegation tool awaits completion and uses cooperative abort |
| [rcarmo/piclaw](https://github.com/rcarmo/piclaw/tree/fd7a9346706bd7a77b5d33eb42a79f0a26ca42f3) | `fd7a934` | D | Full self-hosted Pi workspace; persistent messages/tasks/auth/files/terminal, not a minimal IPC layer |
| [gustavonline/pi-desktop](https://github.com/gustavonline/pi-desktop/tree/5d698433864fbebafa24e141da0ea56297766cfe) | `5d69843` | D | Desktop/frontend alternative; shared-container-owner fit not established |
| [knucklehead96/pi-agent](https://github.com/knucklehead96/pi-agent/tree/65e6b9d59ea550dea9b73000e7c974822f3c039c) | `65e6b9d` | D | Alternative Pi application shell; not shortlisted as a protocol primitive |

## Bridges to a running native Pi

| Project/package | Snapshot | Depth | Relevance / boundary |
|---|---|---|---|
| [BlackBeltTechnology/pi-agent-dashboard](https://github.com/BlackBeltTechnology/pi-agent-dashboard/tree/400cfca993225dd2a3d761caea30a4d39166f1e0) | `400cfca` | P | Existing TUI connects outward to dashboard; explicit subagent timeline/resync contract, not arbitrary extension compatibility |
| [Kendex: pi-session-bridge](https://github.com/vanillagreencom/kendex/tree/923bb71a1bf2b6477cdea6943fe0c71925204151/pi-extensions/pi-session-bridge) | `923bb71` | C | Public-API Unix JSONL command/event bridge and CLI; file discovery/history, some tmux command fallback |
| [monopi: web-remote / web-server](https://github.com/ifiokjr/monopi/tree/9c360bae1baa164fe21f5b0168c66565abcf6e27/packages) | `9c360ba` | C | Local structured server with hosted/self-hosted frontend and optional tunnel; NOT an outbound application relay |
| [kkkiio/pi-web-ui](https://github.com/kkkiio/pi-web-ui/tree/bbc4d090d068f0fef07a35108880c3c3cb0cbf5e) | `bbc4d09` | C | Mirror extension/custom command-event bridge keeps native TUI available |
| [tdiam/pi-web](https://github.com/tdiam/pi-web/tree/b60434184a30ff0e5358d282a15033e5b161f050) | `b604341` | C | Wide custom RPC adapter plus live/SDK session registry; substantial protocol/session implementation |
| [mitsuhiko/agent-stuff control.ts](https://github.com/mitsuhiko/agent-stuff/blob/0865c849befd2021490679f96a8dee58c84ac857/extensions/control.ts) | `0865c84` | C | Scoped local control bridge; useful small-interface precedent |
| [carderne/pi-nvim](https://github.com/carderne/pi-nvim/tree/b10a3cc94583cc232645f0e49533e282a3486c0d) | `b10a3cc` | C | Editor bridge; inspect private/session reach-through before treating controls as supported on current Pi |
| [ketchh/pi-live](https://github.com/ketchh/pi-live/tree/2ec1833de36e05f5586c808daeffbb189f1554dd) | `2ec1833` | C | Live external-control experiment; current-API/session access needs compatibility review |
| [apetersson/pi-beacon](https://github.com/apetersson/pi-beacon/tree/0cae8afe7b1916d60b6341bea655bac842a3b6c5) | `0cae8af` | C | Read-only status socket, distinguishes retry/compaction/settled idle; discovery files, no control operations |

## Native-RPC wrappers and remote integrations

| Project | Snapshot | Depth | Relevance / boundary |
|---|---|---|---|
| [marcfargas/pi-server](https://github.com/marcfargas/pi-server/tree/5b5424c89f95acb973a59bc1424c5da2a1821252) | `5b5424c` | P | Third-party RPC/WebSocket wrapper; inspected server permits one client, not a shared-viewer drop-in |
| [tohlh/pi-rpc-web](https://github.com/tohlh/pi-rpc-web/tree/f8a1ba42d23e88ebcd6d44e8352e79ad4cdf4fd6) | `f8a1ba4` | P | Browser RPC relay spawns a separate headless child per connection; not the existing TUI runtime |
| [SkeLLLa/pi-ws](https://github.com/SkeLLLa/pi-ws/tree/b848e44b1a34b7a9d77d4931f9bd4fc0b3a6575d) | `b848e44` | C | Native RPC over WebSocket; connection close calls its peer's close method |
| [andreasmcdermott/pi-remote](https://github.com/andreasmcdermott/pi-remote/tree/fee9760549d48dcc31e26cb8bd8082ff761dbbb4) | `fee9760` | C | Remote RPC/web control implementation; another adapter/lifecycle reference, not assumed equivalent to pi-ws |
| [k3-2o/pi-remote](https://github.com/k3-2o/pi-remote/tree/b2c7817cb9804e6b09a61b95448129543bd44b30) | `b2c7817` | C | Separate remote Pi product; frontend/runtime ownership reviewed, current compatibility untested |
| [nucleoid/pi-remote](https://github.com/nucleoid/pi-remote/tree/d539917f6c2f1edc3c6baf54f5be1ddb4ce4a363) | `d539917` | D | Additional remote frontend/integration; live-sharing and lifetime not established |
| [jacobaraujo7/remote_pi](https://github.com/jacobaraujo7/remote_pi/tree/2c5742862b5481236fca7ca39fe542ab40d71ab0) | `2c57428` | D | Alternative remote/mobile client; not established as a shared container session owner |
| [kenschultz64/openpibot](https://github.com/kenschultz64/openpibot/tree/530117794e23df5880c42cac7a66fc80d6589661) | `5301177` | D | Bot/session integration; adjacent inspiration, not our observer/control contract |

## Human clients and protocol reuse

| Project | Snapshot | Depth | Relevance / boundary |
|---|---|---|---|
| [georgeharker/un-bien](https://github.com/georgeharker/un-bien/tree/d5695b10f05c86ae349c53967b3faa860446261c) | `d5695b1` | C | Actual attachable CLI using Pi message/tool components, extension bridge, relay/pairing; broader mesh than needed |
| [jbn/piface](https://github.com/jbn/piface/tree/6172144f221b5f6e2240d9ca1bb7cc522607ef62) | `6172144` | C | Independent Pi terminal frontend; remote execution does not alone establish shared-live-owner attach |
| [rcarmo/vibes](https://github.com/rcarmo/vibes/tree/656e7fb8daec6d58fa53adbcf588adc981731a09) | `656e7fb` | C | Multi-agent web frontend; native Pi RPC path alongside other runtime adapters |
| [batrachianai/toad](https://github.com/batrachianai/toad/tree/dd4f90e8b3700c3de80ad4b0eaa488ad0105e2c1) | `dd4f90e` | D | Existing ACP terminal UI; client reuse can justify ACP, shared server ownership still separate |
| [giuliastro/harness-remote](https://github.com/giuliastro/harness-remote/tree/e8cabc3219f66a0ff5c2d8ff5c6c58ef123f9a47) | `e8cabc3` | D | Multi-harness desktop/web/Android; Pi via ACP; documentation distinguishes interrupted turn from later native-session resume |
| [Lqm1/pi-codex-app-server](https://github.com/Lqm1/pi-codex-app-server/tree/ea8902a36aacd74e9b3daa9a635a490233440a63) | `ea8902a` | C | Pi projected onto Codex app-server clients; SQLite metadata, explicit semantic/security compatibility limits |
| [JC1DA/pi-cockpit](https://github.com/JC1DA/pi-cockpit/tree/4327fc4a989b269e14e5ac5d8bf680f66cee3681) | `4327fc4` | D | Additional Pi cockpit/terminal workflow; screened, not selected or integration-tested |
| [Agent of Empires](https://github.com/agent-of-empires/agent-of-empires/tree/ee916d9640b6cf51aadf7f766b3b285fd9a461ff) | `ee916d9` | P | Native terminal and structured ACP worker paths are different; persistent supervisor/event-store product |

## ACP and adjacent SDK/API hosts

| Project/package | Snapshot | Depth | Relevance / boundary |
|---|---|---|---|
| [svkozak/pi-acp](https://github.com/svkozak/pi-acp/tree/04d0a15d6bb42bb65cce5c9caedcdcb2cdcb6905) | `04d0a15` | P | ACP-to-native-RPC adapter; session-map persistence by default, not required by ACP itself |
| [Attamusc/pi-acp](https://github.com/Attamusc/pi-acp/tree/ded14789b966a80e87ef62a760377491c39741fc) | `ded1478` | C | Separate Pi ACP implementation; do not assume another adapter's lifecycle/capabilities |
| [georgeharker/pi-acp](https://github.com/georgeharker/pi-acp/tree/03fe96c064137fa141334baee3fc07ebc3c5097e) | `03fe96c` | C | Another adapter with extension/mesh integration; broader than a transparent shared-server transport |
| [myk-org/pi-config: pi-sidecar](https://github.com/myk-org/pi-config/tree/6574f80d1052890d85ed7c8e9a0134709859f7c3/packages/pi-sidecar) | `6574f80` | C | HTTP SDK API with in-memory sessions; package 4.18.1 targets Pi >=1.4.0, not a complete streaming observer UI |
| [zosmaai/openzosma](https://github.com/zosmaai/openzosma/tree/66617ddd27ab3887a0e93782809fcbb9508fbe26) | `66617dd` | C | Generic agent-host/adapter abstraction; inspected Pi adapter targets old package namespace/version, migration needed |
| [aliou/pi-apps](https://github.com/aliou/pi-apps/tree/10f6183c2dad4155971c7e9109762bbd7c912add) | `10f6183` | D | Adjacent Pi app/UI integration; not established as the shared session host we need |

## Multiplexing and agent-management references

| Project | Snapshot | Depth | Relevance / boundary |
|---|---|---|---|
| [dwainm/pi-tau-mux](https://github.com/dwainm/pi-tau-mux/tree/f31b9019cda53be215b260246ecf9505a396d4df) | `f31b901` | C | Pi-side multiplexing/bridge experiment; inspect together with its server, not as a native feature |
| [dwainm/pi-tau-mux-server](https://github.com/dwainm/pi-tau-mux-server/tree/144962dc5a1ecdd9038885585bda32f84fdf0cc3) | `144962d` | C | Companion aggregator/server; useful topology, not proof of current Pi 1.4 compatibility |
| [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents/tree/a37a28853822d470d15ae1764c97aed258087699) | `a37a288` | P | Background ownership/artifacts/lifecycle reference; historical native pi-server dependency was removed |
| [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents/tree/f7cae2f2a327b0bef3380074c2f45b48a76e29e4) | `f7cae2f` | P | SDK agent manager and FleetView; its RPC is an in-process event bus, not automatically browser-accessible |
| [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents/tree/c100577ebf7393a11d098ad9810ec6c269dcfc30) | `c100577` | P | Actual child TUIs; file-backed state/completion coordination conflicts with F6 |
| [edgehero/pi-dispatch](https://github.com/edgehero/pi-dispatch/tree/b9279bfada39ea151823b11bbc792592f9db8e4c) | `b9279bf` | C | Session/task dispatch reference; useful to separate dispatch/control APIs from an actual human observer |
| Private `agent-terminal` | `5eb3b27` | P | Named terminal ownership, input and cleanup; not Pi protocol, file metadata; see AGENT-TERMINAL.md |

## Historical/adjacent material and discovery

| Project | Snapshot | Depth | Relevance / boundary |
|---|---|---|---|
| [Firstp1ck/pi-coding-agent-forge](https://github.com/Firstp1ck/pi-coding-agent-forge/tree/e39459da549c1cd6320f284c3327411cd79c10a5) | `e39459d` | D | Fork/historical Pi surface; native-server references do not establish current upstream support |
| [deflating/tau](https://github.com/deflating/tau/tree/f1bc1ac017f1e8bc60c70fea73797c1e29098b6f) | `f1bc1ac` | D | README marks standalone app retired; NOT the same project as Pi Tau Web Server |
| [awesome-pi-agent](https://github.com/thevibeworks/awesome-pi-agent/tree/d72775c1f97eaff6b0f8b4c3818f9215496837a4) | `d72775c` | I | Discovery index; entries were screened separately rather than treated as verified capabilities |

## Published npm snapshots where registry/package source was useful

These four archives were downloaded and extracted as data, without installing
or executing them. Version metadata and distribution integrity are retained in
the scratch directory. An npm version pin is not a claim of current Pi API parity.

| Package | Version / depth | Relevance / boundary |
|---|---|---|
| [@clevercloud/pi-remote-control](https://www.npmjs.com/package/@clevercloud/pi-remote-control/v/0.1.5) | `0.1.5`, C | Outbound authenticated relay/pairing; loosely modelled Pi API, optional `pi.abort` and unconfirmed hooks need correction/validation |
| [@noahsaso/pi-remote](https://www.npmjs.com/package/@noahsaso/pi-remote/v/0.3.1) | `0.3.1`, D | PTY/xterm remote terminal; documented `/remote` saves/stops/restarts Pi rather than exposing a structured live session |
| [pi-cross-session](https://www.npmjs.com/package/pi-cross-session/v/2.4.0) | `2.4.0`, D | Peer IPC/provenance/admission semantics; discovery files and substantial model coordination surface, not a dashboard host |
| [pi-roam](https://www.npmjs.com/package/pi-roam/v/0.1.2) | `0.1.2`, D | Additional remote integration, screened only; not shortlisted as the owner/observer contract |

Other registry lookups (for example `pi-nvim-bridge`, `oppi-mirror`, and
`pi-acp-provider`) were used as discovery leads. They are not counted as extra
source-audited implementations merely because metadata was fetched.

## First-party and earlier baselines

- [Native Pi 1.4.0 RPC implementation](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/modes/rpc/rpc-mode.ts),
  [SDK](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/sdk.md),
  and [basic RPC terminal example](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/examples/rpc-extension-ui.ts):
  source checked. No built-in native-TUI remote attachment mode.
- [Native server removal](https://github.com/earendil-works/pi/commit/7472cda0d6e51dfbf53c03f46b47aa42ac64bf64):
  distinguishes the former first-party server from third-party namesakes.
- [OMP registry](https://github.com/can1357/oh-my-pi/blob/v17.0.5/packages/coding-agent/src/registry/agent-registry.ts)
  and collaboration adapters: earlier source review, pinned to the actually read
  v17.0.5 source tree, not inferred from the installed executable's version.
- The earlier launcher survey also covered danchamorro, pi-simple-agents,
  mjakl, kaush, hheei, and mzenko implementations. Their package versions were
  not refreshed here. This pass concentrated on live host/client/IPC options,
  not re-enumerating every one-shot launcher.

## What this inventory does not establish

A candidate still needs an integration test for client disconnect, simultaneous
observers, late snapshots, steering/stop, parent-child routing, actual memory
bounds, configured providers/extensions, and our context-budget policy.

A documented native-session resume is not evidence of preserving a live turn;
a public network listener is not authentication; matching wire schemas are not
proof of matching permission or cancellation semantics. No project should be
installed simply because it has a promising row in this table.
