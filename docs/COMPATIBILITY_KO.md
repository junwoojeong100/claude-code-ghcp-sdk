# Claude Code 호환성

> **언어 / Language:** [English](COMPATIBILITY.md) | 한국어

Claude Code는 여전히 사용자 컴퓨터에서 실행되므로 UI, 도구, 권한, 훅, MCP 서버,
스킬은 평소와 같이 동작합니다. 브리지는 모델 호출만 바꿔서 Anthropic 대신 GitHub
Copilot으로 보냅니다. Anthropic 서버에서 실행되는 기능은 동작하지 않고, 일부 요청
값은 받기만 하고 적용하지 않습니다.

## 기능별 확인

상태는 구현 지원 여부이며 실측 통과를 뜻하지 않습니다. **지원함**은 브리지에서
지원하거나 Claude Code가 로컬에서 처리한다는 뜻이고, **차이 있음**은 행의 제한을
적용합니다. **예상 동작**은 계속 동작할 것으로 보는 클라이언트 동작이지만 실측 행렬이
검사하지 않는 것이며, 마지막 열은 늘 `없음`입니다. **지원하지 않음**과 **불가능**의
이유는 각 행과 [구조적 한계](#구조적-한계)에 있습니다.

"실측 행렬 검사"는 V01–V06의 강제 검사 범위이지 통과 기록이 아닙니다. `없음`은 그
범위 밖이라는 뜻입니다. 전체 통과에는
**모델 6개 × 시나리오 6개 = 슬롯 36개 통과**와 무결성·격리·정리 검사가 필요합니다.
기록된 결과와 범위는 [검증 결과](VERIFICATION_KO.md), 통과 기준은
[테스트](TESTING_KO.md#통과의-의미)를 보세요. production 오프라인 회귀 테스트는
별도의 근거입니다. 실행기가 비공개 Direct 브리지를 직접 시작하므로 아래 어느 행도
production 런처나 공유 데몬을 실측 검증했다고 주장하지 않습니다.

### 도구

| 기능 | 상태 | 달라지는 점 | 실측 행렬 검사 |
|---|---|---|---|
| Read, Edit, Write | 지원함 | | V02: 숨은 sample·소스·테스트 Read와 정확한 할인 계산 Edit. Write는 없음 |
| Bash와 오래 실행되는 명령 | 지원함 | | V02: 지정한 foreground 테스트, 테스트 3개가 모두 통과하는 재검사와 독립 재검사. 장시간·백그라운드 명령은 없음 |
| NotebookEdit | 예상 동작 | | 없음 |
| git과 git worktree | 지원함 | | 없음 |
| 실패한 도구 호출과 복구 | 지원함 | | V02: 할인 계산 회귀 실패 → Edit → 재검사. V03: 예상한 MCP ENOENT → 숨은 값 조회 → 같은 프로세스에서 회상 |
| 한 턴 안의 여러 도구 호출 | 지원함, 차이 있음 | 요청 하나가 한 번에 돌려줄 수 있는 도구 결과는 `MAX_TOOL_RESULTS`(기본 32)개까지입니다. 이보다 많으면 그 요청은 500 `api_error`로 실패합니다. | 없음 |
| MCP 서버와 그 도구 | 지원함, 차이 있음 | 모든 MCP 도구의 전체 스키마를 요청마다 보냅니다. Copilot CLI 자체의 MCP 서버는 브리지 세션에서 시작하지 않게 막습니다([자세히](ARCHITECTURE_KO.md#copilot-런타임-mcp-서버)). | V03: CLI 소유 로컬 MCP fixture의 도구 ID·인수·결과·ledger 일치. 외부 MCP 서비스는 없음 |
| MCP 도구 검색(`ToolSearch`) | 지원함, 차이 있음 | 기본값은 꺼짐입니다. `GHCP_NATIVE_TOOL_SEARCH=1`이면 Claude Code의 ToolSearch가 켜집니다. 그래도 브리지는 모든 도구를 Copilot에 보내고, 도구 참조는 `[tool_reference "name"]`라는 텍스트로 모델에 전달됩니다. | 없음 |
| 세션 안의 예약 작업(`CronCreate`, `CronList`) | 지원함 | | 없음 |
| WebFetch | 예상 동작 | Claude Code가 사용자 컴퓨터에서 페이지를 가져옵니다. | 없음 |
| WebSearch | 불가능 | Anthropic이 자기 서버에서 실행합니다. | — |

### 에이전트와 프로젝트 설정

| 기능 | 상태 | 달라지는 점 | 실측 행렬 검사 |
|---|---|---|---|
| 서브에이전트와 프로젝트 에이전트(`.claude/agents`) | 지원함 | | 없음 |
| Explore와 모델을 지정하지 않은 서브에이전트 | 지원함, 차이 있음 | 시작할 때 고른 모델로 실행됩니다. 런처의 설정이 없으면 GPT 모델로 시작했을 때 Claude Code가 Explore를 Opus 모델로 보냅니다([모델](../README_KO.md#모델)). | 없음 |
| CLAUDE.md 지침 | 지원함 | | 없음 |
| 훅(도구를 차단하는 훅 포함) | 지원함 | | 없음 |
| 커스텀 슬래시 명령, 스킬, 플러그인 | 예상 동작 | | 없음 |
| 출력 스타일과 사용자 지정 시스템 프롬프트 | 예상 동작 | 그 내용이 시스템 지시로 모델에 전달됩니다. | 없음 |
| 권한 모드 | 지원함 | Claude Code가 사용자 컴퓨터에서 적용합니다. | V02/V03의 범위를 제한한 도구 격리와 도구 없는 턴. 모든 모드나 승인 창 검사는 아님 |
| 권한 확인 창 | 예상 동작 | | 없음 |
| 명령줄의 `--settings` | 지원하지 않음 | 브리지로 가는 경로를 끌 수 있어서 런처가 거부합니다. 사용자의 설정 파일은 그대로 읽힙니다([자세히](../README_KO.md#사용자-설정은-건드리지-않습니다)). | — |

### 모델

| 기능 | 상태 | 달라지는 점 | 실측 행렬 검사 |
|---|---|---|---|
| `/model` 목록 | 지원함, 차이 있음 | GitHub Copilot 모델 6개가 나옵니다([모델](../README_KO.md#모델)). | V01: native 6개 모델 picker. V04: 같은 세션에서 다른 source 모델에서 target으로 전환 |
| `--ghcp-model`과 `GHCP_MODEL` | 지원함, 차이 있음 | Claude Code의 `--model` 대신 씁니다. 런처는 `--model`을 거부합니다. | 없음: production 런처는 실행하지 않음 |
| `/effort`, `--effort`, Ultracode | 지원함, 차이 있음 | Copilot에 전달합니다. 모델 목록에 없는 단계는 목록에 있는 단계로 바꾸고, Ultracode는 `xhigh`로 보냅니다([모델](../README_KO.md#모델)). | V04: 지원 target의 High effort와 실제 SDK 상태, Haiku의 effort 미적용. 모든 수준·플래그·Ultracode 검사는 아님 |
| 실제로 응답한 모델 | 지원함, 차이 있음 | Claude Code는 자신이 요청한 모델을 표시합니다. `bridge.turn_completed` 로그 줄의 `servedModels`에는 SDK 사용량이 보고한 모델이 남으며, 빈 목록은 알 수 없다는 뜻입니다. 이 확인은 SDK 보고 ID에 한정되며 제공자 내부 구현을 독립적으로 증명하지 않습니다([로그 읽기](DIAGNOSTICS_KO.md#주요-필드-읽기)). | V01–V06 완료 응답: 응답 ID와 연결한 모든 SDK 보고 ID가 단계의 기대 모델과 일치 |
| 6개 밖의 모델 | 예상 동작 | `./bin/ghcp-models`에 나오는 ID를 `--ghcp-model`에 넘기면 됩니다. | 없음 |

### 세션과 컨텍스트

| 기능 | 상태 | 달라지는 점 | 실측 행렬 검사 |
|---|---|---|---|
| 대화형 세션 | 지원함, 차이 있음 | production 실행은 함께 쓰는 [상주 브리지](../README_KO.md#백그라운드-브리지)를 씁니다. | V01, V03–V06: 비공개 Direct 브리지를 통한 native PTY 조작. 공유 데몬은 아님 |
| print 모드(`-p`)와 `stream-json` | 지원함, 차이 있음 | `-p`는 런처가 끝나면 함께 멈추는 전용 브리지를 씁니다. `--background`나 `agents`와 함께 쓰면 상주 브리지를 씁니다. | V01: 정확한 print 응답. V02: 코딩·도구 결과. 런처 수명 주기는 아님 |
| `--resume`, `--continue`, `--fork-session` | 지원함, 차이 있음 | 실행 중인 브리지에 그 대화의 Copilot 세션이 없으면(예: 재시작 뒤) 저장된 기록을 다시 보내며, 최신 메시지부터 `MAX_REPLAY_BYTES`까지만 담습니다. | V06: 정상 종료·정리 뒤 새 CLI·비공개 브리지에서 정확한 세션으로 --resume. --continue·포크·충돌·진행 중인 턴 복구는 없음 |
| `/clear` | 지원함 | Claude Code가 새 대화를 시작합니다. | V01: 새 세션 ID와 다음 요청에서 이전 대화 제거 |
| `/rewind`와 수정된 기록 | 예상 동작 | 기록이 더 이상 맞지 않으면 브리지는 Copilot 세션을 버리고 Claude Code가 보낸 기록으로 새 세션을 시작합니다. | 없음 |
| `--background`와 `agents` 화면 | 지원함, 차이 있음 | `-p`를 뺀 모든 실행이 상주 브리지 하나를 함께 쓰며, 이 브리지는 Claude Code가 끝난 뒤에도 계속 실행됩니다([자세히](../README_KO.md#백그라운드-브리지)). | 없음 |
| 대화형 세션에서 `/background` | 예상 동작 | 같은 상주 브리지를 씁니다. | 없음 |
| 큰 컨텍스트 | 지원함, 차이 있음 | Copilot 런타임의 입력 한도는 Claude Code가 잡는 컨텍스트 창보다 작을 수 있습니다([모델](../README_KO.md#모델)). | 없음 |
| 압축(`/compact`와 자동 압축) | 지원함, 차이 있음 | 압축은 여전히 Claude Code가 합니다. Copilot이 스스로 기록을 줄이기 시작하려 하면 브리지가 400 `prompt is too long` 오류로 턴을 끝내서 Claude Code가 압축하게 합니다([긴 대화](../README_KO.md#긴-대화)). | V06: 수동 /compact 요약 요청과 native 경계, seed 프롬프트 없이 압축된 기록을 받은 새 SDK 세션의 회상, 콜드 재개 뒤 다시 정확한 회상. 자동 초과 압축은 없음 |
| 토큰 수 | 지원함, 차이 있음 | 응답 뒤에는 SDK가 보고한 사용량을 쓰고 없는 값만 추정하며, 캐시된 입력은 Anthropic의 캐시 필드로 나눠 보고합니다. 응답 전 계산(`/v1/messages/count_tokens`)은 요청 JSON 길이를 4로 나눈 추정치이고, `x-ghcp-token-count-method: estimated` 헤더로 표시합니다. | V01–V06 완료 응답: 유효한 사용량·입출력 활동. 토큰 계산 정확도는 없음 |
| 프롬프트 캐싱 | 불가능 | `cache_control` 표시는 효과가 없습니다. 캐시 필드는 Copilot 자체 캐시를 나타냅니다. | — |

### 입력과 출력

| 기능 | 상태 | 달라지는 점 | 실측 행렬 검사 |
|---|---|---|---|
| 스트리밍 | 지원함 | | V01/V02: print 스트림 완료와 도구 왕복. V05: 실제 스트리밍 중 Escape와 같은 프로세스에서 복구. 모든 SSE 프레임 경계 검사는 아님 |
| Unicode 텍스트 | 지원함 | | V01: native 터미널의 정확한 새 Unicode 응답 |
| `--json-schema` | 지원함, 차이 있음 | Claude Code가 결과를 스키마로 확인하고 스스로 다시 시도합니다. 브리지는 `output_config.format`을 적용하지 않습니다. | 없음 |
| 도구가 읽은 이미지와 PDF | 지원함 | Copilot에 첨부 파일로 보냅니다. 받아들이는지는 모델에 따라 다릅니다. | 없음 |
| 프롬프트에 넣은 이미지와 PDF | 예상 동작 | Copilot에 첨부 파일로 보냅니다. | 없음 |
| 확장 사고(extended thinking) | 불가능 | `thinking` 필드는 무시하고 응답에 사고 블록이 없습니다. 대신 reasoning effort를 전달합니다. | — |
| 응답 중단(Esc) | 지원함 | 대기 중인 요청은 버리고 실행 중인 Copilot 턴은 멈춥니다. | V05: 실제 스트리밍 중 Escape, 같은 요청의 client_abort·SDK 중단 확인, 같은 native 프로세스·세션에서 정확한 복구 |

### 오류와 요청 값

| 기능 | 상태 | 달라지는 점 | 실측 행렬 검사 |
|---|---|---|---|
| Copilot 요청 한도와 장애 | 지원함, 차이 있음 | Copilot이 먼저 다시 시도하며, 기다리는 동안에는 아무것도 스트리밍되지 않습니다. 그래도 실패하면 Claude Code에 429나 529로 전달되고 Claude Code가 다시 시도합니다([상태 표](DIAGNOSTICS_KO.md#업스트림-오류)). | 없음 |
| 길거나 멈춘 턴 | 지원함, 차이 있음 | 기본값으로는 모델 진행 없이 5분이 지나거나 전체 30분이 지나면 턴이 실패합니다([타임아웃](../README_KO.md#요청-한도와-타임아웃)). | 없음 |
| `tool_choice` | 지원함, 차이 있음 | 도구를 걸러 내고 지시를 덧붙여 흉내 냅니다([적용하지 않는 요청 값](#적용하지-않는-요청-값)). | 없음 |
| `temperature`, `top_p`, `max_tokens`, `stop_sequences` | 불가능 | 받기만 하고 적용하지 않습니다([적용하지 않는 요청 값](#적용하지-않는-요청-값)). | — |

### Claude Code를 실행하는 곳

| 기능 | 상태 | 달라지는 점 | 실측 행렬 검사 |
|---|---|---|---|
| IDE 통합 터미널(VS Code, JetBrains)에서 `claude-ghcp` 실행 | 예상 동작 | 다른 터미널과 같습니다. | 없음 |
| IDE 확장이나 Claude Desktop이 시작한 Claude Code | 지원하지 않음 | 이 저장소의 런처를 거치지 않으므로 요청이 브리지로 가지 않습니다. | — |
| Windows 기본 셸 | 지원하지 않음 | 런처가 bash 스크립트입니다. | — |
| Remote Control | 불가능 | `ANTHROPIC_BASE_URL`이 Anthropic 주소가 아니면 Claude Code가 끕니다. | — |
| 웹의 Claude Code, `--cloud`, `--teleport`, 모바일 세션, 클라우드 ultrareview | 불가능 | Anthropic 컴퓨터에서 실행되어 브리지에 닿지 않습니다. | — |
| Artifacts, routines, Desktop 예약 작업, Anthropic Analytics, 결제, SSO/SCIM | 불가능 | Anthropic 계정 서비스입니다([구조적 한계](#구조적-한계)). | — |


## 구조적 한계

아래 기능은 Anthropic 서버나 모델 서비스의 기능에 의존하므로, Messages API와
호환되는 어떤 브리지로도 다시 만들 수 없습니다.

| 기능 | 브리지로 제공할 수 없는 이유 | 대안 |
|---|---|---|
| Remote Control | `ANTHROPIC_BASE_URL`이 Anthropic이 아닌 주소를 가리키면 Claude Code가 Remote Control을 끕니다. Remote Control은 Anthropic 서버를 거쳐 연결됩니다. | 로컬 터미널이나 IDE 통합 터미널을 쓰세요. |
| 웹의 Claude Code, `--cloud`, `--teleport`, 모바일 세션, 클라우드 ultrareview | Anthropic이 관리하는 컴퓨터에서 실행되고 claude.ai 계정 세션이 필요합니다. | 로컬에서 실행하거나 공식 지원 Claude 공급자를 쓰세요. |
| Artifacts, routines, Desktop 예약 작업 | 게시와 예약은 모델 API 호출이 아니라 claude.ai 서비스입니다. | 로컬 파일, 로컬 에이전트, 외부 스케줄러를 쓰세요. |
| Anthropic Analytics, 결제, 구독 사용량, SSO/SCIM | Anthropic 계정·조직 API입니다. Copilot 사용량은 GitHub가 따로 집계합니다. | GitHub Copilot 사용량과 조직 사용량 보고서를 쓰세요. |
| WebSearch, auto 모드의 분류기, Channels, claude.ai MCP 커넥터 | 모델 API가 아니라 Anthropic 서버에서 실행됩니다. | WebFetch(실제 검증 안 함), 직접 설정한 MCP 서버, 로컬 권한 모드를 쓰세요. |
| 프롬프트 캐싱 | `cache_control` 구간 표시와 그것이 다루는 캐시는 Anthropic 모델 서비스에 속합니다. Copilot SDK에는 캐시 구간을 지정하는 설정이 없습니다. | 없음 |
| 사고 블록과 그 서명 | Copilot SDK는 Anthropic 사고 블록에 붙는 암호 서명을 만들 수 없습니다. | `/effort`를 쓰세요. reasoning effort는 전달됩니다. |
| `temperature`, `top_p`, `max_tokens`, `stop_sequences`, 원래 의미의 `tool_choice` | Copilot SDK에 해당 설정이 없고, 프롬프트로 모델에 요청하는 것은 같은 동작이 아닙니다. | 없음. [적용하지 않는 요청 값](#적용하지-않는-요청-값)을 참고하세요. |
| Anthropic의 모델 접근 확인, 안전 대체 처리(safety fallback), Claude Fable 동의 절차 | Anthropic 조직 정책과 결제에 묶여 있습니다. | 쓸 수 있는 모델은 Copilot 모델 카탈로그와 조직의 Copilot 정책이 정합니다. `./bin/ghcp-models`로 목록을 확인하세요. |

## 아직 구현하지 않은 것

아래 공백은 구조적 한계가 아닙니다. 행에 Copilot SDK 때문에 막혀 있다고 적은
경우가 아니면 이 저장소에서 메울 수 있습니다.

| 공백 | 현재 동작 |
|---|---|
| 브리지 프로세스가 끝날 때 진행 중이던 턴의 복구 | Claude Code의 대기 중인 도구 호출과 Copilot 요청을 잇는 정보는 브리지 메모리에만 있습니다. Claude Code는 대화를 재개할 수 있지만, 중단된 턴이 끝까지 진행된다는 보장은 없습니다. |
| 다시 보낸 메시지 알아보기 | 요청에 대조할 고정 식별자가 없어서, Claude Code가 다시 보낸 메시지를 새 메시지로 처리합니다. 다시 보낸 도구 결과는 알아봅니다. |
| Copilot의 지연 도구 로딩 | 꺼져 있습니다. 브리지는 모든 도구를 `defer: "never"`로 선언하므로, 모든 도구의 전체 스키마가 요청마다 Copilot으로 갑니다. 지연 방식에서는 브리지가 선언만 하고 Claude Code가 실행하는 도구가 멈출 수 있습니다. Copilot SDK의 이 동작 때문에 막혀 있습니다. |
| 인용(citations) | 인용을 Claude Code에 돌려주지 않습니다. |
| 이후 Claude Code 릴리스가 추가하는 요청 필드 | `src/request-policy.mjs`의 두 목록 어디에도 없는 필드는 읽지도 보고하지도 않습니다. Claude Code 릴리스마다 검토해야 합니다. |

## 적용하지 않는 요청 값

브리지는 적용할 수 없는 요청 필드를 세 가지 방식 중 하나로 처리합니다. 요청을
거부하거나, 흉내 내거나, 받되 적용하지 않습니다. 근사치를 Anthropic의 동작이라고
내세우지 않습니다. 아래 목록은 `src/request-policy.mjs`의 `DEGRADED_CONTROLS`,
`IGNORED_FIELDS`와 같습니다.

### `tool_choice`

| 요청 | 브리지 동작 |
|---|---|
| `auto` 또는 `tool_choice` 없음 | 바꾸지 않습니다. |
| `none` | 요청에서 도구를 뺍니다. |
| `any` | 모든 도구를 두고 "You must call at least one available tool before answering." 지시를 덧붙입니다. 선언된 도구가 없으면 400 `invalid_request_error`로 거부합니다. |
| 이름이 있는 `tool` | 지정한 도구만 남기고 그 도구를 호출하라는 지시를 덧붙입니다. 그 도구가 선언되지 않았으면 400 `invalid_request_error`로 거부합니다. |
| 그 밖의 모드(이름이 없는 `tool` 포함) | 400 `invalid_request_error`로 거부합니다. |

모델은 여전히 도구를 호출하지 않고 답할 수 있습니다.

### 받되 적용하지 않는 값

Copilot SDK는 아래 샘플링 값을 제공하지 않습니다. Claude Code 요청은 항상
`max_tokens`를 설정하므로, 이 값들을 거부하면 평범한 요청까지 실패합니다.

| 필드 | 효과 |
|---|---|
| `temperature` | 적용하지 않습니다. |
| `top_p` | 적용하지 않습니다. |
| `max_tokens` | 적용하지 않습니다. 응답 길이는 Copilot이 정합니다. |
| `stop_sequences` | 적용하지 않습니다. 응답이 이 문자열에서 멈추지 않습니다. |

### 받고 무시하는 값

브리지는 아래 필드를 전혀 읽지 않습니다.

| 필드 | 참고 |
|---|---|
| `thinking` | 사고 블록을 돌려주지 않습니다. `output_config.effort`는 계속 적용합니다. |
| `top_k` | |
| `metadata` | |
| `service_tier` | |
| `speed` | |
| `container` | |
| `mcp_servers` | Claude Code에 설정한 MCP 서버에는 영향이 없습니다. |
| `context_management` | |
| `output_config.format` | Claude Code가 결과를 직접 검사하므로 `--json-schema`는 계속 동작합니다. |
| `output_config.task_budget` | |
| `tool_choice.disable_parallel_tool_use` | 병렬 도구 호출은 계속 허용됩니다. |

보고 없이 버리는 것이 두 가지 있습니다. `cache_control` 구간 표시와, 두 목록
어디에도 없는 필드입니다.

### 보고되는 곳

- **브리지 로그**: 이 필드 중 하나를 설정한 `/v1/messages` 요청마다
  `bridge.degraded_controls` 줄을 하나 남기며, 여기에 `controls`와 (있으면)
  `ignoredFields`가 들어갑니다. Claude Code는 항상 `max_tokens`를 보내므로 사실상
  모든 요청이 한 줄씩 남깁니다. 상주 브리지는
  [브리지 디렉터리](../README_KO.md#백그라운드-브리지)의 `bridge.log`에 기록하고,
  `claude-ghcp-stop`을 실행하면 이 로그가 지워집니다. print 모드(`-p`) 브리지의
  로그는 런처가 끝날 때 지워집니다.
- **`GET /health`**: `capabilities.unsupportedNativeControls`와
  `capabilities.ignoredRequestFields`에 위 필드 이름이 나옵니다. 고정된 목록이며,
  특정 요청을 보고하는 것이 아닙니다. 이 경로에는 토큰이 필요 없습니다.
- **응답에는 없음**: Claude Code에 가는 응답에는 아무 표시가 없습니다. 이런
  보장이 필요한 호출자는 응답이 아니라 브리지를 확인해야 합니다.

## 참고 자료

- [Claude Code 기능 가용성](https://code.claude.com/docs/en/feature-availability)
- [Claude Code 게이트웨이 프로토콜](https://code.claude.com/docs/en/llm-gateway-protocol)
- [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control)
- [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web)
- [Claude Code 모델 설정](https://code.claude.com/docs/en/model-config)
