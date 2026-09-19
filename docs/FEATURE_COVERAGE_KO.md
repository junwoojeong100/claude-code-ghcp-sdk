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

이 비율은 Claude Code 2.1.241과 Copilot SDK 1.0.10-preview.0 기준의 과거
추정치입니다. SDK 1.0.14 기준으로 다시 산정한 수치는 아닙니다.

## 검증 모델 경계

현재 live 검증 matrix의 대상은 정확히 다음 7개 model ID입니다.

- `claude-opus-5`
- `claude-sonnet-5`
- `claude-haiku-4.5`
- `gpt-5.6-sol`
- `gpt-5.6-terra`
- `gpt-5.6-luna`
- `gpt-6-astra`

7개 모델 모두 기본 text/Read E2E를 실행합니다. 핵심 Agent→Read 동작도 호환성
검증 과정에서 7개 모델 전체로 확인했습니다. 확장 feature suite(Edit, Write,
NotebookEdit, Bash, hook, skill, plugin, MCP, plan, image, PDF, cron,
structured output)는 `claude-haiku-4.5`를 기본 대표 모델로 사용하고 image/PDF는
`claude-sonnet-5`를 기본 모델로 사용합니다.
35-tool MCP fallback도 provider 선택 편차를 줄이기 위해 `claude-sonnet-5`를
기본 대표 모델로 사용합니다.
이 대표 모델은 단독 feature suite 실행의 기본값을 설명합니다.
[전수검사 절차](EXHAUSTIVE_TESTING_KO.md)는 primary, multimodal, MCP model을
선택한 각 모델과 동일하게 지정하며, 아래 SDK 1.0.14 검증에서 7개 모델 모두
same-model feature, MCP, image, PDF assertion을 통과했습니다.

Catalog 노출만으로 호환성이 검증되지는 않습니다. `gpt-5.5`와 명시된 검증 대상
밖의 모델은 이 matrix로 확인하지 않았습니다. `npm run test:e2e:astra`는
계속 text/Read smoke test이며 전체 matrix를 대신하지 않습니다.

### SDK 1.0.14 검증, 2026-09-18–19

Claude Code 2.1.276과 정식 SDK 1.0.14(내장 runtime 1.0.85)에서 위 7개 모델을
검증했습니다.

- **최종 결과:** 모델별 7개 suite(base text/Read, features, stream, session,
  worktree, background, 한국어 코딩 과제)가 모두 통과했습니다.
- **집계:** 모델별 suite 49개(7 × 7)와 87개 테스트를 포함한 공유 unit suite
  1회를 합친 top-level case 50개가 통과했습니다.
- **코딩 과제:** 각 모델이 공개 테스트 5개와 holdout 테스트 49개를 통과했습니다.

SDK usage event로 요청 모델과 실제 실행 모델을 대조했습니다. 통과 case에서
SDK 모델 자동 대체는 관찰되지 않았으며, Claude Code의 정상적인 Haiku 보조 호출은
유지했습니다.

이는 재시도를 포함한 최종 통과이며 첫 시도 전부 성공을 뜻하지 않습니다. 첫 번째
SDK 1.0.14 실행에서 Luna의 PDF 단계는 기존 180초 제한에서 두 차례 timeout 후
세 번째 허용된 시도에 통과했습니다. 두 번째 실행에서는 Haiku의 feature suite가
첫 시도에 `mcp_tool_search`에서 실패한 후 재시도에 통과했습니다. 제한 시간이나
통과 기준을 완화하지 않았습니다. 과거 외부 real-task runner가 남아 있지 않아
문서화된 격리/holdout 방식으로 새 과제를 만들었고, 7개 모델에 동일하게 사용했습니다.

2026-08-25 matrix는 대상과 환경이 달랐습니다. 당시 집계는 현재 검증 범위에서
제외하며, 현재 7개 모델의 검증 결과로 바꾸어 표기하거나 위 집계에 합산하지 않습니다.

### 실제 UI 녹화 재검증, 2026-09-19

이후 실행은 Claude Code 2.1.277, 동일한 SDK 1.0.14와 7개 대상 모델을 사용했습니다.
공유 단위 테스트 88개와 모델별 연동 suite 6개(base, features, stream, session,
worktree, background)는 모두 통과했습니다.

실전 코딩 과제는 모두 성공하지는 않았습니다. 6개 모델은 holdout 49개를 통과했지만
Haiku 4.5는 두 번의 독립 실행 모두 48/49였습니다. 첫 실행은 null 숫자 옵션을,
두 번째는 숫자 SKU를 거절하지 못했습니다. Sol은 첫 CLI 구현의 stdin 처리에서
실패한 뒤 한 번의 새 실행에서 통과했습니다. 최초 실패 기록을 보존했고 통과를 위해
생성된 코드나 holdout을 고치지 않았습니다. 따라서 최신 case별 집계는 top-level
50개 중 **49개 통과, 1개 실패**입니다.

별도의 실제 Claude Code 대화형 녹화에서는 7개 모델 모두 Read/Edit/Bash/Write
작업, UI fixture의 독립 테스트 4개와 실제 SDK 모델 ID 확인을 통과했습니다.
로컬 MP4는 이 실제 터미널 원본의 브라우저 재생 편집본이며, macOS 화면 자체나
전체 suite의 모든 case를 촬영한 영상은 아닙니다. 영상과 원본 로그는 Git에
포함하지 않습니다. 작은 소스 파일 2개와 단일 subagent 흐름을 검증한 결과를
대규모 저장소, 병렬 다중 에이전트, 장애 복구 품질의 검증으로 확대 해석하면 안 됩니다.

## 구현 가능·local 기능 그룹

| # | 기능 그룹 | 상태 | 근거 또는 남은 한계 |
|---:|---|---|---|
| 1 | Terminal UI와 settings 보존 | Unit/manual | 실제 Claude binary, launcher/settings unit test |
| 2 | Print/headless 실행 | E2E | 기본·feature E2E |
| 3 | stream-json 입출력과 replay | E2E | `npm run test:e2e:stream` |
| 4 | Text Messages API와 SSE | E2E | 기본 E2E와 protocol test |
| 5 | Model discovery, alias, strict selection | E2E | 7모델 E2E, 명시적 unknown model 실패 |
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
| 16 | Local MCP tool | E2E | Deterministic stdio MCP fixture와 7모델 same-model 전수검사 |
| 17 | MCP tool search | Partial | Native deferral은 stall하지만 35-tool fallback은 7모델 same-model matrix 통과 |
| 18 | CLAUDE.md, memory, rules | Unit/manual | Claude Code가 load; 전용 live fixture는 없음 |
| 19 | Built-in/custom subagent | E2E | 7모델 Agent→Read와 feature E2E |
| 20 | Dynamic workflow와 local agent team | Partial | 핵심 subagent primitive는 통과, 대규모 fan-out/team messaging E2E 없음 |
| 21 | Background agent와 agent view | E2E | Persistent bridge daemon과 `test:e2e:background`; Claude Code 자체 transient daemon/worker는 재연결을 위해 남을 수 있음 |
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
| `npm run test:e2e:astra` | GPT-6 Astra text와 Read smoke test |
| `npm run test:e2e:primary` | 주력 7모델 text와 Read matrix |
| `npm run test:e2e:features` | Structured output, Edit, Write, NotebookEdit, Bash, hook, skill, plugin, MCP, plan, subagent, image, cron |
| `npm run test:e2e:session` | Resume와 fork |
| `npm run test:e2e:background` | Background agent, agent view, bridge-daemon cleanup |
| `npm run test:e2e:stream` | stream-json 입출력과 replay |
| `npm run test:e2e:worktree` | Git worktree 격리 |

Live E2E는 GitHub Copilot AI Credits를 사용합니다.

`test:e2e:background`는 bridge daemon과 private registry를 정리합니다. Claude Code는
background session용 별도 per-user transient daemon과 worker roster를 관리하며, 이
product daemon은 테스트 후에도 남을 수 있습니다. `claude daemon stop --any`는 전역
명령으로 다른 사용자 session까지 종료할 수 있어 테스트가 자동 실행하지 않습니다.
완전한 process 격리가 필요하면 별도 OS user 또는 CI account에서 실행해야 합니다.
