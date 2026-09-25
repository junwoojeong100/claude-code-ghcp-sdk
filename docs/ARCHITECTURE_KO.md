# 아키텍처

> **언어 / Language:** [English](ARCHITECTURE.md) | 한국어

이 브리지는 Claude Code가 GitHub Copilot 모델을 쓰게 해 주는 로컬 HTTP 서버입니다.
Claude Code 쪽으로는 Anthropic Messages API로 응답하고, 반대쪽으로는 공개된
`@github/copilot-sdk`를 구동합니다. 문서화되지 않은 Copilot 엔드포인트는 호출하지
않습니다. 비공식 통합입니다.

요청 흐름, 세션과 저장 방식을 다루는 유지보수자용 참고 문서입니다. 설치와 실행은
[README](../README_KO.md), 다른 게이트웨이 경로는 [LiteLLM](LITELLM_KO.md), 기능별
지원 여부는 [호환성](COMPATIBILITY_KO.md#기능별-확인)을 보세요.

**이 문서에서:** [요청](#요청-흐름) · [보안](#보안-경계) · [세션](#세션-분리) ·
[모델](#모델-탐색과-컨텍스트) · [실행 설정](#실행-설정) · [데몬](#상주-브리지와-교체)

**다른 유지보수 가이드:** [진단](DIAGNOSTICS_KO.md) · [테스트](TESTING_KO.md)

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
| `GET /health` | 필요 없음 | `ok`, `instanceId`, `preferredModel`, `modelCount`, `capabilities`를 반환합니다. `BRIDGE_VERIFY_OBSERVE=1`이면 브리지의 런타임 `timeouts`도 반환합니다. |
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
  `tool_use` 블록 하나로 씁니다. Copilot이 한 턴 안에서 같은 도구 호출 ID를
  되풀이하면 JSON과 SSE 모두 한 번만 반환하고, `bridge.turn_completed.toolUses`에도
  한 번만 셉니다.
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
  만듭니다. 이 토큰은 어느 로컬 사용자든 읽을 수 있는 명령줄에 나타나지 않습니다.
  브리지는 `BRIDGE_API_KEY`로 받고, `claude-ghcp`는 모델 확인과
  `write-launch-settings.mjs`에 `GHCP_BRIDGE_TOKEN`으로 넘깁니다. Claude Code는
  설정 파일에서 `ANTHROPIC_AUTH_TOKEN`으로 읽어 `Authorization: Bearer`로 보냅니다.
- **인증 없는 경로.** 어느 로컬 프로세스든 `GET /health`를 호출해 브리지의
  `instanceId`, 기본 모델, 모델 수, 기능 목록을 읽을 수 있습니다.
  `BRIDGE_VERIFY_OBSERVE=1`로 시작한 브리지라면 시간 제한 값도 읽을 수 있습니다.
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
- **로그.** 요청·턴 요약에는 프롬프트, 도구 내용, 자격 증명을 넣지 않습니다.
  합쳐진 로그에는 민감한 내용을 거르지 않은 오류 텍스트도 있을 수 있으므로 공유 전에
  검토하세요. [로그](DIAGNOSTICS_KO.md#로그)를 참고하세요.
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
디렉터리의 권한은 `0700`입니다. 상대 경로인 `GHCP_DAEMON_DIR`는 실행한 디렉터리를
기준으로 풉니다. `~`는 펼치지 않으므로 `~`로 시작하는 값은 거부합니다.

| 파일 | 내용 | 권한 | 지우는 시점 |
|---|---|---|---|
| `<데몬 디렉터리>/bridge.json` | 상주 브리지의 포트, 토큰, PID, `instanceId`, 시작 모델, 설정 지문 | `0600` | 브리지가 교체되거나 멈출 때 |
| `<데몬 디렉터리>/retired/<instanceId>.json` | 교체된 브리지의 같은 기록(토큰 포함) | `0600` | 그 교체된 브리지가 종료한 뒤 새 브리지를 시작하는 실행이 지웁니다. `claude-ghcp-stop`도 지웁니다. |
| `<데몬 디렉터리>/settings/<random>.json` | 실행 하나의 Claude Code 설정(브리지 토큰 포함) | `0600` | 런처가 끝나도 남습니다. 이후 `bridge-daemon.mjs ensure`가 실행될 때마다(print 모드가 아닌 `claude-ghcp` 실행은 모두 이를 거칩니다) 24시간이 지난 파일을 지웁니다. 실행이 기존 브리지를 교체하지 않고 멈추면 디렉터리 전체를 지웁니다. `claude-ghcp-stop`도 전체를 지웁니다. |
| `<데몬 디렉터리>/leases/<instanceId>.<random>.pid` | 런처 셸의 PID | `0600` | 런처가 끝날 때 지웁니다. 새 브리지를 시작하는 실행은 PID가 죽은 파일을 지웁니다. `claude-ghcp-stop`은 모두 지웁니다. |
| `<데몬 디렉터리>/bridge.log` | 상주 브리지의 출력과 진단 로그 | `0600` | `claude-ghcp-stop`이 지웁니다. |
| `$TMPDIR/claude-ghcp.XXXXXX/` | print 모드 실행의 설정 파일(`0600`)과 브리지 로그 | 디렉터리 `0700` | 그 런처가 끝날 때 |
| `$TMPDIR/claude-litellm.XXXXXX/settings.json` | `claude-litellm` print 모드 실행(`--background`나 `--bg` 없는 `-p`)의 설정(LiteLLM 키 포함) | `0600` | 그 런처가 끝날 때 |
| `${XDG_STATE_HOME:-~/.local/state}/claude-code-ghcp-sdk/litellm-settings/<random>.json` | 그 밖의 모든 `claude-litellm` 실행의 설정. LiteLLM 키와 게이트웨이 URL이 들어 있습니다. 상대 경로인 `XDG_STATE_HOME`는 무시하고 `~/.local/state`를 씁니다 | `0600`, 디렉터리는 `0700` | 런처가 끝나도 남습니다. Claude Code가 `/background` 작업을 이 파일로 다시 시작하기 때문입니다. print 모드가 아닌 이후 `claude-litellm` 실행마다 7일이 지난 파일을 지웁니다. 그 밖에는 아무것도 지우지 않으며 `claude-ghcp-stop`도 마찬가지입니다. 이 디렉터리는 직접 지워도 되지만, 아직 그 파일을 쓰는 `/background` 작업은 다시 시작하지 못합니다 |
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
묶음의 다른 상태가 그사이 이 대화를 이어 갔다면, 브리지는 상태를 폐기하고
(`bridge.history_reconciled`) 새 세션을 시작합니다. 다른 상태에서 Copilot이 받아들인
마지막 요청(나중에 중단되거나 실패한 요청도 포함)이 이 상태 자신의 마지막 요청보다 나중이고, 그 요청 기록이 들어온 기록의 앞부분과 같으면서
이 상태가 본 기록보다 짧지 않거나, 들어온 기록이 그 다른 상태의 기록을 이 상태가 본
것보다 더 많이 담고 있으면 그 상태가 대화를 이어 간 것으로 봅니다. 브리지는 묶음 안
상태마다 Copilot이 받아들인 마지막 요청을 기억합니다. 16개를 넘으면 가장 오래된 것을 잊고, 자신의
마지막 요청이 잊은 요청보다 앞선 상태는 재전송합니다. 제목 생성이나 WebFetch 처리처럼 무관한 기록을 쓰는 부수
호출은 상태를 건드리지 않습니다. 비교할 때 `cache_control` 표시와
인라인 `system` 항목은 무시합니다. 사용자 정의 에이전트 정의나 출력 스타일 같은
인라인 시스템 텍스트는 SDK 시스템 메시지에 합치며, 알아볼 수 있는 요청별 토큰
예산 메모는 뺍니다. 실제 사용자·어시스턴트 내용, 도구 입력, 시스템 지시가 바뀌면
다른 기록으로 봅니다.

**재개와 재전송.** 브리지가 만드는 SDK 세션은 모두 다시 쓰지 않는 새 난수 ID
`claude-ghcp-<16진수 32자리>`를 받습니다. 한 브리지 프로세스 안에서 브리지가 일반적으로
내보낸 상태는 세션 ID와 그 상태가 가진 대화 기록과 함께 기억되고, 그 상태에 대한 다음
요청은 그 SDK 세션을 재개합니다. 이때도 요청을 기억한 기록과 대조하므로, 되감거나 고친
기록은 여전히 폐기하고 재전송합니다. 시간 초과나 취소가 아닌 이유로 재개가 실패하면
새 세션을 만듭니다. 그 밖에는 재개하지 않습니다. 더 이상 기억하지 않는 상태와, 브리지
프로세스가 다시 시작한 뒤의 모든 상태는 새 세션을 받습니다. 새 세션에는 이전 대화를
텍스트로 넣어 줍니다. 최대 `MAX_REPLAY_BYTES`까지 넣고 최신 메시지를 남깁니다. 이를 콜드
재전송이라고 합니다. 콜드 재전송은 tool-use ID, 도구 결과의 오류 표시,
`tool_reference` 이름을 유지합니다.

**내보내기와 폐기.** 일반적인 내보내기(아래 `MAX_STATES`, `STATE_IDLE_TTL_MS`
한도)는 SDK 세션을 디스크에 남기고, 재개를 위해 내보낸 상태를 최대
4 × `MAX_STATES`개까지 기억하며 가장 오래된 것부터 잊습니다. 잊은 세션은 재개할 수
없으므로 이후 요청은 콜드 재전송을 하지만, 세션은 디스크에 남습니다. Copilot이 기록을
줄인 상태는 내보낼 때 지우며, 그 상태에 대한 다음 요청은 내보내지 않았을 때와 똑같이
400 `prompt is too long` 오류(`bridge.context_limit`, `phase` 값 `between_requests`)로
실패합니다. 상태를 폐기하면 그 SDK 세션을 `COPILOT_HOME`에서 지웁니다. 브리지는
기록이 바뀌었을 때와 컨텍스트 한도에 닿았을 때 상태를 폐기합니다. effort 변경이
실패했거나, Copilot이 5초 안에 확인하지 않은 중단이 있었거나, Copilot이 콜드 재전송을
받았다고 확인하지 않았을 때(실패·취소·시간 초과) 상태가 무효가 되어도 폐기합니다.
그래야 다시 시도할 때 대화를 다시 재전송합니다.

**도구 넘겨주기.** Claude Code `toolCallId`와 SDK의 대기 중인 요청을 잇는 대응표는
브리지 메모리에 있습니다. 턴이 끝날 때 브리지는 Copilot이 각 도구 호출을 등록할
때까지 기다린 뒤 그 호출을 반환합니다.

**한도.** 다음 변수가 세션과 턴을 제한합니다. 기본값은
[`.env.example`](../.env.example)에 있고, 모두 상주 브리지의
[설정 지문](#상주-브리지와-교체)에 들어갑니다.

| 변수 | 제한하는 것 | 한도에 닿으면 |
|---|---|---|
| `MAX_STATES` | 캐시한 상태 수 | 가장 오래 쓰지 않은 유휴 상태부터 내보냅니다. 그래도 많으면, 답을 받지 못한 도구 호출만 남은 상태 가운데 가장 오래 쓰지 않은 것부터 폐기합니다. 늦게 온 도구 결과는 콜드 재전송됩니다. 진행 중인 턴이 있는 상태와 방금 요청을 처리한 상태는 내보내지 않습니다. |
| `STATE_IDLE_TTL_MS` | 진행 중인 턴도 대기 중인 도구 호출도 없는 상태의 유휴 시간 | 다음 요청이 시작될 때 그 상태를 내보냅니다. |
| `MAX_REPLAY_BYTES` | 새 세션에 다시 넣는 기록의 크기 | 오래된 메시지를 버리고 `bridge.history_replay_truncated`를 남깁니다. |
| `MAX_TOOL_RESULTS` | 요청 하나에 든 도구 결과 수 | 요청이 500으로 실패합니다. |
| `PENDING_TOOL_WAIT_MS` | Copilot이 도구 호출을 등록하기를 기다리는 시간 | 그 호출을 턴에서 뺍니다(`bridge.unregistered_tool_call`). |
| `SESSION_OPERATION_TIMEOUT_MS` | SDK `session.create`, `session.resume`, `session.set_model` 호출 하나하나 | 요청이 500으로 실패합니다(`bridge.session_operation_failed`). 늦게 온 응답은 버립니다(`bridge.session_creation_abandoned`). |
| `TURN_IDLE_TIMEOUT_MS` | 턴에서 진행이 없는 시간. 루트 턴 시작, 메시지와 턴 종료 이벤트, 비어 있지 않은 텍스트·추론·도구 입력 증분을 진행으로 칩니다. 빈 증분과 서브에이전트 이벤트는 진행으로 치지 않습니다. | 턴을 중단하고 500으로 실패합니다(`bridge.turn_timeout`, 사유 `timeout`). |
| `TURN_MAX_DURATION_MS` | 턴 하나의 전체 길이. 계속 스트리밍하는 턴에도 적용합니다. | 위와 같고, 사유는 `duration_limit`입니다. |
| `CLEANUP_TIMEOUT_MS` | 정리 단계에서 시도하는 중단, 연결 해제, 삭제 하나하나 | 정리를 계속 진행합니다. |

런타임이 업스트림 실패를 재시도하려고 기다리는 동안 턴이 시간 초과되면 500이 아니라
429나 529로 실패합니다. [업스트림 오류](DIAGNOSTICS_KO.md#업스트림-오류)를
참고하세요. 호출자의 취소와 종료도 세션 작업과 턴을 끝냅니다.

**종료.** 브리지는 `SIGTERM`이나 `SIGINT`를 받으면 새 연결을 받지 않고 세션을 멈춘 뒤
상태 0으로 종료합니다. 교체된 브리지가 `bridge.retired_exit` 뒤 스스로 종료할 때도
같습니다. 이때 SDK 세션을 `COPILOT_HOME`에서 지우지는 않습니다.
5초(중단 대기) + 5 × `CLEANUP_TIMEOUT_MS` + 20초, 기본값으로 50초 안에 종료를 끝내지
못하면 `bridge.shutdown_forced`를 남기고 상태 1로 종료합니다. 응답하지 않는 Copilot
런타임을 끝없이 기다리지 않기 위해서입니다.

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
다른 선언된 도구와 똑같이 전달합니다. V03은 CLI 소유 로컬 MCP fixture의 예상한 도구
오류와 같은 세션의 회상으로 이 경로를 검사합니다. 런타임 MCP 차단에는 production
오프라인 회귀 테스트가 있으며, 실측 행렬은 사용자의 외부 MCP 서비스나 런타임 탐색
실패를 검사하지 않습니다.

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

`bridge.context_budget`은 런타임이 보고한 입력 한도를 남깁니다. Claude Code에 표시한
컨텍스트 창과 별개이며 더 작을 수 있으므로, 대화는 Claude Code의 자동 압축 전에
이 한도에 닿을 수 있습니다. 한도는 Copilot 카탈로그와 런타임에서 오므로 브리지를
바꾸지 않아도 달라질 수 있습니다. V06은 수동 `/compact`, 회상과 정상 종료 뒤의 콜드
재개를 검사합니다. 컨텍스트 창 전체의 수용량이나 초과 시 자동 복구를 측정하지는
않습니다.

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
`api_error`가 됩니다. [업스트림 오류](DIAGNOSTICS_KO.md#업스트림-오류)를 참고하세요.

### 사용량 집계

Copilot은 캐시된 토큰을 포함해 입력 토큰을 보고하고, Anthropic은 세 가지 수를
따로 보고합니다. 브리지는 캐시되지 않은 입력을
`max(0, inputTokens - cacheReadTokens - cacheWriteTokens)`로 반환하고, Copilot의 캐시
수를 `cache_read_input_tokens`와 `cache_creation_input_tokens`로 넘깁니다. 그래서
캐시된 230K 토큰 요청이 약 460K로 보이지 않습니다. 스트리밍 응답에서는
`message_start`가 요청 추정값을 담고(끝나기 전에 중단된 응답은 이 값을 유지합니다),
마지막 `message_delta`가 실제 수를 담습니다. Claude Code는 나중 값이 0보다 크지 않으면
`message_start`의 값을 유지하므로, 전부 캐시된 턴은 `input_tokens: 1`을 보고하고
`cache_read_input_tokens`(또는 `cache_creation_input_tokens`)를 하나 줄여 합계가 JSON
응답과 같게 합니다. JSON에서는 명시적인 0을 0으로 둡니다. 스트림에서 SDK가 캐시 없이
0을 측정하면 Claude Code에는 추정값이 남습니다.
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
  제한합니다.
- 비워 둔 공급자 선택 변수와 물려받은 모델 옵션은, 셸이나 사용자 설정의 값이
  요청을 게이트웨이가 아닌 곳으로 보내지 못하게 합니다.
- `ENABLE_TOOL_SEARCH`가 비어 있으면 Claude Code 자체 도구 검색과 `tool_reference`가
  꺼지고, 모델은 선언된 도구 전체를 받습니다. Direct 실행마다 읽는
  `GHCP_NATIVE_TOOL_SEARCH=1`은 Claude Code의 도구 검색을 켭니다. SDK 자체 도구
  검색은 늘 꺼 둡니다. 선언만 한 도구가 SDK 도구 검색 아래에서 멈출 수 있기
  때문입니다.

## 상주 브리지와 교체

print 모드는 난수 토큰을 쓰는 전용 브리지를 시작하고, 끝날 때 그 브리지를
멈춥니다. `SIGTERM`을 보내고 30초 뒤에도 실행 중이면 `SIGKILL`을 보냅니다. 나머지 모든 실행은 `src/bridge-daemon.mjs ensure`가 시작하는 상주 브리지
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
`BRIDGE_TEST_FAULTS`, `BRIDGE_VERIFY_OBSERVE`입니다. 재사용된 브리지는 모델을 쓸 수 있는지 확인한 뒤 어떤
실행 모델이든 처리합니다. 브리지는 자신을 시작한 실행의 환경 전체를 물려받으므로,
지문 밖의 변수는 그 실행의 값을 유지합니다.

**실행마다 하는 일.** 동시에 실행한 런처들은 `bridge.lock`으로 차례를 지킵니다. 새
브리지는 60초 안에 자신의 `instanceId`로 `/health`에 응답하고
`/v1/models?all=true`에 실행 모델을 보여야 합니다. 그러지 못하면 실행이 실패합니다.
고정 포트에서 다른 프로세스가 응답해도 인정하지 않으며, 새 브리지가 종료하면
`Persistent bridge exited; inspect <log>.`로 실패합니다. 그 뒤 런처 자신의 `/health`
확인이 실패하면 `Timed out waiting for the GHCP bridge.`와 `bridge.log`의 마지막 120줄을
출력합니다. `ensure`는 레지스트리, `settings/` 아래의
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

**교체 대신 멈추는 경우.** 그 밖의 교체 조건 가운데 하나라도 맞지 않으면 `ensure`는
기존 브리지를 멈추고(`SIGTERM`, 5초 뒤 `SIGKILL`) `settings/` 디렉터리 전체를
지웁니다. 등록된 브리지가 없는 경우, PID가 죽은 경우, 교체 기능이 없는 경우, 새
실행이 기존 브리지의 포트를 고정한 경우가 여기에 해당합니다. 아직 실행 중인 교체된
브리지의 세션이 필요로 하는 설정 파일도 함께 지워집니다. 포트를 고정한 실행은 그
포트를 쓰고 있는 교체된 브리지도 멈춥니다. 고정 포트로 브리지에 연결하는 LiteLLM에서
생기는 결과는 [브리지가 교체될 때](LITELLM_KO.md#브리지가-교체될-때)에 있습니다.

**확인되지 않은 PID.** `bridge.json`의 PID가 살아 있지만 `/health`가 등록된
`instanceId`를 보고하지 않으면, 런처는 `ps`로 그 PID의 명령줄을 읽습니다. 그것이
체크아웃(`bin/resolve-claude.sh`도 있는 디렉터리)의 `src/server.mjs`를 실행하는
`node`가 아니라면, 예를 들어 재부팅 뒤 PID가 재사용되었다면, 레지스트리는 오래된
것입니다. 실행이나 `claude-ghcp-stop`은 그 프로세스에 신호를 보내지 않고 레지스트리만
지웁니다. macOS에서는 그런 브리지이더라도 `ps -o lstart=`로 본 시작 시각이
레지스트리의 `createdAt`보다 5초 넘게 늦다면(`-p` 전용 브리지처럼 나중에 시작한
브리지가 PID를 재사용한 경우) 마찬가지이며, `retired/`의 기록에도 같은 규칙이
적용됩니다. Linux에서는 procps가 `lstart`를 부팅 시각으로부터 계산하고 그 부팅 시각은
시스템 시계가 한 번에 바뀔 때마다 움직이므로, 이 시작 시각 검사를 하지 않습니다. 그보다 늦지
않게 시작한 브리지이거나 Linux에서 그런 브리지라면 실행은 그 옆에 두 번째 브리지를
시작하지 않고
`Persistent bridge PID <pid> (port <port>) runs <checkout>/src/server.mjs but did not answer /health, so no second bridge was started beside it; kept <daemon dir>/bridge.json. Run claude-ghcp-stop, then launch again.`
오류로 실패합니다. 그다음 `claude-ghcp-stop`이 그 브리지를 멈춥니다(`SIGTERM`, 5초 뒤
`SIGKILL`). `ps`가 PID를 식별하지 못하면 오류가 수동 조치를 알려 줍니다.
`ps -p <pid> -o command=`로 확인해 체크아웃의 `src/server.mjs`이면 그 PID를 종료하고,
아니면 `bridge.json`을 지운 뒤 다시 실행하세요.

**상태 확인과 중지.** `claude-ghcp-status`는 브리지가 시작할 때의 모델을 보여 주며
토큰은 출력하지 않습니다. `claude-ghcp-stop`은 현재 브리지와 교체된 브리지를 모두
멈추고, 데몬 디렉터리의 `bridge.json`, `retired/`의 기록, `settings/`, `leases/`,
`bridge.log`를 지웁니다([브리지가 남기는 파일](#브리지가-남기는-파일)). 현재 브리지를
멈추지 못하면 `bridge.json`은 남기지만, 교체된 브리지를 멈추고 `settings/`, `leases/`,
`bridge.log`를 지운 뒤 오류를 알립니다. PID를 식별하지 못한 교체된 브리지의 기록은
남습니다. `COPILOT_HOME`의 SDK 세션 기록과 `claude-litellm` 설정 파일도 남습니다.

**작업 디렉터리.** 상주 브리지는 자신을 시작한 프로젝트가 아니라 데몬 디렉터리에서
실행됩니다. 그 프로젝트는 브리지가 실행되는 동안 지워질 수 있습니다. 또 프로젝트
디렉터리에서 실행하면 런타임 MCP 탐색이 다른 모든 프로젝트의 세션에 그 프로젝트의
작업 공간 설정을 읽어 들이게 됩니다.

## 로그

브리지 이벤트는 요청 결과, 세션 변경, 시간 초과를 기록합니다. 로그 위치와 보관 기간,
개인정보 주의 사항, 이벤트·필드 목록은 [진단 → 로그](DIAGNOSTICS_KO.md#로그)에 있습니다.

기본값으로 꺼진 `BRIDGE_VERIFY_OBSERVE=1`은 검증기에서만 켭니다
(`src/verification-observer.mjs`). 관측은 원시 요청 내용을 진단 이벤트에 복사하지 않고
요청·응답·세션 ID와 콘텐츠 다이제스트를 연결합니다. `bridge.verify_*` 이벤트와 `/health`에
더해지는 `timeouts`는 [이벤트 목록](DIAGNOSTICS_KO.md#이벤트-목록)에 있습니다.
모델·effort 검사는 최대 5초 안에 실제 SDK 모델 상태를 읽으며 요청한 설정만으로 적용을
증명하지 않습니다. 빠진 관측 데이터는 누락으로 남깁니다. native 대화 기록, settings와
합쳐진 오류 로그에는 여전히 민감한 내용이나 자격 증명이 들어갈 수 있습니다.

## 업스트림 오류

SSE 시작 전에는 해당 HTTP 상태와 JSON 오류를 반환합니다. 시작 뒤에는 HTTP 200을
유지하고 `event: error` 프레임에 실패를 담습니다. 모든 상태 변환과 재시도 대기 중
시간 초과는 [진단 → 업스트림 오류](DIAGNOSTICS_KO.md#업스트림-오류)를 보세요.

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

필수 실측 행렬은 주요 모델 6개 각각에 V01–V06을 실행합니다.
**모델 6개 × 시나리오 6개 = 슬롯 36개**입니다. 가장 최근에 기록된 결과와 그
버전·코드·범위는 [검증 결과](VERIFICATION_KO.md)를 보세요.
이 아키텍처 문서는 구현 동작과 필수 검사를 설명하며 통과 기록이 아닙니다.

### `npm test`가 확인하는 것

변환, 모델 매핑, 오류, 취소, 세션·서브에이전트 분리, 런타임 MCP 차단, 런처의
production 오프라인 회귀 테스트를 유지합니다. 합성 검증기 테스트는 슬롯 36개 전체,
근거·소스 무결성과 소유 프로세스 정리를 확인합니다. 실제 모델의 동작을 증명하지는
않습니다. [오프라인 검사](TESTING_KO.md#오프라인-검사와-dry-run)를 보세요.

### `npm run verify`가 실행하는 것

먼저 실제로 설치된 Claude Code를 제한 시간이 있는 로컬 모의 Messages API에 연결해
필수 CLI 기능과 격리를 확인하며 Copilot은 호출하지 않습니다. 쓸 수 없는 기능은 해당
슬롯을 blocked로 남깁니다. 이어서 하네스 재시도 없이 나머지 실측 행렬을 한 번 실행합니다.

- **V01:** print 완료, native 6개 모델 picker, 정확한 Unicode 응답과 `/clear` 격리.
- **V02:** 숨은 sample·소스·테스트 Read, 할인 계산 회귀 실패 확인, `discount.mjs`만
  Edit한 뒤 테스트 3개 통과 및 독립 재검사.
- **V03:** CLI 소유 로컬 MCP 오류, 숨은 값 조회와 같은 프로세스·세션에서 도구 없는 회상.
- **V04:** 같은 세션에서 문맥을 유지한 모델 전환, 지원 모델의 High effort를 실제 SDK
  상태로 확인, Haiku에는 effort 미적용.
- **V05:** 실제 스트리밍 중 Escape, 같은 요청의 클라이언트 취소와 SDK 중단 확인,
  이어서 같은 프로세스·세션에서 복구.
- **V06:** 수동 `/compact` 후 seed 프롬프트 없이 압축된 기록을 받은 새 SDK 세션의
  정확한 회상, 정상 종료와 비공개 브리지 정리, 이어서 새 CLI와 새 비공개 브리지에서
  정확한 저장 세션 ID로 재개.

native 조작에는 `python3`로 PATH에 있는 Python 3.9 이상의 표준 라이브러리 PTY와 설치된 `@xterm/headless`를 쓰며
브라우저를 쓰지 않습니다. 슬롯별 단계·native 대화 기록과 브리지 관측이 근거이며
터미널 표시 텍스트만으로 답을 증명하지 않습니다. 실행기는 격리된 비공개 브리지를
직접 시작합니다. Claude Code 설정은 production 작성기가 만들고 production 자격 증명
경로(토큰은 `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`는 비움)를 씁니다. production
런처나 공유·백그라운드 데몬 수명 주기는 검사하지 않습니다.
V06은 정상 종료 뒤의 콜드 대화 재전송을 검사하며 진행 중인 턴의 충돌 복구가 아닙니다.

36개 슬롯, 코드·사용자 설정 불변, 격리, 저장된 소스·근거 무결성과 소유 프로세스 정리가
모두 통과해야 합니다. 보고서는 저장된 v2 소스 스냅샷과 해시 명세로 원시 근거를 다시
검사하며 저장된 판정만 믿지 않습니다. 실패·차단·누락은 통과로 세지 않습니다.
[통과의 의미](TESTING_KO.md#통과의-의미)를 보세요.

### 명령과 플래그

준비 사항, 부작용 없는 dry-run, 36개 슬롯 전체 실측 명령, 슬롯별 예산, 산출물,
명시한 실행 디렉터리 하나로 두 언어 결과를 생성하는 방법은 [테스트](TESTING_KO.md)를
따르세요. 모델 동시성 기본값은 1이며 `--models`와 `--scenarios`는 특정 문제의 디버깅용
선택자입니다. `--scenario-concurrency` 옵션은 없습니다.

## 주요 파일

| 파일 | 역할 |
|---|---|
| `bin/claude`, `bin/claude-ghcp` | Direct 런처(`bin/claude`는 `claude-ghcp`를 실행). 상주 브리지와 print 모드 브리지 중 하나를 고르고, 실행 설정을 쓰고, Claude Code를 시작합니다 |
| `bin/claude-ghcp-status`, `bin/claude-ghcp-stop` | 상주 브리지 상태 확인과 중지 |
| `bin/claude-litellm` | LiteLLM 런처. 설정 파일을 씁니다([브리지가 남기는 파일](#브리지가-남기는-파일)) |
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
| `src/copilot-home.mjs`, `src/copilot-session-rpc.mjs`, `src/entry-point.mjs` | `COPILOT_HOME` 결정, SDK 도구 결과·중단·연결 해제·삭제 호출, 심볼릭 링크를 거친 진입점 감지 |
| `src/verification-observer.mjs` | `BRIDGE_VERIFY_OBSERVE=1`일 때만 쓰는 검증용 관측. 요청·응답 ID, 개수, 콘텐츠 다이제스트와 5초 제한으로 읽은 SDK 모델 상태 |
| `src/doctor.mjs`, `src/list-models.mjs`, `src/model-cli.mjs`, `src/provider-detection.mjs`, `src/settings-file-state.mjs`, `src/version.mjs` | 명령줄 도우미 |
| `scripts/verify/`, `test/` | 실측 검증 하네스와 `npm test` |

`bin/`의 모든 런처는 심볼릭 링크를 따라가 체크아웃을 찾으므로 `~/.local/bin`의 링크나
`npm link`로도 실행할 수 있습니다. 런처는 `PATH`에 `node_modules/.bin`을 넣지 않습니다.

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
