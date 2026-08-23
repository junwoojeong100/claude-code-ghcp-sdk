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
- E2E groups: **23**
- Implemented unit/manual groups: **5**
- Partial groups: **6**
- Structural groups: **11**

Calculations:

- **Implementable-scope coverage:** `(23 + 5 + 6 × 0.5) / 34 = 91.2%`
- **Reproducible live E2E coverage:** `23 / 34 = 67.6%`
- **Whole-product equivalence:** `(23 + 5 + 6 × 0.5) / (34 + 11) = 68.9%`

These percentages are versioned estimates for Claude Code 2.1.241 and the pinned
Copilot SDK. They must be recalculated when either product changes.

## Implementable and Local Feature Groups

| # | Feature group | Status | Evidence or remaining limit |
|---:|---|---|---|
| 1 | Terminal UI and settings preservation | Unit/manual | Real Claude binary; launcher/settings unit tests |
| 2 | Print/headless execution | E2E | Standard and feature E2E |
| 3 | stream-json input/output and replay | E2E | `npm run test:e2e:stream` |
| 4 | Text Messages API and SSE | E2E | Standard E2E and protocol tests |
| 5 | Model discovery, aliases, strict selection | E2E | Six-model E2E; explicit unknown models fail |
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
| 16 | Local MCP tools | E2E | Deterministic stdio MCP server fixture |
| 17 | MCP tool search | E2E | 35-tool local MCP fixture crosses the SDK defer threshold; native Claude `tool_reference` blocks remain provider-specific |
| 18 | CLAUDE.md, memory, and rules | Unit/manual | Loaded by Claude Code; no dedicated live fixture yet |
| 19 | Built-in and custom subagents | E2E | Six-model Agent→Read and feature E2E |
| 20 | Dynamic workflows and local agent teams | Partial | Core subagent primitives pass; broad fan-out/team messaging E2E absent |
| 21 | Background agents and agent view | E2E | Persistent daemon and `test:e2e:background` |
| 22 | In-session cron and goal loops | E2E | Cron create/list/delete E2E; goal loop shares local scheduler |
| 23 | Worktrees | E2E | Isolated temporary Git repository E2E |
| 24 | Output styles | Partial | Local system-prompt feature; no dedicated E2E |
| 25 | Images | E2E | Real PNG Read/vision path with bounded retry |
| 26 | PDF/document attachments | E2E | Valid PDF fixture through the live Read/document path |
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
| `npm run test:e2e:features` | Structured output, Edit, Write, NotebookEdit, Bash, hook, skill, plugin, MCP, plan, subagent, image, cron |
| `npm run test:e2e:session` | Resume and fork |
| `npm run test:e2e:background` | Background agent, agent view, daemon cleanup |
| `npm run test:e2e:stream` | stream-json input/output and replay |
| `npm run test:e2e:worktree` | Git worktree isolation |

Live E2E tests consume GitHub Copilot AI credits.
