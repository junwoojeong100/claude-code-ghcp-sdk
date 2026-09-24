# 아키텍처

> **언어 / Language:** [English](ARCHITECTURE.md) | 한국어

이 브리지는 Claude Code가 GitHub Copilot 모델을 쓰게 해 주는 로컬 HTTP 서버입니다.
Claude Code 쪽으로는 Anthropic Messages API로 응답하고, 반대쪽으로는 공개된
`@github/copilot-sdk`를 구동합니다. 문서화되지 않은 Copilot 엔드포인트는 호출하지
않습니다. 비공식 통합입니다.

이 문서는 유지보수자용 참고 문서입니다. 요청이 흐르는 방식, 브리지가 노출하고
저장하는 것, 오류와 로그의 모양, 테스트 방법을 다룹니다. 설치와 실행은
[README](../README_KO.md), LiteLLM은 [LiteLLM 가이드](LITELLM_KO.md), 기능별 동작
여부는 [호환성](COMPATIBILITY_KO.md#기능별-확인)을 보세요.

## 시스템 구성

```text
Direct 경로                               LiteLLM 경로
Claude Code                               Claude Code
  -> 루프백 브리지 (src/server.mjs)         -> LiteLLM /v1/messages
  -> @github/copilot-sdk, mode "empty"      -> 같은 루프백 브리지
  -> GitHub Copilot 모델                    -> @github/copilot-sdk
                                            -> GitHub Copilot 모델
```

`claude`와 `claude-ghcp`는 Direct 경로를 씁니다. 요청은 `copilot login` 계정과 그
조직의 모델 정책 아래에서 실행됩니다.

`claude-litellm`은 LiteLLM 경로를 씁니다. LiteLLM은 자체 `github_copilot/` 공급자가
아니라 `anthropic/*` 공급자로 브리지에 연결합니다. 달라지는 점은
[Direct 경로와 다른 점](LITELLM_KO.md#direct-경로와-다른-점)에 있습니다.

### 엔드포인트

| 메서드와 경로 | 토큰 | 하는 일 |
|---|---|---|
| `POST /v1/messages` | 필요 | 턴 하나를 실행합니다. JSON을 반환하고, `stream`이 `true`이면 SSE를 반환합니다. |
| `POST /v1/messages/count_tokens` | 필요 | 추정값 `ceil(JSON 길이 / 4)`(최소 1)를 `x-ghcp-token-count-method: estimated` 헤더와 함께 반환합니다. Copilot에는 전달하지 않습니다. |
| `GET /v1/models` | 필요 | Claude Code용 탐색 목록입니다. 주요 모델 가운데 Claude Code가 아직 모르는 모델, 곧 GPT-6 모델 세 개를 반환합니다. |
| `GET /v1/models?all=true` | 필요 | 계정의 Copilot 카탈로그에 있는 모든 모델을 반환합니다. 런처는 이것으로 모델을 쓸 수 있는지 확인합니다. |
| `GET /health` | 필요 없음 | `ok`, `instanceId`, `preferredModel`, `modelCount`, `capabilities`를 반환합니다. |
| `HEAD /api/hello` | 필요 없음 | 빈 본문으로 200을 반환합니다. |
| 그 밖의 메서드와 경로 | 필요 | 404 `not_found_error`를 반환합니다. 토큰이 없으면 그보다 먼저 401을 반환합니다. |

## 통합 근거와 경계

Claude Code는 게이트웨이를 거쳐 다른 백엔드에 연결합니다. `ANTHROPIC_BASE_URL`로
Anthropic Messages API 요청을 보내는 방식입니다. Copilot SDK에는 이런 HTTP API가
없고, Copilot 런타임과 JSON-RPC로 통신합니다. 브리지는 이 둘을 잇는 어댑터입니다.

| 구간 | 누가 무엇을 맡는가 |
|---|---|
| Claude Code | 터미널 UI, 대화와 대화 기록, 권한, 훅, 플러그인, 스킬, MCP 서버, 모든 도구 실행 |
| Claude Code → 브리지 | 브리지는 `/v1/messages`, SSE, 토큰 계산, 모델 탐색 가운데 Claude Code가 쓰는 부분을 구현합니다. |
| 브리지 → Copilot | 브리지는 SDK 세션과 그 스트리밍 이벤트, 대기 중인 외부 도구 RPC를 다룹니다. |
| 도구 | 브리지는 Claude Code의 도구를 선언만 해서 Copilot에 등록합니다. 모델이 도구를 호출하면 브리지가 그 호출을 Claude Code에 돌려주고, 실행은 Claude Code가 합니다. |

Anthropic은 게이트웨이를 거쳐 Claude가 아닌 모델로 요청을 보내는 구성을 지원하지
않습니다. Copilot SDK는 Claude Code 통합을 제공하지 않습니다. 지원 경계와 고정한 SDK
버전은 [README](../README_KO.md#지원하지-않는-것)에 있습니다.

SDK 1.0.14는 Copilot 런타임 1.0.85를 플랫폼별 패키지(`@github/copilot-sdk-*`)에
담아 제공합니다. `COPILOT_CLI_PATH`로 다른 런타임을 지정하지 않으면 `CopilotClient`는
이 런타임을 씁니다. 따라서 전역으로 설치한 Copilot CLI가 브리지 요청을 처리하는
버전이라고 단정할 수 없습니다.

## 요청 흐름

1. Claude Code가 시스템 프롬프트, 대화, 도구 스키마와 `x-claude-code-session-id`,
   `x-claude-code-agent-id` 헤더를 담아 `POST /v1/messages`를 보냅니다.
2. 서버가 토큰을 확인하고([보안 경계](#보안-경계)) 본문을 검사합니다. 실패하면
   401이나 400을 반환합니다.
3. 요청 정책이 SDK가 적용할 수 없는 샘플링 제어 값과, 받지만 무시하는 필드를
   로그에 남깁니다(`bridge.degraded_controls`). `tool_choice`는 도구를 빼거나
   지시문을 덧붙여 흉내 냅니다. 규칙은
   [적용하지 않는 요청 값](COMPATIBILITY_KO.md#적용하지-않는-요청-값)에 있습니다.
4. 모델 ID를 Copilot 카탈로그에서 찾고([모델 탐색과 컨텍스트](#모델-탐색과-컨텍스트)),
   이어서 effort 수준을 정합니다([Reasoning effort](#reasoning-effort)).
5. 세션 관리자가 하나뿐인 `CopilotClient`에서 SDK 세션을 재사용하거나, 재개하거나,
   새로 만듭니다([세션 분리](#세션-분리)). 이 클라이언트는 `"empty"` 모드로
   실행합니다. 모든 세션은 Claude Code의 시스템 프롬프트를 `systemMessage`(모드
   `replace`)로 받습니다. 선언된 도구는 각각 핸들러 없는 선언(`defer: "never"`)으로
   등록하고, `availableTools`는 그 도구들의 `custom:<name>`으로 제한합니다. SDK 도구
   검색과 무한 세션은 끄고, 정해진 `reasoningEffort`를 넘기며, 런타임 MCP 서버는
   `disabledMcpServers`에 넣습니다.
6. 브리지가 턴을 보냅니다. 모델이 도구를 호출하면 Anthropic `tool_use` 블록으로
   Claude Code에 돌려줍니다.
7. Claude Code가 도구를 실행하고 다음 요청에 `tool_result`를 담아 보냅니다.
   브리지는 `handlePendingToolCall`로 이 결과를 기다리던 SDK 턴에 넘깁니다.
8. 턴이 끝나면 브리지는 SDK가 보고한 사용량과 함께 Anthropic Messages 응답을
   반환하고 `bridge.turn_completed`를 남깁니다. 중지 사유는 턴이 도구를 호출했으면
   `tool_use`, 콘텐츠 필터가 걸렸으면 `refusal`, 길이 제한으로 끝났으면
   `max_tokens`, 중지 시퀀스로 끝났으면 `stop_sequence`, 나머지는 `end_turn`입니다.

스트리밍 세부 사항:

- 텍스트는 도착하는 대로 스트리밍합니다. 도구 호출은 턴 끝에 각각 완성된
  `tool_use` 블록 하나로 씁니다.
- 한 번에 콘텐츠 블록을 하나만 열어 두므로, 각 `content_block_stop`이 다음
  `content_block_start`보다 먼저 나옵니다.
- SSE 응답은 첫 루트 메시지, 추론, 도구 호출 증분이 오면 시작합니다. 빈 증분도
  마찬가지입니다. 그 전에 실패하면 해당 HTTP 상태의 일반 JSON 오류를 반환합니다.
  그 뒤에 실패하면 `event: error` 프레임으로 보냅니다. 추론 텍스트는 보내지
  않습니다.
- 스트림이 열려 있는 동안 15초마다 `: ping` 주석을 보냅니다.
- Claude Code가 도구 결과 옆에 함께 보내는 사용자 텍스트(스킬 알림, TUI에서
  대기열에 넣은 메시지)는 마지막 도구 결과에 덧붙입니다. 그래서 모델은 같은
  턴에서 이 텍스트를 읽습니다.

## 보안 경계

브리지는 한 사람이 한 컴퓨터에서 쓰도록 만들었습니다. 브리지가 지키는 경계와
보관하는 데이터는 다음과 같습니다.

- **네트워크.** 브리지는 `HOST`(기본값 `127.0.0.1`)에서 연결을 받습니다.
  `ALLOW_NON_LOOPBACK=1`이 아니면 `127.0.0.1`, `::1`, `localhost`가 아닌 호스트에서는
  시작을 거부합니다. `claude-ghcp`가 시작하는 브리지는 print 모드든
  `bridge-daemon.mjs ensure`를 거치든 모두 `HOST=127.0.0.1`을 받습니다. TLS는
  없습니다.
- **토큰.** `GET /health`와 `HEAD /api/hello`를 뺀 모든 경로는 `BRIDGE_API_KEY`를
  요구합니다. 토큰은 `Authorization: Bearer`나 `x-api-key`로 보냅니다. 브리지는
  SHA-256 다이제스트를 `timingSafeEqual`로 비교하고, 요청마다 두 헤더를 모두
  확인합니다. 그래서 응답 시간으로는 추측한 값이 어디서 틀렸는지도, 어느 헤더에
  키가 있었는지도 알 수 없습니다. 이 확인은 라우팅보다 먼저 하므로, 토큰 없이
  알 수 없는 경로를 요청해도 401을 받습니다. `BRIDGE_API_KEY`가 없으면
  `BRIDGE_ALLOW_UNAUTHENTICATED=1`이 아닌 한 브리지는 시작하지 않습니다.
  `claude-ghcp`와 `bridge-daemon.mjs ensure`는 브리지마다 24바이트 난수 토큰을
  만듭니다.
- **인증 없는 경로.** 어느 로컬 프로세스든 `GET /health`를 호출해 브리지의
  `instanceId`, 기본 모델, 모델 수, 기능 목록을 읽을 수 있습니다.
- **모델에 전달되는 것.** Claude Code의 시스템 프롬프트가 Copilot 자체 시스템
  프롬프트를 대신합니다. 세션은 Claude Code가 선언한 도구(`custom:<name>`)만
  노출하므로 런타임의 기본 제공 도구는 쓸 수 없습니다. 런타임 자체 MCP 서버는 꺼
  둡니다([Copilot 런타임 MCP 서버](#copilot-런타임-mcp-서버)). 브리지는 도구를 직접
  실행하지 않습니다. Copilot이 등록하지 않은 도구 호출과 선언되지 않은 이름의 도구
  호출은 버리고 `bridge.unregistered_tool_call`로 남깁니다.
- **자격 증명.** 브리지는 `COPILOT_HOME`에 있는 Copilot CLI 로그인을 씁니다. Copilot
  런타임은 브리지의 환경을 물려받으므로, 그 환경에 설정된 `GH_TOKEN`이나
  `GITHUB_TOKEN`도 런타임에 전달됩니다. 브리지는 Anthropic 자격 증명을 읽거나
  복사하지 않으며, 실행 설정은 `ANTHROPIC_API_KEY`를 비웁니다.
- **로그.** 진단 로그에는 요청 본문, 프롬프트, 도구 인수, 도구 결과, 자격 증명이
  들어가지 않습니다. [로그](#로그)를 참고하세요.
- **Copilot으로 보내는 데이터.** Claude Code가 요청에 넣는 모든 것, 곧 시스템
  프롬프트, 대화, 소스 코드, 도구 결과, 첨부 파일이 GitHub Copilot 서비스로
  갑니다. 이 데이터는 로그인한 계정의 플랜, 조직 정책, GitHub 데이터 약관에 따라
  처리됩니다. 쓰기 전에 콘텐츠 제외와 보존 설정을 검토하세요. 모델을 쓰면 GitHub
  Copilot AI Credits가 소모됩니다.
- **공유 호스트용이 아닙니다.** 브리지에는 사용자별 인증과 권한 부여가 없고, 모든
  호출자가 Copilot 로그인 하나와 `COPILOT_HOME` 하나를 함께 씁니다. 네트워크에
  노출하거나 브리지 하나를 여러 사람이 나눠 쓰지 마세요. 원격이나 공유 배포에는
  TLS, 사용자 인증, 권한 부여, 그리고 테넌트마다 분리된 Copilot 계정과 세션
  저장소가 필요합니다.

### 브리지가 남기는 파일

데몬 디렉터리는 `GHCP_DAEMON_DIR`입니다. 설정하지 않으면 macOS에서는
`~/Library/Caches/claude-code-ghcp-sdk`, 그 밖의 시스템에서는
`${XDG_CACHE_HOME:-~/.cache}/claude-code-ghcp-sdk`입니다. 이 디렉터리와 하위
디렉터리의 권한은 `0700`입니다.

| 파일 | 내용 | 권한 | 지우는 시점 |
|---|---|---|---|
| `<데몬 디렉터리>/bridge.json` | 상주 브리지의 포트, 토큰, PID, `instanceId`, 시작 모델, 설정 지문 | `0600` | 브리지가 교체되거나 멈출 때 |
| `<데몬 디렉터리>/retired/<instanceId>.json` | 교체된 브리지의 같은 기록(토큰 포함) | `0600` | 그 교체된 브리지가 종료한 뒤 새 브리지를 시작하는 실행이 지웁니다. `claude-ghcp-stop`도 지웁니다. |
| `<데몬 디렉터리>/settings/<random>.json` | 실행 하나의 Claude Code 설정(브리지 토큰 포함) | `0600` | 런처가 끝나도 남습니다. 이후 실행마다 24시간이 지난 파일을 지웁니다. 실행이 기존 브리지를 교체하지 않고 멈추면 디렉터리 전체를 지웁니다. `claude-ghcp-stop`도 전체를 지웁니다. |
| `<데몬 디렉터리>/leases/<instanceId>.<random>.pid` | 런처 셸의 PID | `0600` | 런처가 끝날 때 지웁니다. 새 브리지를 시작하는 실행은 PID가 죽은 파일을 지웁니다. `claude-ghcp-stop`은 모두 지웁니다. |
| `<데몬 디렉터리>/bridge.log` | 상주 브리지의 출력과 진단 로그 | `0600` | `claude-ghcp-stop`이 지웁니다. |
| `$TMPDIR/claude-ghcp.XXXXXX/` | print 모드 실행의 설정 파일(`0600`)과 브리지 로그 | 디렉터리 `0700` | 그 런처가 끝날 때 |
| `$TMPDIR/claude-litellm.XXXXXX/settings.json` | `claude-litellm` 설정(LiteLLM 키 포함) | `0600` | 그 런처가 끝날 때 |
| `COPILOT_HOME`(기본값 `~/.copilot`) | Copilot CLI 로그인과 모든 브리지 세션의 SDK 세션 기록. 이 기록에는 브리지가 보낸 대화, 곧 프롬프트, 파일 내용, 도구 결과가 들어 있습니다. | Copilot 런타임이 정합니다 | 남습니다. 브리지가 폐기하는 세션만 지웁니다([세션 분리](#세션-분리)). |

## 세션 분리

**요청 묶음.** 요청은 `x-claude-code-session-id`와 `x-claude-code-agent-id` 헤더가
가리키는 묶음에 속합니다. 에이전트 ID가 없으면 루트 에이전트로 봅니다. 세션 ID가
없는 요청은 브리지 프로세스가 살아 있는 동안 익명 묶음 하나를 함께 씁니다. 한
묶음의 요청은 순서대로 하나씩 실행합니다. 대기 중인 요청을 취소해도 다음 요청이
이미 실행 중인 턴을 앞지르지 않습니다.

**상태.** 브리지는 묶음 안에서 캐시한 SDK 세션을 정해진 모델, 도구 스키마, 시스템
프롬프트로 구분합니다. 이 문서에서는 이 캐시한 세션을 상태라고 부릅니다. 이 셋
가운데 하나라도 바꾼 요청은 기존 상태 옆에 새 상태를 받습니다(`bridge.state_split`).

**재사용.** 브리지는 들어온 대화가 가지고 있는 대화를 이어 갈 때만 상태를
재사용합니다. 기록이 더 이상 맞지 않거나(예: Claude Code가 되감거나 압축한 뒤), 같은
묶음의 다른 상태가 그사이 대화를 더 진행했다면, 브리지는 상태를 폐기하고
(`bridge.history_reconciled`) 새 세션을 시작합니다. 비교할 때 `cache_control` 표시와
인라인 `system` 항목은 무시합니다. 사용자 정의 에이전트 정의나 출력 스타일 같은
인라인 시스템 텍스트는 SDK 시스템 메시지에 합치며, 알아볼 수 있는 요청별 토큰
예산 메모는 뺍니다. 실제 사용자·어시스턴트 내용, 도구 입력, 시스템 지시가 바뀌면
다른 기록으로 봅니다.

**재개와 재전송.** SDK 세션 ID는 브리지 프로세스가 시작할 때 고른 난수, 상태 키,
세대 번호로 만듭니다. 한 브리지 프로세스 안에서는 캐시에서 내보낸 상태를 그 SDK
세션에서 재개할 수 있습니다. 프로세스가 다시 시작하면 ID가 달라지므로 이전
공급자 상태는 재사용하지 않습니다. 대신 새 세션에 이전 대화를 텍스트로 넣어
줍니다. 최대 `MAX_REPLAY_BYTES`까지 넣고 최신 메시지를 남깁니다. 이를 콜드
재전송이라고 합니다. 콜드 재전송은 tool-use ID, 도구 결과의 오류 표시,
`tool_reference` 이름을 유지합니다.

**내보내기와 폐기.** 일반적인 내보내기(아래 `MAX_STATES`, `STATE_IDLE_TTL_MS`
한도)는 SDK 세션을 디스크에 남겨 두므로 같은 프로세스 안에서 재개할 수 있습니다.
상태를 폐기하면 그 SDK 세션을 `COPILOT_HOME`에서 지웁니다. 브리지는 기록이
바뀌었을 때와 컨텍스트 한도에 닿았을 때 상태를 폐기합니다. effort 변경이
실패하거나 Copilot이 5초 안에 확인하지 않은 중단 때문에 상태가 무효가 되었을 때도
폐기합니다.

**도구 넘겨주기.** Claude Code `toolCallId`와 SDK의 대기 중인 요청을 잇는 대응표는
브리지 메모리에 있습니다. 턴이 끝날 때 브리지는 Copilot이 각 도구 호출을 등록할
때까지 기다린 뒤 그 호출을 반환합니다.

**한도.** 다음 변수가 세션과 턴을 제한합니다. 기본값은
[`.env.example`](../.env.example)에 있고, 모두 상주 브리지의
[설정 지문](#상주-브리지와-교체)에 들어갑니다.

| 변수 | 제한하는 것 | 한도에 닿으면 |
|---|---|---|
| `MAX_STATES` | 캐시한 상태 수 | 가장 오래 쓰지 않은 유휴 상태부터 내보냅니다. |
| `STATE_IDLE_TTL_MS` | 진행 중인 턴도 대기 중인 도구 호출도 없는 상태의 유휴 시간 | 다음 요청이 시작될 때 그 상태를 내보냅니다. |
| `MAX_REPLAY_BYTES` | 새 세션에 다시 넣는 기록의 크기 | 오래된 메시지를 버리고 `bridge.history_replay_truncated`를 남깁니다. |
| `MAX_TOOL_RESULTS` | 요청 하나에 든 도구 결과 수 | 요청이 500으로 실패합니다. |
| `PENDING_TOOL_WAIT_MS` | Copilot이 도구 호출을 등록하기를 기다리는 시간 | 그 호출을 턴에서 뺍니다(`bridge.unregistered_tool_call`). |
| `SESSION_OPERATION_TIMEOUT_MS` | SDK `session.create`, `session.resume`, `session.set_model` 호출 하나하나 | 요청이 500으로 실패합니다(`bridge.session_operation_failed`). 늦게 온 응답은 버립니다(`bridge.session_creation_abandoned`). |
| `TURN_IDLE_TIMEOUT_MS` | 턴에서 진행이 없는 시간. 루트 턴 시작, 메시지와 턴 종료 이벤트, 비어 있지 않은 텍스트·추론·도구 입력 증분을 진행으로 칩니다. 빈 증분과 서브에이전트 이벤트는 진행으로 치지 않습니다. | 턴을 중단하고 500으로 실패합니다(`bridge.turn_timeout`, 사유 `timeout`). |
| `TURN_MAX_DURATION_MS` | 턴 하나의 전체 길이. 계속 스트리밍하는 턴에도 적용합니다. | 위와 같고, 사유는 `duration_limit`입니다. |
| `CLEANUP_TIMEOUT_MS` | 정리 단계에서 시도하는 중단, 연결 해제, 삭제 하나하나 | 정리를 계속 진행합니다. |

런타임이 업스트림 실패를 재시도하려고 기다리는 동안 턴이 시간 초과되면 500이 아니라
429나 529로 실패합니다. [업스트림 오류](#업스트림-오류)를 참고하세요. 호출자의
취소와 종료도 세션 작업과 턴을 끝냅니다.

## Copilot 런타임 MCP 서버

Copilot 런타임은 `"empty"` 모드에서도 SDK 세션마다 사용자의 Copilot CLI 설정을
불러옵니다. 사용자 `mcp-config.json`, 작업 공간 파일, 설치한 Copilot 플러그인,
기본 제공 `github-mcp-server`가 여기에 해당합니다. 세션은 `custom:*` 도구만
노출하므로 이 서버들은 모델에 닿지 못합니다. 그래도 런타임은 세션마다 이 서버들을
시작하고, 세션이 닫힐 때에야 멈춥니다. 그래서 브리지가 이 서버들을 꺼 둡니다.

- 시작할 때 브리지는 자기 작업 디렉터리로 `mcp.discover`를 호출해 등록된 서버
  이름을 알아냅니다. 상주 브리지의 작업 디렉터리는 데몬 디렉터리입니다. 플러그인
  서버의 이름은 실행 파일이 아니라 설정 키입니다(예: azmcp는 `azure`).
- 탐색 결과에 나오지 않는 `github-mcp-server`를 더하고, 이 목록을 세션을 만들거나
  재개할 때마다 `disabledMcpServers`로 넘깁니다. 빈 `mcpServers` 맵은 탐색된 서버를
  대신하지 못하므로 쓰지 않습니다.
- 끈 서버 수를 `bridge.mcp_servers_disabled`로 남깁니다. 탐색이 실패하거나 10초를
  넘기면 `bridge.mcp_discovery_failed`를 남기고 기본 제공 서버만 끕니다. SDK에
  `mcp.discover`가 없으면 아무것도 남기지 않고 기본 제공 서버만 끕니다.
- Copilot 설정은 바꾸지 않습니다. 브리지가 실행 중일 때 추가한 서버는 다음 브리지가
  시작할 때 반영됩니다.

Claude Code의 MCP 서버는 별개입니다. Claude Code가 직접 시작하고, 브리지는 그 도구를
다른 선언된 도구와 똑같이 전달합니다. 런타임 서버를 끈 효과는
[검증 이력](VERIFICATION_HISTORY_KO.md)에 기록되어 있습니다.

## 모델 탐색과 컨텍스트

`/model`의 모델 6개와 각 모델의 컨텍스트 창, effort 수준은
[모델](../README_KO.md#모델)에 있습니다. 이 절은 브리지가 그 동작을 어떻게 만드는지
설명합니다.

### 모델 ID와 `/model` 목록

브리지는 `github-copilot/claude-` 접두어와 `[1m]` 또는 `[Nk]` 접미어를 떼어 냅니다.
그런 다음 Opus, Sonnet, Haiku의 Claude Code ID `claude-<family>-X-Y`를 Copilot ID
`claude-<family>-X.Y`로 바꿉니다. 그래서 `claude-opus-5-5`는 `claude-opus-5.5`가
되고, `claude-sonnet-5`는 그대로이며, GPT-6 목록 ID
`github-copilot/claude-gpt-6-sol[1m]`은 `gpt-6-sol`이 됩니다. Copilot ID를 그대로
보내도 됩니다. 별칭 `opus`, `sonnet`, `haiku`는 계정이 쓸 수 있는 그 계열의 첫
모델로 정해집니다. `opus`는 Opus 5.5, Opus 5, 그리고 4.8부터 4.5까지 차례로
시도하고, `sonnet`은 Sonnet 5, 4.6, 4.5를 차례로 시도합니다. 모델이 비어 있거나
`default`이면 브리지의 시작 모델(`GHCP_MODEL`)을 씁니다. 계정이 쓸 수 없는 모델은
400으로 실패합니다.

주요 모델 6개는 `src/model-map.mjs`의 `PRIMARY_MODELS`이고, 검증 카탈로그도 이
목록을 씁니다. Direct 실행 설정은 이 모델들을 순서대로 `modelPicker` 옵션에 넣고
`replaceBuiltInOptions: true`를 설정합니다. Claude Code는 여기에 늘 자체 `Default`
행을 더합니다. `opus`, `sonnet`, `haiku` 계열 설정은 목록 행과 같은 ID
(`claude-opus-5-5[1m]`, `claude-sonnet-5[1m]`, `claude-haiku-4-5`)를 쓰므로, 계열
모델로 실행하면 해당 행과 일치합니다. Claude Code는 목록에 있는 행을 브리지에 묻지
않고 받아들이고, 목록 밖의 ID에는 토큰 하나짜리 확인 요청을 보냅니다.
`GET /v1/models`는 주요 모델 가운데 Claude Code가 아직 모르는 모델, 곧 GPT-6 모델
세 개만 반환합니다. 카탈로그 창이 1,000,000 토큰 이상인 모델에는 `[1m]`을 붙입니다.
`?all=true`와 `ghcp-models`는 카탈로그 전체를 보여 줍니다.

### 컨텍스트 창

Claude Code는 모델 ID로 컨텍스트 창 크기를 정하고, 게이트웨이 뒤에서는 접미어 없는
Claude ID에 200K를 줍니다. 그래서 런처는 브리지가 창이 1M 이상이라고 아는 모든
모델에 `[1m]`을 붙입니다. Opus 5.5, Sonnet 5, GPT-6 모델 세 개가 여기에 해당합니다.
명시적으로 고른 경우에는 GPT-5.6 Sol, Terra, Luna와 Claude Opus 5, 4.8, 4.7도
해당합니다. Haiku 4.5에는 이 표시를 붙이지 않으므로 Claude Code 자체의 200K 창을
유지합니다. 실행 설정은 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`를 비우므로 창은 고른 모델을
따릅니다. 1M 행에서 Haiku로 돌아가면 200K로 돌아옵니다. Claude Code의 자동 압축과
사용자가 정한 더 작은 창은 그대로 적용됩니다.

Copilot 런타임에는 세션마다 별도의 입력 한도가 있고, 이 한도는 컨텍스트 등급에
따라 다릅니다. 브리지는 위 목록에 있으면서 카탈로그 항목이 1,000,000 토큰 이상의
창을 보고하는 모델에만 `contextTier: "long_context"`를 요청합니다. 이 모델들에는
세션을 만들 때, 재개할 때, effort를 바꿀 때 카탈로그의 컨텍스트, 프롬프트, 출력
한도도 넘깁니다. 나머지 모델은 모두 기본 등급을 씁니다.

`bridge.context_budget`은 런타임이 적용하는 한도를 남깁니다. 커밋 `bed30ce`에서
기록된 한도는 다음과 같습니다.

| 모델 | SDK 등급 | 런타임 입력 한도 | Claude Code 자동 압축보다 먼저 닿는가 |
|---|---|---|---|
| GPT-6 Astra | 긴 컨텍스트 | 1,050,000 | 아니요 |
| Claude Sonnet 5 | 긴 컨텍스트 | 936,000 | 예 |
| Claude Opus 5.5 | 긴 컨텍스트 | 872,000 | 예 |
| GPT-6 Sol | 긴 컨텍스트 | 872,000 | 예 |
| GPT-6 Luna | 긴 컨텍스트 | 872,000 | 예 |
| Claude Haiku 4.5 | 기본 | 136,000 | 예 |

Claude Code는 1M 창에서 약 967K, Haiku의 200K 창에서 약 167K에 이르면 자동 압축합니다.
따라서 Astra를 뺀 모든 모델은 런타임 한도에 먼저 닿고, 아래의 초과 처리에
의존합니다. 이 한도는 Copilot 카탈로그와 런타임에서 오므로 브리지를 바꾸지 않아도
달라질 수 있습니다.

### 컨텍스트 초과

브리지가 무한 세션을 꺼도 런타임은 세션 기록을 압축하거나 잘라 낼 수 있습니다.
브리지는 모르는 사이에 줄어든 기록으로 계속 응답하지 않습니다.

- 요청과 요청 사이에 줄었다면, 다음 요청이 상태를 폐기하고 아무것도 출력하기 전에
  400 `invalid_request_error`로 실패합니다. 메시지는
  `prompt is too long: GitHub Copilot would reduce conversation history at N input tokens. Compact the conversation before retrying.`
  입니다. 이 문구를 받으면 Claude Code가 대화를 압축하고 다시 시도합니다.
- 턴 도중에 줄었다면 브리지가 턴을 중단하고(`bridge.turn_aborted`, 사유
  `context_limit`) 같은 오류를 반환합니다. 아직 아무것도 스트리밍하지 않았으면
  HTTP 400으로, 이미 스트리밍했으면 `event: error` 프레임으로 보냅니다.
- 둘 중 어느 경우였는지는 `bridge.context_limit`이 기록합니다.

`errorType`이 `context_limit`인 `session.error`는 다른 경우입니다. 이 오류는 500
`api_error`가 됩니다. [업스트림 오류](#업스트림-오류)를 참고하세요.

### 사용량 집계

Copilot은 캐시된 토큰을 포함해 입력 토큰을 보고하고, Anthropic은 세 가지 수를
따로 보고합니다. 브리지는 캐시되지 않은 입력을
`max(0, inputTokens - cacheReadTokens - cacheWriteTokens)`로 반환하고, Copilot의 캐시
수를 `cache_read_input_tokens`와 `cache_creation_input_tokens`로 넘깁니다. 그래서
캐시된 230K 토큰 요청이 약 460K로 보이지 않습니다. 명시적인 0은 0으로 둡니다.
사용량이 아예 없을 때만 추정값으로 채웁니다. SDK 사용량 이벤트 가운데 하나라도
카운터가 빠져 있으면 그 합계는 0이 아니라 알 수 없음으로 남깁니다. 이 처리는 숫자만
바로잡습니다. `cache_control` 표시는 효과가 없습니다.
[구조적 한계](COMPATIBILITY_KO.md#구조적-한계)를 참고하세요.

## Reasoning effort

`/effort`와 `--effort`는 `output_config.effort`로 브리지에 도착합니다. 값
`ultracode`는 `xhigh`가 됩니다. 브리지는 이어서 그 수준을 모델의 카탈로그 항목과
대조합니다.

- effort를 지원하지 않는 모델에는 effort를 보내지 않습니다. 값은 버립니다.
- 모델이 나열한 수준은 그대로 넘깁니다. 나열하지 않은 수준은 그보다 낮은 수준
  가운데 가장 높은 것으로 바꾸고, 더 낮은 수준이 없으면 나열된 가장 낮은 수준으로
  바꿉니다.
- `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` 중 어느 것도 아닌 값은,
  모델이 수준을 나열하는 경우 400으로 실패합니다. effort를 지원하지만 수준을
  나열하지 않는 모델에는 값을 그대로 넘깁니다.

세션은 정해진 `reasoningEffort`로 만들고 재개합니다. Claude Code 세션 안에서 effort가
바뀌면(기본값으로 되돌리는 경우 포함) 브리지는 `session.setModel()`을 호출합니다.
그러면 다음 턴부터 새 값을 쓰고 대화는 그대로 유지됩니다. 워크플로 조정과 도구
실행은 계속 Claude Code가 맡습니다.

## 실행 설정

런처는 명령줄 `--settings` 파일로만 Claude Code에 설정을 넘기며, Claude Code 자체의
우선순위는 그대로 적용됩니다.
[사용자 설정은 건드리지 않습니다](../README_KO.md#사용자-설정은-건드리지-않습니다)를
참고하세요. 이 파일에는 다음 키가 들어갑니다.

| 키 | Direct (`claude-ghcp`) | LiteLLM (`claude-litellm`) |
|---|---|---|
| `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` | 브리지 URL과 토큰 | `LITELLM_BASE_URL`과 `LITELLM_API_KEY` |
| `ANTHROPIC_MODEL` | 실행 모델. 해당하면 `[1m]`을 붙입니다 | `LITELLM_MODEL` |
| `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`과 `_NAME`, `_DESCRIPTION` | `claude-opus-5-5[1m]`, `claude-sonnet-5[1m]`, `claude-haiku-4-5` | `LITELLM_{OPUS,SONNET,HAIKU}_MODEL`, 기본값 `LITELLM_MODEL` |
| `ANTHROPIC_SMALL_FAST_MODEL` | haiku 계열 모델 | haiku 계열 모델 |
| `ANTHROPIC_CUSTOM_MODEL_OPTION`과 `_NAME`, `_DESCRIPTION` | 실행 모델. 계열 모델이면 비웁니다 | 같은 규칙 |
| `CLAUDE_CODE_SUBAGENT_MODEL` | 실행 모델. 계열 모델이면 비웁니다 | 같은 규칙 |
| `CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP` | `1` | `1` |
| `ANTHROPIC_API_KEY`, `CLAUDE_CODE_USE_{AWS,BEDROCK,FOUNDRY,MANTLE,VERTEX}`, `ANTHROPIC_DEFAULT_MODEL`, `ANTHROPIC_DEFAULT_FABLE_MODEL`과 `_NAME`, `_DESCRIPTION` | 비움 | 비움 |
| `ENABLE_TOOL_SEARCH` | 비움. `GHCP_NATIVE_TOOL_SEARCH=1`이면 `true` | 비움 |
| `modelPicker` | 주요 모델 6개 행. 기본 제공 행을 대신합니다 | 설정하지 않음 |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | `1` | 설정하지 않음 |
| `CLAUDE_CODE_ATTRIBUTION_HEADER` | `0` | 설정하지 않음 |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | 비움 | 설정하지 않음 |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | 설정하지 않음 | `1` |

- 계열 모델은 세 `ANTHROPIC_DEFAULT_*_MODEL` 값 가운데 하나입니다. LiteLLM 계열
  별칭의 기본값은 `LITELLM_MODEL`입니다. 그래서 기본 설정에서는 LiteLLM 실행 모델이
  계열 모델이 되고, `ANTHROPIC_CUSTOM_MODEL_OPTION`과 `CLAUDE_CODE_SUBAGENT_MODEL`
  두 행이 모두 비워집니다.
- `CLAUDE_CODE_SUBAGENT_MODEL`은 모델을 지정하지 않은 서브에이전트가 실행 모델을
  쓰게 합니다. 비워 둔 값도 셸에 있는 값이 들어오지 못하게 막습니다.
- `CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP=1`이 없으면 Claude Code는 주 모델 이름이
  haiku, sonnet, opus가 아닐 때마다 Explore 서브에이전트를 `opus` 별칭으로
  제한합니다. 이 때문에 GPT 세션의 Explore 작업이 Opus로 갔습니다.
- 비워 둔 공급자 선택 변수와 물려받은 모델 옵션은, 셸이나 사용자 설정의 값이
  요청을 게이트웨이가 아닌 곳으로 보내지 못하게 합니다.
- `ENABLE_TOOL_SEARCH`가 비어 있으면 Claude Code 자체 도구 검색과 `tool_reference`가
  꺼지고, 모델은 선언된 도구 전체를 받습니다. Direct 실행마다 읽는
  `GHCP_NATIVE_TOOL_SEARCH=1`은 Claude Code의 도구 검색을 켭니다. SDK 자체 도구
  검색은 늘 꺼 둡니다. 선언만 한 도구가 SDK 도구 검색 아래에서 멈출 수 있기
  때문입니다.

## 상주 브리지와 교체

print 모드는 난수 토큰을 쓰는 전용 브리지를 시작하고, 끝날 때 그 브리지를
멈춥니다. 나머지 모든 실행은 `src/bridge-daemon.mjs ensure`가 시작하는 상주 브리지
하나를 함께 씁니다. 어느 실행이 어느 브리지를 쓰는지, 브리지를 확인하고 멈추는
방법은 [백그라운드 브리지](../README_KO.md#백그라운드-브리지)에 있습니다. 상주
브리지가 필요한 이유는 `/background`가 대화형 세션을 Claude Code 자체 데몬에 넘기기
때문입니다. 그 작업은 런처가 끝난 뒤에도 브리지를 계속 호출하고, Claude Code는
`--settings` 파일로 그 작업을 다시 띄웁니다.

**설정 지문.** 레지스트리 `bridge.json`은 브리지의 동작을 정하는 모든 것에 대한
SHA-256을 저장합니다. 이 값을 설정 지문이라고 합니다. 실행은 지문이 같고, PID가
살아 있고, `/health`가 등록된 `instanceId`를 보고할 때만 등록된 브리지를
재사용합니다. 지문에 들어가는 것은 다음과 같습니다.

- 이름이 `COPILOT_`나 `MAX_`로 시작하는 모든 환경 변수의 값, 그리고
  `CLEANUP_TIMEOUT_MS`, `PENDING_TOOL_WAIT_MS`, `SESSION_OPERATION_TIMEOUT_MS`,
  `STATE_IDLE_TTL_MS`, `TURN_IDLE_TIMEOUT_MS`, `TURN_MAX_DURATION_MS`,
  `RETIRED_IDLE_MS`, `LOG_LEVEL`, `GH_CONFIG_DIR`, `GH_TOKEN`, `GITHUB_TOKEN`,
  `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `HOME`의 값
- 체크아웃의 절대 경로, `package.json`, `package-lock.json`, 모든 `src/*.mjs` 파일의
  내용
- 요청한 포트(`GHCP_BRIDGE_PORT` 또는 `--bridge-port`)

이름은 대소문자를 구분하므로 소문자 `http_proxy`, `https_proxy`, `no_proxy`는
들어가지 않습니다. 빈 값으로 설정한 변수와 설정하지 않은 변수는 다르게 봅니다.
`MAX_THINKING_TOKENS`처럼 이 접두어를 가진 관련 없는 변수도 들어갑니다. 들어가지
않는 것은 모델, `GHCP_MODEL`, `GHCP_NATIVE_TOOL_SEARCH`, `GHCP_DAEMON_DIR`,
`BRIDGE_TEST_FAULTS`입니다. 재사용된 브리지는 모델을 쓸 수 있는지 확인한 뒤 어떤
실행 모델이든 처리합니다. 브리지는 자신을 시작한 실행의 환경 전체를 물려받으므로,
지문 밖의 변수는 그 실행의 값을 유지합니다.

**실행마다 하는 일.** 동시에 실행한 런처들은 `bridge.lock`으로 차례를 지킵니다. 새
브리지는 60초 안에 `/health`에 응답하고 `/v1/models?all=true`에 실행 모델을 보여야
합니다. 그러지 못하면 실행이 실패합니다. `ensure`는 레지스트리, `settings/` 아래의
새 설정 파일 경로, 점유 파일 경로 `leases/<instanceId>.<random>.pid`를 반환합니다.
설정 파일 경로를 할당할 때 24시간이 지난 설정 파일을 지웁니다. 점유 파일은 런처
셸의 PID를 담은 파일입니다. 런처가 이 파일을 쓰고, 끝날 때 지웁니다.

**교체.** 교체된 브리지는 새 브리지로 대체되었지만, 이미 자신을 쓰고 있는 세션을
계속 처리합니다. 지문이 다를 때 기존 브리지는 다음 조건을 모두 만족하면
교체됩니다. PID가 살아 있고, `/health`로 `instanceId`가 확인되고,
`capabilities.retirement`를 보고하고, 새 실행이 그 브리지의 포트를 고정하지 않았어야
합니다. 교체할 때는 기존 브리지의 기록을 `retired/`로 옮기고, 그 브리지에
`SIGUSR2`를 보내고, 새 브리지를 시작합니다. 교체된 브리지는 `bridge.retired`를
남기고, 30초마다 종료할 수 있는지 확인합니다. 처리 중인 요청이 없고,
`RETIRED_IDLE_MS` 동안 `/v1/messages`나 `count_tokens` 요청이 없었고, 자신을
가리키는 점유 파일 가운데 살아 있는 PID를 담은 것이 없으면 종료합니다
(`bridge.retired_exit`). 이 유휴 시간은 점유 파일이 없는 세션을 위한 것입니다.
런처가 이미 끝난 `/background` 작업이나 LiteLLM이 그런 예입니다.

**교체 대신 멈추는 경우.** 교체 조건 가운데 하나라도 맞지 않으면 `ensure`는 기존
브리지를 멈추고(`SIGTERM` 다음 `SIGKILL`) `settings/` 디렉터리 전체를 지웁니다.
등록된 브리지가 없는 경우, PID가 죽은 경우, `/health` 확인이 실패한 경우, 교체
기능이 없는 경우, 새 실행이 기존 브리지의 포트를 고정한 경우가 여기에 해당합니다.
아직 실행 중인 교체된 브리지의 세션이 필요로 하는 설정 파일도 함께 지워집니다.
포트를 고정한 실행은 그 포트를 쓰고 있는 교체된 브리지도 멈춥니다. 살아 있는 PID가
등록된 브리지인지 확인할 수 없으면 `ensure`는 실패하고 레지스트리를 그대로 둡니다.
고정 포트로 브리지에 연결하는 LiteLLM에서 생기는 결과는
[브리지가 교체될 때](LITELLM_KO.md#브리지가-교체될-때)에 있습니다.

**상태 확인과 중지.** `claude-ghcp-status`는 브리지가 시작할 때의 모델을 보여 주며
토큰은 출력하지 않습니다. `claude-ghcp-stop`은 현재 브리지와 교체된 브리지를 모두
멈추고, [보안 경계](#보안-경계)에 나온 파일을 지웁니다.

**작업 디렉터리.** 상주 브리지는 자신을 시작한 프로젝트가 아니라 데몬 디렉터리에서
실행됩니다. 그 프로젝트는 브리지가 실행되는 동안 지워질 수 있습니다. 또 프로젝트
디렉터리에서 실행하면 런타임 MCP 탐색이 다른 모든 프로젝트의 세션에 그 프로젝트의
작업 공간 설정을 읽어 들이게 됩니다.

## 로그

브리지는 내용이 담기지 않은 진단 로그를 씁니다. 한 줄에 JSON 객체 하나이며, 요청
본문, 프롬프트, 도구 인수, 도구 결과, 첨부 파일, 자격 증명은 들어가지 않습니다.
`bridge.started`, `bridge.retired`, `bridge.retired_exit`는 stdout으로, 나머지
이벤트는 모두 stderr로 가며, `LOG_LEVEL` 값과 관계없습니다. `LOG_LEVEL`은 Copilot
런타임 자체의 로그 수준만 정합니다. 두 스트림은 파일 하나로 모입니다. print
모드에서는 `$TMPDIR/claude-ghcp.XXXXXX/bridge.log`이고 런처가 끝날 때 지웁니다. 상주
브리지에서는 데몬 디렉터리의 `bridge.log`이고 `claude-ghcp-stop`이 지울 때까지
남습니다. 클라이언트 중단이 아닌 실패는 `[<requestId>] <ErrorName>: <message>`
형식의 일반 텍스트 줄도 씁니다. 이 메시지에는 모델이나 도구 이름, 업스트림 오류
텍스트가 들어갈 수 있습니다.

`npm test`가 이 이벤트와 필드 이름을 검사하므로 안정된 인터페이스로 다루세요.
`npm run verify`는 로그를 슬롯마다 디렉터리에 복사하지만 해석하지는 않습니다.

| 이벤트 | 기록 시점 | 필드 |
|---|---|---|
| `bridge.started` | 서버가 연결을 받기 시작할 때 | `address`, `preferredModel`, `models` |
| `bridge.request_failed` | `/v1/messages` 요청이 실패할 때. 401, 400 본문 오류, 499를 포함한 그 뒤의 모든 실패 | `requestId`, `status`, `errorType`, `retryAfterSeconds`, `streaming`(요청이 SSE를 원했는지), `headersSent`(응답이 이미 시작됐는지) |
| `bridge.turn_completed` | `/v1/messages` 응답을 보낸 뒤 | `requestId`, `responseId`, `requestedModel`, `model`, `servedModels`, `claudeAgent`(`root` 또는 `subagent`), `inputTokens`, `outputTokens`, `usageReported`, `stopReason`, `toolUses` |
| `bridge.degraded_controls` | 요청에 SDK가 적용할 수 없는 샘플링 제어 값이나, 받지만 무시하는 필드가 있을 때 | `controls`, `ignoredFields`(있을 때만), `semantics` |
| `bridge.mcp_servers_disabled` | 시작할 때 `mcp.discover`를 호출한 뒤 | `count`(`github-mcp-server` 포함) |
| `bridge.mcp_discovery_failed` | MCP 탐색이 실패하거나 10초를 넘겼을 때 | `error`, `message`(최대 200자) |
| `bridge.context_budget` | 세션이 새 런타임 입력 한도를 보고할 때 | `model`, `contextTier`, `tokenLimit`, `currentTokens` |
| `bridge.context_limit` | Copilot이 세션 기록을 줄였을 때 | `model`, `phase`(`between_requests` 또는 `active_turn`), `tokenLimit`. `active_turn`이면 턴 보고 필드가 더해집니다 |
| `bridge.history_reconciled` | 대화가 캐시한 상태를 더 이상 이어 가지 않거나 상태가 오래되었을 때 | `currentMessages`, `previousMessages`, `reason`(`history_diverged` 또는 `identity_stale`) |
| `bridge.state_split` | 같은 묶음에서 기존 상태 옆에 새 상태가 시작될 때 | `family`(해시), `changes`(`model`, `toolSignature`, `systemHash` 중 바뀐 것) |
| `bridge.history_replay_truncated` | 새 세션에 다시 넣는 기록이 `MAX_REPLAY_BYTES`를 넘었을 때 | `maxBytes`, `messages` |
| `bridge.session_operation_failed` | `session.create`, `session.resume`, `session.set_model`이 실패하거나 시간 초과됐을 때 | `operation`, `requestId`, `responseId`, `reason`(`aborted`, `timeout`, `error` 중 하나), `elapsedMs`, `timeoutMs` |
| `bridge.session_creation_abandoned` | 기다리기를 포기한 뒤에 생성이나 재개가 끝났을 때. 늦게 만들어진 세션은 지웁니다 | 없음 |
| `bridge.session_cleanup_failed` | 늦게 만들어진 그 세션을 지우지 못했을 때 | `operation` |
| `bridge.turn_timeout` | 유휴 제한(`reason` 값 `timeout`)이나 전체 상한(`reason` 값 `duration_limit`)에 걸렸을 때 | 턴 보고 필드, `reason` |
| `bridge.turn_aborted` | 클라이언트가 취소했거나(`reason` 값 `client_abort`) 컨텍스트 한도가 턴에 닿았을 때(`reason` 값 `context_limit`) | 턴 보고 필드, `reason` |
| `bridge.turn_abort_completed` | 위 두 이벤트 가운데 하나가 난 뒤 | 턴 보고 필드, `reason`, `acknowledged`, `abortElapsedMs` |
| `bridge.unregistered_tool_call` | Copilot이 등록하지 않았거나 선언되지 않은 이름의 도구 호출을 버렸을 때 | `tool`, `toolCallId` |
| `bridge.test_fault_injected` | `BRIDGE_TEST_FAULTS`가 주입할 오류 하나를 썼을 때(테스트 전용) | `requestId`, `kind`, `remaining` |
| `bridge.retired` | 브리지가 `SIGUSR2`를 받아 교체되었을 때 | `retired`, `inFlight`, `idleMs`, `leases` |
| `bridge.retired_exit` | 교체된 브리지가 종료할 때 | `retired`, `inFlight`, `idleMs`, `leases` |
| `bridge.diagnostic_error` | 턴 진단 로그를 쓰지 못했을 때. 요청 자체에는 영향이 없습니다 | `diagnosticEvent`, `requestId`, `responseId` |

턴 보고 필드는 `timestamp`, `requestId`, `responseId`, `state`(해시), `model`,
`elapsedMs`, `turnElapsedMs`, `idleMs`, `stage`(`send`, `tool_result`,
`tool_registration`, `trigger`, `model` 중 하나), `triggerFinished`, `turnStarted`,
`completionStarted`, `deferredCompletion`, `upstreamRetryStatus`, `messages`,
`toolRequests`, `usageEvents`, `pendingToolCalls`, `pendingRegistrations`,
`rpc`(전송과 도구 결과 각각의 시작·확인·실패 횟수), `eventCounts`,
`recentEvents`(최대 8개, 각각 유형·범위·경과 시간 포함)입니다.

`GET /health`는 SDK가 적용할 수 없는 샘플링 제어 값을
`capabilities.unsupportedNativeControls`로, 받지만 무시하는 필드를
`capabilities.ignoredRequestFields`로 보여 줍니다. 두 목록은
`src/request-policy.mjs`에서 오며,
[적용하지 않는 요청 값](COMPATIBILITY_KO.md#적용하지-않는-요청-값)에서 설명합니다.

## 업스트림 오류

모든 실패가 브리지에서 나가는 방식은 다음과 같습니다(`src/server.mjs`의
`errorResponse`, `src/upstream-errors.mjs`의 `sessionError`).

| 조건 | 상태 | 오류 유형 |
|---|---|---|
| `GET /health`와 `HEAD /api/hello`를 뺀 경로에서 토큰이 없거나 틀림 | 401 | `authentication_error` |
| 인증된 요청이 알 수 없는 메서드나 경로를 요청함 | 404 | `not_found_error` |
| 본문이 `MAX_BODY_BYTES`보다 크거나, JSON이 잘못됐거나, 형식이 맞지 않음. 413은 쓰지 않습니다 | 400 | `invalid_request_error` |
| 도구 없이 `tool_choice`가 `any`임, 선언되지 않은 도구를 지정함, 지원하지 않는 모드 | 400 | `invalid_request_error` |
| 계정의 Copilot 카탈로그에 없는 모델 | 400 | `invalid_request_error` |
| 수준을 나열하는 모델에 알려진 수준이 아닌 effort 값 | 400 | `invalid_request_error` |
| Copilot이 세션 기록을 줄이기 시작함([컨텍스트 초과](#컨텍스트-초과)의 `prompt is too long` 오류) | 400 | `invalid_request_error` |
| SDK `session.error`의 `errorType`이 `rate_limit`나 `quota`이거나 `statusCode`가 429 | 429 | `rate_limit_error` |
| SDK `session.error`의 `statusCode`가 500에서 599 사이 | 529 | `overloaded_error` |
| 런타임이 업스트림 429나 5xx 재시도를 기다리는 중에 턴이 시간 초과됨(아래 참고) | 429 또는 529 | `rate_limit_error` 또는 `overloaded_error` |
| 클라이언트가 연결을 끊거나 취소함(대기 중일 때 포함). 응답이 아직 시작되지 않았을 때만 JSON 본문을 씁니다 | 499 | `client_closed_request` |
| 대기 중인 업스트림 재시도 없이 턴이 시간 초과됨 | 500 | `api_error` |
| 그 밖의 모든 경우. 세션 작업 시간 초과, 그 밖의 `session.error`(다른 업스트림 4xx, `errorType` 값 `context_limit`), `MAX_TOOL_RESULTS`를 넘는 도구 결과, Copilot이 거부한 도구 결과, 내부 오류 | 500 | `api_error` |

- SSE 응답이 시작된 뒤의 실패는 위 오류 유형을 담은 `event: error` 프레임으로
  보냅니다. 이때 HTTP 상태는 이미 200입니다.
- Claude Code는 429와 529를 스스로 재시도합니다.
- SDK 오류 이벤트에는 재시도 시간이 없으므로, 실제 업스트림 실패에는 `retry-after`
  헤더가 붙지 않습니다.

**업스트림 재시도 대기.** Copilot 런타임은 업스트림 429나 5xx를 먼저 스스로
재시도합니다. 업스트림이 `retry-after`를 주면 그만큼 기다리고, 기다리는 동안에는
이벤트를 보내지 않습니다. 재시도를 모두 쓰면 턴을 끝내고, 그제야 `session.error`를
보고합니다. 그래서 메시지 없이 끝난 루트 턴은 빈 성공으로 끝나지 않고, 그 오류나
뒤따르는 유휴 이벤트를 기다립니다. 마지막 루트 `model.call_failure`의 상태가 429나
5xx이고, 그 뒤로 진행도 새 `model.call_start`도 없는 동안 유휴 제한이나 전체 상한에
걸리면 요청은 실패합니다. 이때 상태는 500이 아니라 그 상태를 옮긴 429나 529입니다.
`bridge.turn_timeout`은 그 상태를 `upstreamRetryStatus`로 기록합니다. 한 번의
실측에서 이 대기가 얼마나 걸렸는지는 [검증 이력](VERIFICATION_HISTORY_KO.md)에
있습니다.

**테스트용 오류 주입.** `BRIDGE_TEST_FAULTS`는 테스트 훅이며 기능이 아닙니다. 예를
들어 `BRIDGE_TEST_FAULTS="rate_limit:1,overloaded:1"`은 도구를 선언한 요청을 적힌
순서대로 그 수만큼, Copilot에 닿기 전에 실패시킵니다. 종류는 세 가지입니다.
`rate_limit`와 `overloaded`는 실제 업스트림 실패와 같은 변환을 거칩니다.
`context_limit`는 브리지 자체의 `prompt is too long` 오류를 일으킵니다. 이 값은
`npm test`만 설정하므로 실측 매트릭스는 이 변환을 확인하지 않습니다.

## 알려진 제약

다음은 구현의 한계입니다. 기능 단위의 한계는 [호환성](COMPATIBILITY_KO.md)에
있습니다. 브리지가 종료될 때 진행 중이던 턴과, 도구 결과 재시도가 아닌 반복 요청은
[아직 구현하지 않은 것](COMPATIBILITY_KO.md#아직-구현하지-않은-것)에 있습니다.

- **Claude Code 릴리스마다 호환성을 검토해야 합니다.** 브리지는 Anthropic으로
  그대로 전달하지 않고 Copilot SDK로 변환합니다. 그래서 새 Claude Code 릴리스가
  추가하는 헤더나 본문 필드는 자동으로 지원되지 않습니다.
- **SDK와 런타임 업그레이드는 테스트가 필요합니다.** 브리지는 SDK의 대기 중 외부
  도구 RPC에 의존합니다.
- **바이너리 도구 결과는 공급자에 따라 다릅니다.** 요청에 든 이미지와 문서 블록은
  변환합니다. 로컬 도구가 반환하는 바이너리 이미지나 문서에는 텍스트 대체 수단이나
  처음부터 첨부하는 방법이 필요할 수 있습니다.
- **한 사용자, 한 컴퓨터.** [보안 경계](#보안-경계)를 참고하세요.

## 검증 범위

두 명령으로 브리지를 테스트합니다. `npm test`는 오프라인으로 돌고 비용이 없습니다.
`npm run verify`는 실제 Claude Code로 실제 Copilot 모델을 구동하며 GitHub Copilot AI
Credits를 씁니다. 마지막 전체 실행은 커밋 `bed30ce`에서 66개 슬롯을 모두
통과했고, 그 뒤로 매트릭스를 다시 돌리지 않았습니다. 그 실행이 다루는 범위와 그
뒤의 코드 변경은 [검증한 것](../README_KO.md#검증한-것)과
[검증하지 않은 것](../README_KO.md#검증하지-않은-것)에 있습니다. 실행 자체는
[검증 결과](VERIFICATION_KO.md)에, 이전 실행과 일회성 실측은
[검증 이력](VERIFICATION_HISTORY_KO.md)에 있습니다.

### `npm test`가 확인하는 것

`npm test`는 브리지, 설정 작성기, 데몬, 검증 하네스를 가짜 Copilot SDK 클라이언트에
연결해 실행합니다. 변환, 세션 관리, 오류 변환, 설정 생성을 확인합니다. 실제
모델이나 실제 Claude Code 빌드의 동작은 확인하지 않습니다.

| 영역 | 테스트가 확인하는 것 |
|---|---|
| 변환 | Messages 텍스트, 첨부 파일, 도구 결과와 SSE 변환, 한 번에 하나만 여는 콘텐츠 블록, 마지막 도구 결과에 합치는 옆 사용자 텍스트, 명시적인 0 사용량 유지와 없는 사용량만 추정 |
| 모델과 effort | 모델 ID와 계열 별칭 변환, 6행 `/model` 목록, 모델별 `[1m]` 표시, 탐색 목록, `ultracode` → `xhigh`, 모델별 effort 조정, effort 변경 시 `session.setModel()` |
| 세션 | 루트와 서브에이전트 분리, 6개 모델에서 번갈아 오는 루트와 작업자의 도구 결과, 작업자 하나를 취소해도 이어지는 형제 작업자, 포크한 서브에이전트의 기록, `agentId`를 쓴 도구 호출 넘겨주기, 취소, 내보내기, 크기를 제한한 재전송, 도구 결과 멱등성, 런타임 MCP 탐색과 `disabledMcpServers`(실패와 시간 초과 시 대체 동작 포함) |
| 오류 | `BRIDGE_TEST_FAULTS`를 거친 429와 529 변환, 재시도 대기 중 시간 초과 변형, 요청 정책, 엄격한 모델 선택 |
| 실행과 데몬 | Direct와 LiteLLM 설정 값(두 경로의 서브에이전트 모델과 Direct 경로에만 있는 Explore 설정 포함), 권한 `0600` 파일, LiteLLM 기본 URL 검사, 데몬 레지스트리, 교체와 점유 파일, 심볼릭 링크로 실행한 진입점, 사용자의 현재 Claude 공급자 감지(`ghcp-doctor`가 사용) |
| 진단 로그 | 이벤트와 필드 이름 |
| 검증 하네스 | 엄격한 통과 기준, 보고서 생성, 드라이버, 타임아웃, 미디어 테스트 자료 |

### `npm run verify`가 실행하는 것

- **슬롯.** 6개 모델 × 11개 시나리오 = 66개 슬롯입니다. 슬롯은 모델 하나가 시나리오
  하나를 실행하는 단위입니다. 시나리오별 목적과 통과 기준은
  [시나리오](VERIFICATION_KO.md#시나리오)에 있습니다.
- **v01~v10.** 슬롯마다 자기 브리지를 띄웁니다. 포트, 토큰, `CLAUDE_CONFIG_DIR`,
  Direct 설정 작성기가 만든 `settings.json`, 체크아웃 밖 임시 디렉터리의 작업 공간도
  슬롯마다 따로 씁니다. 실제 `claude` 실행 파일을 그 브리지에 연결해
  `-p --output-format stream-json`으로 실행합니다.
- **v11.** 슬롯이 `bin/claude-ghcp` 자체를 실행하고(`--background`, 이어서 `-p`,
  이어서 `agents --json --all`), 슬롯 전용 `GHCP_DAEMON_DIR`로 런처가 시작하는
  데몬도 씁니다. 이 슬롯에서는 하네스가 띄운 브리지를 쓰지 않습니다. 슬롯은 각
  명령의 출력을 보관하고, 멈추기 전에 데몬의 `bridge.log`와 Claude Code 데몬 로그를
  복사합니다. 백그라운드 작업의 상태에서는 상태와 시간 필드만 보관하고, 환경이나
  소켓 키는 보관하지 않습니다.
- **실행하지 않는 것.** LiteLLM을 쓰는 슬롯은 없습니다. `scripts/verify/tui.mjs`로
  대화형 TUI를 구동할 수 있지만, 이를 쓰는 시나리오는 없습니다.
- **판정.** 각 슬롯은 디스크의 파일, git 기록, 훅 로그, 어떤 도구가 실행됐는지에
  대한 스트림 자체의 기록으로 판정합니다. 모든 단계의 결과 기록에는 중지 사유와
  0보다 큰 입력 사용량이 있어야 하고 오류가 없어야 합니다. 모델 텍스트는 시나리오가
  심어 둔 토큰이 있는지 확인합니다. 예외는 두 가지입니다. v05는 모든 단계를 마쳤다는
  답을 파일과 대조하고, v08은 명령이 차단됐다고 답해야 통과합니다.
- **판정 결과.** 슬롯은 `pass`, `fail`, `blocked` 중 하나입니다. `blocked`(실행
  불가)는 슬롯을 판정할 수 없었다는 뜻입니다. 실행이 끝나지 않았거나(시간 초과,
  실행 실패, 결과 이벤트 없음), `tool_use`와 `tool_result`가 짝을 이루지 않았거나,
  `modelUsage`에 기대한 모델이 없거나, 어떤 단계가 실행되지 않았거나, 하네스 자체가
  실패한 경우입니다. v11은 하네스 실패가 아니면 `pass`나 `fail`만 보고합니다. `blocked`
  슬롯은 통과로 치지 않으며 집계에 그대로 남습니다.

**엄격한 통과 기준**(`summary.json`의 `strict-all-pass-v1`). 실행은 기대한 모든
슬롯이 통과해야만 통과합니다. 전체 실행에서는 66개 모두, 부분 실행(`--models` 또는
`--scenarios`)에서는 고른 슬롯 모두입니다. 부분 실행의 통과는 전체 실행의 통과가
아닙니다. 슬롯이 빠졌거나, 중복되었거나, 예상 밖이면 실행은 실패합니다.
`~/.claude/settings.json`이 바뀌었을 때도 실패합니다. 실행기는 SHA-256 다이제스트를
비교하고 내용은 저장하지 않습니다. 실행 중에 코드가 바뀌어도 실패합니다. 코드에
대해서는 시작과 끝에 git 커밋, 그리고 `src/`, `scripts/verify/`, `bin/`, 루트 패키지
파일에 대한 SHA-256을 기록합니다. 그래서 커밋하지 않은 변경이 있는 체크아웃도 그
사이에 아무것도 바뀌지 않으면 통과할 수 있습니다. 실행기가 출력하는 가중 기능
커버리지는 시나리오 카탈로그를 설명할 뿐이며, 통과율이 아닙니다.

**모델 확인이 증명하는 것.** 하네스는 Claude Code `result.modelUsage`의 키 가운데
하나에 기대한 Copilot 또는 Claude Code 모델 ID가 들어 있으면 슬롯을 받아들입니다.
이 키는 Claude Code가 요청한 모델 ID입니다. 따라서 이 확인은 Claude Code가 올바른
모델을 요청했다는 것만 증명하며, Copilot이 실제로 어느 모델로 응답했는지는 증명하지
않습니다. 브리지는 실제로 응답한 모델을 `bridge.turn_completed`의 `servedModels`에
기록합니다. 하네스는 이 기록을 슬롯의 브리지 로그에 보관하지만 확인하지는 않습니다.
v11에는 모델 확인이 없습니다.

### 명령과 플래그

```bash
npm test                 # 오프라인 테스트. 모델 호출도 비용도 없습니다
npm run verify           # 기본 설정으로 전체 매트릭스 실행
npm run verify:plan      # 카탈로그를 확인하고 커버리지를 출력. 아무것도 시작하지 않습니다
npm run verify:report    # 가장 최근 실행을 그 실행 자체의 기록으로 출력

# 드라이버를 작업하는 동안 슬롯 하나만 실행
npm run verify -- --models claude-opus-5.5 --scenarios v04-shell-ops

# 마지막으로 통과한 전체 실행의 설정
PENDING_TOOL_WAIT_MS=30000 npm run verify -- \
  --timeout-scale 2 --model-concurrency 3 --scenario-concurrency 2
```

| 플래그 | 기본값 | 효과 |
|---|---|---|
| `--models a,b` | 6개 모두 | 이 Copilot 모델 ID만 실행합니다. |
| `--scenarios id,id` | 11개 모두 | 이 시나리오 ID만 실행합니다. |
| `--model-concurrency N` | 6 | 동시에 실행할 모델 수입니다. |
| `--scenario-concurrency N` | 2 | 모델마다 동시에 실행할 시나리오 수입니다. |
| `--timeout-scale X` | 1 | 하네스의 대기 시간에 곱합니다(아래 참고). |
| `--out DIR` | `.verify-runs/` | 실행 디렉터리를 쓸 위치입니다. |
| `--dry-run` | 끔 | 계획, 커버리지, 단일 턴 기준 일정 추정을 출력하고 끝냅니다. 아무것도 시작하지 않습니다. |
| `--keep-workspaces` | 끔 | 모든 슬롯의 작업 공간을 남깁니다. 통과하지 못한 슬롯의 작업 공간은 늘 남깁니다. |

- **`--timeout-scale`.** 헤드리스 Claude Code 실행 하나하나의 제한 시간(슬롯 단위가
  아니라 실행 단위), plan 모드 턴, v11의 런처와 출력 대기, 브리지 상태 확인 대기에
  곱합니다. v11의 카탈로그 제한 시간은 일정 추정에만 쓰입니다. 상태 확인·목록·중지·
  정리 명령, 폴링, 강제 종료 유예 시간, 런처와 데몬 자체의 시작 제한에는 곱하지
  않습니다.
- **`PENDING_TOOL_WAIT_MS`.** 하네스 플래그가 아니라 브리지 설정입니다. 셸에 설정하면
  하네스가 띄우는 모든 브리지와 v11 런처에 배수 없이 그대로 전달되고,
  `summary.json`의 `execution` 아래에 기록됩니다.

각 실행은 `.verify-runs/<timestamp>/`에 기록됩니다. 여기에는 `summary.json`,
`slots.jsonl`, 그리고 슬롯마다 브리지 로그, 설정, 대화 기록을 담은 디렉터리가
하나씩 생깁니다. `.verify-runs/`는 git이 무시하며 로컬 컴퓨터에만 남습니다.

**결과 게시.** `npm run verify:doc`는 가장 최근 실행으로 `docs/VERIFICATION.md`와
[검증 결과](VERIFICATION_KO.md)를 다시 만듭니다. 가장 최근 실행은 부분 실행이거나
끝나지 않은 실행일 수도 있습니다. 끝난 특정 전체 실행을 게시하려면 그 디렉터리를
지정해 두 언어 모두에 쓰세요.

```bash
run_dir=".verify-runs/<completed-run-id>"
node scripts/verify/report.mjs "$run_dir"
node scripts/verify/report.mjs "$run_dir" --markdown > docs/VERIFICATION.md
node scripts/verify/report.mjs "$run_dir" --markdown=ko > docs/VERIFICATION_KO.md
```

## 주요 파일

| 파일 | 역할 |
|---|---|
| `bin/claude`, `bin/claude-ghcp` | Direct 런처(`bin/claude`는 `claude-ghcp`를 실행). 상주 브리지와 print 모드 브리지 중 하나를 고르고, 실행 설정을 쓰고, Claude Code를 시작합니다 |
| `bin/claude-ghcp-status`, `bin/claude-ghcp-stop` | 상주 브리지 상태 확인과 중지 |
| `bin/claude-litellm` | 임시 설정을 쓰는 LiteLLM 런처 |
| `bin/claude-current` | 원래 공급자로 Claude Code 실행 |
| `bin/ghcp-doctor`, `bin/ghcp-models` | 환경 점검과 모델 목록 |
| `bin/resolve-claude.sh` | 실제 Claude Code 실행 파일 찾기 |
| `src/server.mjs` | HTTP와 SSE 서버, 인증, 본문 검사, 오류 변환, 진단 로그 |
| `src/session-manager.mjs` | SDK 세션, 요청 묶음, 재사용, 재전송, 타임아웃, 도구 넘겨주기, 런타임 MCP 탐색 |
| `src/anthropic.mjs` | Anthropic Messages 요청과 응답 변환, SSE, 사용량, effort 추출 |
| `src/request-policy.mjs` | `tool_choice` 흉내, 적용하지 않는 제어 값과 무시하는 필드 |
| `src/model-map.mjs` | 모델 ID, 별칭, `/model` 목록, 컨텍스트 표시와 등급, effort 결정 |
| `src/upstream-errors.mjs` | Copilot 요청 한도와 업스트림 5xx를 429와 529로 변환, 테스트용 오류 주입 |
| `src/bridge-daemon.mjs`, `src/retirement.mjs` | 상주 브리지의 레지스트리, 설정 지문, 점유 파일, 교체, 상태 확인과 중지. 교체된 브리지가 종료해도 되는 시점 판단 |
| `src/claude-gateway-env.mjs`, `src/write-launch-settings.mjs`, `src/write-litellm-settings.mjs` | 두 경로가 함께 쓰는 설정, Direct와 LiteLLM 설정 파일(권한 `0600`) |
| `src/copilot-home.mjs`, `src/copilot-session-rpc.mjs`, `src/entry-point.mjs` | `COPILOT_HOME` 결정, SDK 세션 RPC 도우미, 심볼릭 링크를 거친 진입점 감지 |
| `src/doctor.mjs`, `src/list-models.mjs`, `src/model-cli.mjs`, `src/provider-detection.mjs`, `src/settings-file-state.mjs`, `src/version.mjs` | 명령줄 도우미 |
| `scripts/verify/`, `test/` | 실측 검증 하네스와 `npm test` |

## 참고 자료

- [GitHub Copilot SDK](https://github.com/github/copilot-sdk)
- [Copilot SDK 멀티테넌시와 `mode: empty`](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/multi-tenancy)
- [Copilot SDK Node.js API](https://github.com/github/copilot-sdk/blob/main/nodejs/README.md)
- [Copilot SDK 수동 외부 도구 넘겨주기 예제](https://github.com/github/copilot-sdk/blob/main/nodejs/samples/manual-tool-resume.ts)
- [Copilot SDK 스트리밍 이벤트](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events)
- [Copilot SDK 인증](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate)
- [GitHub Copilot 지원 모델](https://docs.github.com/en/copilot/reference/ai-models/supported-models)
- [Claude Code 게이트웨이 프로토콜](https://code.claude.com/docs/en/llm-gateway-protocol)
- [Claude Code 서드파티 게이트웨이 지원 범위](https://code.claude.com/docs/en/llm-gateway)
- [Claude Code 게이트웨이 연결 설정](https://code.claude.com/docs/en/llm-gateway-connect)
- [Claude Code 모델과 effort 설정](https://code.claude.com/docs/en/model-config)
- [Claude Code 동적 워크플로](https://code.claude.com/docs/en/workflows)
- [Claude Code 설정](https://code.claude.com/docs/en/settings)
