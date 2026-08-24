# Claude Code 기능 커버리지

> **Language / 언어:** [English](FEATURE_COVERAGE.md) | 한국어

이 표는 source line coverage가 아니라 제품 동작을 측정합니다. 큰 cloud product를
한 항목으로 세고 작은 CLI flag를 각각 세는 왜곡을 피하기 위해 기능을 정규화된
그룹으로 나눕니다.

## 측정 방법

상태 점수:

- **E2E:** 구현됐고 실제 Claude Code + model 재현 테스트가 있음 (`1.0`)
- **Unit/manual:** 구현과 unit 또는 lifecycle 검증은 있으나 저장소 live-model
  E2E가 없음 (`1.0`)
- **Partial:** 유용한 동작은 있으나 native semantics 또는 폭넓은 E2E가 불완전
  (`0.5`)
- **Structural:** Anthropic cloud/account 서비스 또는 Copilot SDK가 제공하지 않는
  provider API가 필요 (`0.0`)

현재 정규화된 개수:

- 구현 가능/local 그룹: **34**
- E2E 그룹: **22**
- 구현 완료 unit/manual 그룹: **5**
- partial 그룹: **7**
- structural 그룹: **11**

계산:

- **구현 가능 범위 커버리지:** `(22 + 5 + 7 × 0.5) / 34 = 89.7%`
- **재현 가능한 live E2E 커버리지:** `22 / 34 = 64.7%`
- **전체 제품 동등성:** `(22 + 5 + 7 × 0.5) / (34 + 11) = 67.8%`

이 비율은 Claude Code 2.1.241과 현재 고정 Copilot SDK 기준의 versioned
estimate입니다. 어느 쪽이든 변경되면 다시 계산해야 합니다.

## 검증 모델 경계

저장소의 live 검증은 다음 6개 model ID를 대상으로 합니다.

- `claude-opus-5`
- `claude-sonnet-5`
- `claude-haiku-4.5`
- `gpt-5.6-sol`
- `gpt-5.6-terra`
- `gpt-5.6-luna`

6개 모델 모두 기본 text/Read E2E를 실행합니다. 핵심 Agent→Read 동작도 호환성
검증 과정에서 6개 모델 전체로 확인했습니다. 확장 feature suite(Edit, Write,
NotebookEdit, Bash, hook, skill, plugin, MCP, plan, image, PDF, cron,
structured output)는 `claude-haiku-4.5`를 기본 대표 모델로 사용하고 image/PDF는
`claude-sonnet-5`를 기본 모델로 사용합니다.
35-tool MCP fallback도 provider 선택 편차를 줄이기 위해 `claude-sonnet-5`를
기본 대표 모델로 사용합니다.

GitHub Copilot catalog에 다른 model ID가 표시되고 generic protocol adapter를 통해
동작할 수는 있지만, 위 6개 이외 모델은 live test matrix에 추가되기 전까지 이
프로젝트가 호환성을 **보증하지 않습니다**.

## 구현 가능·local 기능 그룹

| # | 기능 그룹 | 상태 | 근거 또는 남은 한계 |
|---:|---|---|---|
| 1 | Terminal UI와 settings 보존 | Unit/manual | 실제 Claude binary, launcher/settings unit test |
| 2 | Print/headless 실행 | E2E | 기본·feature E2E |
| 3 | stream-json 입출력과 replay | E2E | `npm run test:e2e:stream` |
| 4 | Text Messages API와 SSE | E2E | 기본 E2E와 protocol test |
| 5 | Model discovery, alias, strict selection | E2E | 6모델 E2E, 명시적 unknown model 실패 |
| 6 | Reasoning effort와 Ultracode routing | Unit/manual | Model capability test, signed thinking은 제외 |
| 7 | Read, Glob, Grep 계열 탐색 | E2E | Read/Glob live E2E, Grep은 같은 tool 경로 |
| 8 | Edit와 Write | E2E | File assertion feature E2E |
| 9 | Bash | E2E | Deterministic stdout feature E2E |
| 10 | NotebookEdit | E2E | Notebook assertion feature E2E |
| 11 | Permission mode | E2E | `dontAsk`, `acceptEdits`, plan mode |
| 12 | Plan mode | E2E | Read-only feature E2E |
| 13 | Hooks | E2E | PostToolUse hook fixture |
| 14 | Skills와 slash command | E2E | Project skill fixture |
| 15 | Plugins | E2E | Local plugin skill fixture |
| 16 | Local MCP tool | E2E | Deterministic stdio MCP server |
| 17 | MCP tool search | Partial | Declaration-only tool에서 native deferral이 stall해 35-tool full-schema fallback을 E2E 검증 |
| 18 | CLAUDE.md, memory, rules | Unit/manual | Claude Code가 load; 전용 live fixture는 없음 |
| 19 | Built-in/custom subagent | E2E | 6모델 Agent→Read와 feature E2E |
| 20 | Dynamic workflow와 local agent team | Partial | 핵심 subagent primitive는 통과, 대규모 fan-out/team messaging E2E 없음 |
| 21 | Background agent와 agent view | E2E | Persistent daemon과 `test:e2e:background` |
| 22 | In-session cron과 goal loop | E2E | Cron create/list/delete E2E, goal은 같은 local scheduler |
| 23 | Worktree | E2E | 격리된 임시 Git repository E2E |
| 24 | Output style | Partial | Local system-prompt 기능, 전용 E2E 없음 |
| 25 | Images | E2E | 실제 PNG initial image content block |
| 26 | PDF/document attachment | E2E | 유효 PDF initial document content block; binary tool-result continuation은 partial |
| 27 | Session resume와 fork | E2E | `test:e2e:session` |
| 28 | Checkpoint, rewind, compact | Partial | History 축소 reconciliation과 cache invalidation 구현, native boundary mapping은 부정확 |
| 29 | Structured output | E2E | Claude Code JSON Schema validator/retry live 검증 |
| 30 | `tool_choice` | Partial | `none`, `any`, named-tool bounded emulation, native provider control은 아님 |
| 31 | Request cancellation | Unit/manual | HTTP abort signal을 `CopilotSession.abort()`로 전달 |
| 32 | Token/usage/context 회계 | Partial | Call 이후 실제 SDK usage, preflight count는 추정 |
| 33 | State lifecycle과 restart hardening | Unit/manual | State split 진단, replay 상한, LRU/TTL, persistent daemon; in-flight crash recovery는 best-effort |
| 34 | IDE/CI/Agent SDK invocation | Partial | Integrated terminal/wrapper 기반 CI는 동작, 독립 IDE process는 wrapper 명시 설정 필요 |

## 구조적 기능 그룹

다음 11개 그룹은 구현 가능 분모에서 제외하고 전체 제품 동등성에서는 0점입니다.

1. Remote Control
2. Claude Code on the web, cloud session, Teleport, mobile session
3. Artifacts, cloud ultrareview, routines, Desktop scheduled tasks
4. Anthropic Analytics, billing, subscription usage, SSO, SCIM
5. Anthropic server-side WebSearch와 Advisor
6. Anthropic auto-mode classifier
7. Account-managed MCP connector, Channels, Anthropic cross-session messaging
8. Native Anthropic prompt-cache accounting
9. Encrypted thinking signature와 Anthropic reasoning block
10. Copilot SDK에 없는 정확한 native sampling control
11. Anthropic model availability, safety fallback, Fable consent

각 그룹의 이유와 대안은 [호환성](COMPATIBILITY_KO.md)을 참고하세요.

## 재현 가능한 검증

| 명령 | 범위 |
|---|---|
| `npm test` | Protocol, launch, session, daemon, request policy, replay, usage |
| `npm run test:e2e` | Text와 Read |
| `npm run test:e2e:gpt-5.6` | GPT-5.6 text와 Read |
| `npm run test:e2e:features` | Structured output, Edit, Write, NotebookEdit, Bash, hook, skill, plugin, MCP, plan, subagent, image, cron |
| `npm run test:e2e:session` | Resume와 fork |
| `npm run test:e2e:background` | Background agent, agent view, daemon cleanup |
| `npm run test:e2e:stream` | stream-json 입출력과 replay |
| `npm run test:e2e:worktree` | Git worktree 격리 |

Live E2E는 GitHub Copilot AI Credits를 사용합니다.
