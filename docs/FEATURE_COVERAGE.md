# Claude Code Feature Coverage

> **Language / 언어:** English | [한국어](FEATURE_COVERAGE_KO.md)

This matrix measures product behavior, not source-code line coverage. Features
are normalized into groups so that a large cloud product is not counted as one
item while every small CLI flag is counted separately.

## Measurement

Status scores:

- **E2E:** implemented and covered by a reproducible live Claude Code + model test
  (`1.0`)
- **Unit/manual:** implemented with unit or focused lifecycle validation, but no
  repository live-model E2E (`1.0`)
- **Partial:** useful behavior exists, but native semantics or broad E2E is
  incomplete (`0.5`)
- **Structural:** requires Anthropic cloud/account services or a provider API the
  Copilot SDK does not expose (`0.0`)

Current normalized counts:

- Implementable/local groups: **34**
- E2E groups: **22**
- Implemented unit/manual groups: **5**
- Partial groups: **7**
- Structural groups: **11**

Calculations:

- **Implementable-scope coverage:** `(22 + 5 + 7 × 0.5) / 34 = 89.7%`
- **Reproducible live E2E coverage:** `22 / 34 = 64.7%`
- **Whole-product equivalence:** `(22 + 5 + 7 × 0.5) / (34 + 11) = 67.8%`

These percentages are historical estimates for Claude Code 2.1.241 and
Copilot SDK 1.0.10-preview.0. They have not been recalculated for SDK 1.0.14.

## Tested Model Boundary

The current live-validation matrix targets exactly these seven model IDs:

- `claude-opus-5`
- `claude-sonnet-5`
- `claude-haiku-4.5`
- `gpt-5.6-sol`
- `gpt-5.6-terra`
- `gpt-5.6-luna`
- `gpt-6-astra`

All seven run the base text/Read E2E. Core Agent→Read behavior has also been
validated across all seven during compatibility testing. The broad feature suite
(Edit, Write, NotebookEdit, Bash, hooks, skills, plugins, MCP, plan, image,
PDF, cron, and structured output) uses `claude-haiku-4.5` as the default
representative model, with `claude-sonnet-5` as the default image/PDF model.
The 35-tool MCP fallback also uses `claude-sonnet-5` as its default
representative model to reduce provider-selection variance.
Those representative defaults describe a standalone feature-suite run. The
[exhaustive matrix](EXHAUSTIVE_TESTING_KO.md) sets the primary, multimodal, and
MCP model to each selected model in turn; all seven passed the same-model
feature, MCP, image, and PDF assertions in the SDK 1.0.14 verification below.

Catalog visibility alone is not proof of compatibility. `gpt-5.5` and models
outside the explicit validation targets have not been verified by this matrix.
`npm run test:e2e:astra` remains a text/Read smoke test; it is not the full matrix.

### SDK 1.0.14 verification, 2026-09-18–19

Claude Code 2.1.276 and stable SDK 1.0.14 (bundled runtime 1.0.85) were checked
against the seven models listed above.

- **Final outcome:** all seven suites passed for each model: base text/Read,
  features, stream, session, worktree, background, and a Korean coding task.
- **Totals:** 50 top-level cases passed: 49 per-model suites (7 × 7) plus one
  shared unit-suite run containing 87 tests.
- **Coding task:** each model passed five visible tests and 49 holdout tests.

Native SDK usage events were audited against requested model IDs. Passing
cases had no observed SDK model substitution; Claude Code's expected auxiliary
Haiku calls were retained.

These are final-pass results, not first-attempt perfection. In the first SDK
1.0.14 run, Luna's PDF step timed out twice at the existing 180-second limit
and passed on its third allowed attempt. In the second run, Haiku's feature
suite failed its first attempt at `mcp_tool_search` and passed on retry. No
timeout or pass threshold was relaxed. The historical external real-task
runner was unavailable, so the documented isolation/holdout method was
reproduced with a new task shared identically across all seven models.

The 2026-08-25 matrix used a different target set and environment. Its aggregate
results are outside the current scope and are not relabeled as verification
of this seven-model set or included in the totals above.

### Recorded UI rerun, 2026-09-19

The subsequent run used Claude Code 2.1.277 with the same SDK 1.0.14 and
seven-model target set. The shared unit suite passed 88 tests, and every model
passed the six integration suites (base, features, stream, session, worktree,
and background).

The final coding-task outcomes were not uniformly successful: six models
passed all 49 holdouts, while Haiku 4.5 passed 48/49 in both fresh attempts.
Its first attempt accepted a null numeric option; the second accepted a numeric
SKU instead of rejecting it. Sol's first CLI implementation failed stdin
handling and passed a single fresh retry. The original failures were retained,
and neither the generated solutions nor the holdouts were edited to force a
pass. The latest per-case outcome is therefore **49 passed, one failed** across
50 top-level cases.

Separate interactive Claude Code recordings demonstrated Read/Edit/Bash/Write
workflows for all seven models; each passed four independent UI-fixture tests
and an actual SDK model-identity check. The resulting local MP4 is an edited
browser replay of those genuine terminal captures, not a native desktop screen
recording or footage of every full-suite case. Recordings and raw logs are not
tracked in Git. This small two-source-file task and one-subagent workflow do
not establish large-repository, parallel multi-agent, or crash-recovery quality.

## Implementable and Local Feature Groups

| # | Feature group | Status | Evidence or remaining limit |
|---:|---|---|---|
| 1 | Terminal UI and settings preservation | Unit/manual | Real Claude binary; launcher/settings unit tests |
| 2 | Print/headless execution | E2E | Standard and feature E2E |
| 3 | stream-json input/output and replay | E2E | `npm run test:e2e:stream` |
| 4 | Text Messages API and SSE | E2E | Standard E2E and protocol tests |
| 5 | Model discovery, aliases, strict selection | E2E | Seven-model E2E; explicit unknown models fail |
| 6 | Reasoning effort and Ultracode routing | Unit/manual | Model capability tests; no signed thinking |
| 7 | Read, Glob, Grep-style exploration | E2E | Read/Glob live E2E; Grep shares the tool path |
| 8 | Edit and Write | E2E | Feature E2E with file assertions |
| 9 | Bash | E2E | Feature E2E with deterministic stdout |
| 10 | NotebookEdit | E2E | Feature E2E with notebook assertion |
| 11 | Permission modes | E2E | `dontAsk`, `acceptEdits`, and plan-mode flows |
| 12 | Plan mode | E2E | Read-only feature E2E |
| 13 | Hooks | E2E | PostToolUse hook fixture |
| 14 | Skills and slash commands | E2E | Project skill fixture |
| 15 | Plugins | E2E | Local plugin skill fixture |
| 16 | Local MCP tools | E2E | Deterministic stdio MCP fixture and seven-model same-model exhaustive matrix |
| 17 | MCP tool search | Partial | Native deferral stalls with declaration-only tools; the 35-tool fallback passed the seven-model same-model matrix |
| 18 | CLAUDE.md, memory, and rules | Unit/manual | Loaded by Claude Code; no dedicated live fixture yet |
| 19 | Built-in and custom subagents | E2E | Seven-model Agent→Read and feature E2E |
| 20 | Dynamic workflows and local agent teams | Partial | Core subagent primitives pass; broad fan-out/team messaging E2E absent |
| 21 | Background agents and agent view | E2E | Persistent bridge daemon and `test:e2e:background`; Claude Code's own transient daemon/workers may persist for re-adoption |
| 22 | In-session cron and goal loops | E2E | Cron create/list/delete E2E; goal loop shares local scheduler |
| 23 | Worktrees | E2E | Isolated temporary Git repository E2E |
| 24 | Output styles | Partial | Local system-prompt feature; no dedicated E2E |
| 25 | Images | E2E | Real PNG initial image content block |
| 26 | PDF/document attachments | E2E | Valid PDF initial document content block; binary tool-result continuation remains partial |
| 27 | Session resume and fork | E2E | `test:e2e:session` |
| 28 | Checkpoint, rewind, compact | Partial | History shrink reconciliation and cache invalidation implemented; native boundary mapping is not exact |
| 29 | Structured output | E2E | Claude Code JSON Schema validator/retry verified live |
| 30 | `tool_choice` | Partial | `none`, `any`, and named-tool bounded emulation; no native provider control |
| 31 | Request cancellation | Unit/manual | HTTP abort signal reaches `CopilotSession.abort()` |
| 32 | Token/usage/context accounting | Partial | Actual post-call SDK usage; preflight count remains estimated |
| 33 | State lifecycle and restart hardening | Unit/manual | State split diagnostics, replay bound, LRU/TTL, persistent daemon; in-flight crash recovery remains best-effort |
| 34 | IDE/CI/Agent SDK invocation | Partial | Integrated terminal and wrapper-based CI work; independently spawned IDE processes require explicit wrapper configuration |

## Structural Feature Groups

The following eleven groups are excluded from the implementable denominator and
score zero in whole-product equivalence:

1. Remote Control
2. Claude Code on the web, cloud sessions, Teleport, and mobile sessions
3. Artifacts, cloud ultrareview, routines, and Desktop scheduled tasks
4. Anthropic Analytics, billing, subscription usage, SSO, and SCIM
5. Anthropic server-side WebSearch and Advisor
6. Anthropic auto-mode classifier
7. Account-managed MCP connectors, Channels, and Anthropic cross-session messaging
8. Native Anthropic prompt-cache accounting
9. Encrypted thinking signatures and Anthropic reasoning blocks
10. Exact native sampling controls unavailable in the Copilot SDK
11. Anthropic model availability, safety fallback, and Fable consent flows

See [Compatibility](COMPATIBILITY.md) for the reason and alternative for each
group.

## Reproducible Validation

| Command | Scope |
|---|---|
| `npm test` | Protocol, launch, session, daemon, request policy, replay, usage |
| `npm run test:e2e` | Text and Read |
| `npm run test:e2e:gpt-5.6` | GPT-5.6 text and Read |
| `npm run test:e2e:astra` | GPT-6 Astra text and Read smoke test |
| `npm run test:e2e:primary` | Primary seven-model text and Read matrix |
| `npm run test:e2e:features` | Structured output, Edit, Write, NotebookEdit, Bash, hook, skill, plugin, MCP, plan, subagent, image, cron |
| `npm run test:e2e:session` | Resume and fork |
| `npm run test:e2e:background` | Background agent, agent view, bridge-daemon cleanup |
| `npm run test:e2e:stream` | stream-json input/output and replay |
| `npm run test:e2e:worktree` | Git worktree isolation |

Live E2E tests consume GitHub Copilot AI credits.

`test:e2e:background` removes the bridge daemon and its private registry. Claude
Code manages a separate per-user transient daemon and worker roster for
background sessions; that product daemon can remain after the test and is not
stopped automatically because `claude daemon stop --any` is global and could
terminate unrelated user sessions. Run this E2E under an isolated OS user or CI
account when complete process isolation is required.
