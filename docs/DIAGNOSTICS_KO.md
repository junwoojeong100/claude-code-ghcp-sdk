# 진단

> **언어 / Language:** [English](DIAGNOSTICS.md) | 한국어

브리지 실패의 근거를 찾고 로그를 읽는 안내입니다. 검사를 실행하는 방법은
[테스트](TESTING_KO.md), 요청과 세션 설계는 [아키텍처](ARCHITECTURE_KO.md)에 있습니다.

**이 문서에서:** [증상별 첫 조치](#증상별-첫-조치) · [근거 찾기](#근거-찾기) ·
[로그](#로그) · [업스트림 오류](#업스트림-오류) · [검증 산출물](#검증-산출물)

## 증상별 첫 조치

이 문서의 `./bin/`과 `npm run` 명령은 작업 중인 프로젝트가 아니라 **브리지
체크아웃**에서 실행하세요. 다른 프로젝트에서 Claude Code를 시작할 때는 그 프로젝트에
머무른 채 런처의 절대 경로를 호출하세요.

| 증상 | 먼저 할 일 |
|---|---|
| 실행 파일을 찾지 못함, 지원하지 않는 Node, 연결 전 실행 실패 | `./bin/ghcp-doctor`를 실행하고 [환경 점검](#환경-점검)을 확인하세요. |
| 모델 조회에서 인증 오류가 남 | 계정과 로그인 디렉터리를 확인하고 필요하면 `copilot login`을 실행하세요. [카탈로그와 모델 문제](#카탈로그와-모델-문제)를 참고하세요. |
| 모델 조회에서 의존성 누락이나 연결 오류가 남 | 오류가 가리키는 설치, PATH, 네트워크 또는 프록시 문제를 고치세요. 재로그인부터 할 필요는 없습니다. |
| 모델이 없거나 정책상 허용되지 않음, 새 목록에는 있는데 브리지가 거부함 | 아래에서 정확한 모델 ID, 계정 정책과 오래된 브리지 카탈로그 가능성을 확인하세요. |
| 요청이 실패하거나 스트리밍이 멎거나 응답이 정체됨 | [브리지 로그](#근거-찾기)를 보존한 뒤 [주요 필드 읽기](#주요-필드-읽기)에서 요청과 시간 초과 필드를 맞춰 보세요. SSE 요청은 HTTP 200만으로 성공을 판단할 수 없습니다. |
| 긴 대화가 `prompt is too long`으로 실패함 | 대화를 압축한 뒤 재시도하세요. `bridge.context_budget`과 `bridge.context_limit`을 확인하세요. 런타임 입력 한도는 화면의 컨텍스트 창보다 작을 수 있습니다. [컨텍스트 초과](ARCHITECTURE_KO.md#컨텍스트-초과)를 참고하세요. |
| 실측 검증이 실패함 | 공유 데몬 로그가 아니라 해당 실행의 [검증 산출물](#검증-산출물)을 여세요. 검증기 소유 브리지를 정리하려고 공유 데몬을 중지하지 마세요. |

### 환경 점검

```bash
./bin/ghcp-doctor
```

`npm run doctor`도 같은 검사입니다. JSON 보고서에서 `node`, `npm`, `claude`,
`copilot`이 모두 `"ok": true`이고 `compatibility.node.supported`가 `true`여야
통과합니다. 그렇지 않으면 종료 코드는 1입니다. 지원하는 Node 버전은 `^20.19.0` 또는
`>=22.12.0`입니다.

- 각 버전 조회의 제한 시간은 10초입니다. 응답하지 않는 실행 파일도 `false`로
  보고합니다. 실패한 실행 파일이나 버전 문제를 고친 뒤 다시 검사하세요.
- 래퍼가 Claude Code를 찾지 못하면 JSON 보고서 대신 `Claude Code executable not
  found…`를 먼저 출력합니다. Claude Code를 설치하거나 `CLAUDE_CODE_BIN`을 이 저장소의
  런처가 아닌 실제 실행 파일로 지정하세요.
- `curl`, Git, Copilot 로그인 상태나 모델의 응답 가능 여부는 검사하지 않습니다.
  통과는 환경 점검 결과이지 통합 검증 결과가 아닙니다.

`currentProvider`는 참고값이며 통과 조건이 아닙니다. 저장된 `~/.claude/settings.json`
하나와 그 파일의 `env` 객체를 읽으며 프로세스 환경 변수는 읽지 않습니다. 셸 변수,
프로젝트·관리형 설정, 실행별 라우팅 설정을 합쳐 판단하지 않으므로, 실행 중인 GHCP
세션의 **실제 제공자 경로를 나타내지 않습니다**.

### 카탈로그와 모델 문제

```bash
./bin/ghcp-models --json
```

Copilot에서 계정의 현재 카탈로그를 조회합니다. 목록 조회 성공은 카탈로그에 접근할 수
있다는 뜻이지, 모델이 프롬프트에 답할 수 있다는 확인이 아닙니다.

- **인증 오류:** 로그인할 때와 브리지에서 쓰는 계정·`COPILOT_HOME`이 맞는지
  확인하세요. 로그인을 바로잡아야 할 때 `copilot login`을 실행하세요.
- **설치·연결 오류:** 오류가 가리키는 실행 파일·의존성 누락, 네트워크 또는 프록시
  문제를 고치세요. 카탈로그 조회가 실패했다는 이유만으로 재로그인하지 마세요.
- **없거나 정책상 제한된 모델:** 계정·조직에서 허용한 사용 가능한 모델의 정확한 ID를
  고르세요. 재로그인으로 모델 접근 권한이 생기지는 않습니다.

새 목록에는 모델이 있는데 상주 브리지가 거부한다면, 브리지가 시작할 때 읽은 카탈로그를
아직 쓰고 있을 수 있습니다. `ghcp-models`는 실행 중인 브리지의 카탈로그를 갱신하지
않습니다. 먼저 양쪽의 계정과 `COPILOT_HOME`이 같은지 확인하세요. 이 변수에는 절대
경로나 `~/...`를 권장합니다([`.env.example`](../.env.example) 참고).

공유 브리지를 의도적으로 재시작하려면 **영향받는 모든 세션과 `/background` 작업을
끝내고 필요한 로그부터 보존하세요**. 중지 명령은 선택한 `GHCP_DAEMON_DIR`의 현재
브리지와 교체된 브리지를 멈추고, `bridge.log`와 해당 브리지들의 실행별 설정 파일을
지웁니다. 아직 사용 중인 세션이나 작업은 동작하지 않게 됩니다. `claude-litellm`의 설정은
지우지 않습니다. 자세한 보관 정책은 [브리지가 남기는 파일](ARCHITECTURE_KO.md#브리지가-남기는-파일)에 있습니다.

```bash
./bin/claude-ghcp-stop
```

그런 다음 작업 프로젝트에서 런처의 절대 경로로 다시 실행하면 새 브리지가 카탈로그를
읽습니다. 검증기 정리에 쓰는 절차가 아닙니다. 바뀐 `/model` 목록을 불러오려고 Claude
Code를 재시작하는 것은 별개입니다. CLI의 실행 설정은 다시 읽지만, 오래된 SDK
카탈로그를 가진 브리지를 그대로 쓸 수 있습니다.

## 근거 찾기

| 실패한 곳 | 먼저 볼 파일 | 남는 것 |
|---|---|---|
| 상주 Direct 브리지 | `<데몬 디렉터리>/bridge.log` | 실행과 교체 때마다 이어 씁니다. 현재 브리지와 교체된 브리지가 같은 파일에 쓸 수 있습니다. 실행이 브리지에 닿지 못하면 런처가 마지막 120줄을 출력합니다. `claude-ghcp-stop`이 지웁니다. 자동 로그 순환은 없습니다. |
| Direct print 모드(`-p` / `--print`) | `$TMPDIR/claude-ghcp.XXXXXX/bridge.log` | 런처가 끝나면 임시 디렉터리를 지웁니다. 로그를 남기려면 실행 중에 다른 셸에서 `tail -f "${TMPDIR:-/tmp}"/claude-ghcp.*/bridge.log > print-bridge.log`를 실행하세요. 시작 실패 때 일부가 출력될 수 있습니다. |
| V01–V06 실측 검증 | `<실행 디렉터리>/slots/<model>__Vxx/bridge.log`, 단계별 대화 기록과 native 세션·터미널 로그 | 실행기가 비공개 Direct 브리지를 직접 시작하며 production 런처나 공유 데몬을 쓰지 않습니다. V06의 교체 브리지는 같은 슬롯 디렉터리의 `bridge-2.log`에 씁니다. 통과한 작업 공간을 지워도 실행 산출물은 남습니다. |
| LiteLLM 경로 | LiteLLM 출력과 브리지 로그 | [LiteLLM 문제 해결](LITELLM_KO.md#문제-해결)로 두 구간을 구분하세요. |

데몬 디렉터리는 `GHCP_DAEMON_DIR`입니다. 설정하지 않으면 macOS에서는
`~/Library/Caches/claude-code-ghcp-sdk`, 그 밖의 시스템에서는
`${XDG_CACHE_HOME:-~/.cache}/claude-code-ghcp-sdk`입니다. 상주 브리지 로그는 권한
`0600`으로 만듭니다. 다른 저장 파일과 보관 기간은
[브리지가 남기는 파일](ARCHITECTURE_KO.md#브리지가-남기는-파일)에 있습니다.

## 로그

브리지 이벤트는 한 줄에 JSON 객체 하나입니다. `bridge.started`, `bridge.retired`,
`bridge.retired_exit`는 stdout으로, 아래의 나머지 이벤트는 stderr로 갑니다.
`LOG_LEVEL`은 Copilot 런타임의 로그 수준만 바꾸며 브리지 이벤트에는 영향을 주지
않습니다. 런처와 하네스는 브리지 stdout과 stderr를 로그 하나로 합칩니다.

**합쳐진 로그를 공유하기 전에 검토하세요.** 요청·턴 요약은 운영 필드만 담고 요청
본문, 프롬프트, 도구 인수, 도구 결과, 첨부 파일, 자격 증명을 넣지 않습니다.
하지만 로그 전체에 이 보장이 적용되지는 않습니다.

- 서버의 바깥쪽 오류 처리기에 도달한 실패는 클라이언트 중단을 제외하고
  `[<requestId>] <ErrorName>: <message>` 줄도 씁니다. 메시지에는 모델·도구 이름이나
  민감한 내용을 거르지 않은 업스트림 오류 텍스트가 들어갈 수 있습니다. 초기 401과
  본문 검증 실패에는 이 줄을 쓰지 않습니다.
- `bridge.mcp_discovery_failed.message`에는 탐색 오류를 최대 200자까지 넣습니다.
  길이를 줄이는 것은 민감한 내용을 지우는 것과 다릅니다.
- 검증 대화 기록, config와 settings는 별도 산출물입니다. 대화·도구 내용이나 토큰이
  들어갈 수 있으며, 내용이 없는 진단 로그가 아닙니다. 공유 전에 보관된 모든 파일을
  검토하세요.

`npm test`는 진단 이벤트와 필드 이름을 검사합니다. 이를 인터페이스로 다루세요.

### 주요 필드 읽기

- **실패한 요청:** `bridge.request_failed`와 일반 오류 줄의 `requestId`를 맞춰
  보세요. `status`는 변환한 실패 상태이며 [업스트림 오류](#업스트림-오류)에서 찾을
  수 있습니다. `headersSent: true`이면 SSE 응답의 HTTP 상태는 이미 200이므로 오류
  프레임을 확인해야 합니다.
- **멈춘 턴:** `bridge.turn_timeout`은 유휴 시간 초과 `timeout`과 전체 상한
  `duration_limit`를 구분합니다. 로컬 대기인지 업스트림 대기인지 판단하기 전에
  `stage`, 대기 중인 RPC·등록 수, `upstreamRetryStatus`를 확인하세요.
  `upstreamRetryStatus`가 429나 5xx이면 요청은 429나 529로 실패했고 Claude Code가
  다시 시도합니다. `stage`가 `model`이고 모델이 정상적으로 오래 조용히 작업하거나
  오래 걸린다면 `TURN_IDLE_TIMEOUT_MS`나 `TURN_MAX_DURATION_MS`를 늘리세요
  ([`.env.example`](../.env.example)).
- **도구·세션 대기:** 선언한 도구의 `bridge.unregistered_tool_call`이나 `reason`이
  `timeout`인 `bridge.session_operation_failed`가 느린 런타임에서 반복되면
  `PENDING_TOOL_WAIT_MS`나 `SESSION_OPERATION_TIMEOUT_MS`를 늘리세요.
- **모델 확인:** `requestedModel`은 Claude Code가 보낸 값, `model`은 정해진 대상,
  `servedModels`는 SDK 사용량 이벤트가 보고한 모델 이름입니다. 빈 목록은 알 수
  없다는 뜻이지, 대상 모델이 응답했다는 확인이 아닙니다.
- **중단한 턴:** `bridge.turn_abort_completed.acknowledged`는 Copilot이 중단을
  확인했는지 나타냅니다. 원래 턴이 성공했다는 뜻은 아닙니다.

### 이벤트 목록

| 이벤트 | 기록 시점 | 필드 |
|---|---|---|
| `bridge.started` | 서버가 연결을 받기 시작할 때 | `address`, `preferredModel`, `models`(개수) |
| `bridge.request_failed` | `/v1/messages` 요청이 실패할 때. 401, 400 본문 오류, 499를 포함한 그 뒤의 모든 실패 | `requestId`, `status`, `errorType`, `retryAfterSeconds`, `streaming`(검증된 요청이 SSE를 원했는지. 초기 인증·본문 실패에는 false), `headersSent`(응답이 이미 시작됐는지) |
| `bridge.turn_completed` | `/v1/messages` 응답을 보낸 뒤 | `requestId`, `responseId`, `requestedModel`, `model`, `servedModels`, `claudeAgent`(`root` 또는 `subagent`), `inputTokens`, `outputTokens`, `usageReported`, `stopReason`, `toolUses` |
| `bridge.degraded_controls` | 요청에 SDK가 적용할 수 없는 샘플링 제어 값이나, 받지만 무시하는 필드가 있을 때 | `controls`, `ignoredFields`(있을 때만), `semantics` |
| `bridge.mcp_servers_disabled` | 시작할 때 `mcp.discover`를 호출한 뒤 | `count`(`github-mcp-server` 포함) |
| `bridge.mcp_discovery_failed` | MCP 탐색이 실패하거나 10초를 넘겼을 때 | `error`, `message`(최대 200자) |
| `bridge.context_budget` | 세션이 새 런타임 입력 한도를 보고할 때 | `model`, `contextTier`, `tokenLimit`, `currentTokens`(알 때만) |
| `bridge.context_limit` | Copilot이 세션 기록을 줄였을 때 | `model`, `phase`(`between_requests` 또는 `active_turn`), `tokenLimit`(알 때만). `active_turn`이면 턴 보고 필드가 더해집니다 |
| `bridge.history_reconciled` | 대화가 캐시한 상태를 더 이상 이어 가지 않거나(`history_diverged`), 같은 묶음의 다른 상태가 그사이 이 대화를 이어 갔거나, 이 상태의 마지막 요청 뒤 같은 묶음의 다른 상태가 16개 넘게 실행되어 브리지가 그 상태들의 요청 가운데 하나를 잊었을 때(`identity_stale`) | `currentMessages`, `previousMessages`, `reason`(`history_diverged` 또는 `identity_stale`) |
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
| `bridge.retired` | 브리지가 `SIGUSR2`를 받아 교체되었을 때 | `retired`, `inFlight`, `idleMs`, `leases`(살아 있는 점유 파일 수) |
| `bridge.retired_exit` | 교체된 브리지가 종료할 때 | `retired`, `inFlight`, `idleMs`, `leases`(살아 있는 점유 파일 수) |
| `bridge.shutdown_forced` | `SIGTERM`이나 `SIGINT`를 받은 뒤, 또는 교체된 브리지가 `bridge.retired_exit` 뒤 스스로 종료할 때의 종료가 제한 시간(기본 50초, [세션 분리](ARCHITECTURE_KO.md#세션-분리)의 **종료** 참고) 안에 끝나지 않았을 때. 브리지는 이어서 상태 1로 종료합니다 | `deadlineMs` |
| `bridge.diagnostic_error` | 턴 진단 로그를 쓰지 못했을 때. 요청 자체에는 영향이 없습니다 | `diagnosticEvent`, `requestId`, `responseId` |

턴 보고 필드는 `timestamp`, `requestId`, `responseId`, `state`(해시), `model`,
`elapsedMs`, `turnElapsedMs`, `idleMs`, `stage`(`send`, `tool_result`,
`tool_registration`, `trigger`, `model` 중 하나), `triggerFinished`, `turnStarted`,
`completionStarted`, `deferredCompletion`, `upstreamRetryStatus`, `messages`,
`toolRequests`, `usageEvents`, `pendingToolCalls`, `pendingRegistrations`,
`rpc`(전송과 도구 결과 각각의 시작·확인·실패 횟수), `eventCounts`,
`recentEvents`(최대 8개, 각각 유형·범위·경과 시간 포함)입니다.

**검증 전용.** `BRIDGE_VERIFY_OBSERVE=1`로 시작한 브리지는 다음 이벤트도 stderr에
씁니다. 런처는 이 값을 설정하지 않지만, export해 두면 런처가 시작한 브리지가 물려받습니다.

| 이벤트 | 기록 시점 | 필드 |
|---|---|---|
| `bridge.verify_request` | `/v1/messages` 요청이 본문 검사를 통과한 뒤, 턴을 실행하기 전 | `requestId`, `responseId`, `requestedModel`, `claudeSessionId`, `claudeAgent`(`root` 또는 `subagent`), `streaming`, `compactRequested`, `effort`, `messageCount`, `messagesSha256`, `userTextHashes`, `messageDigests`(메시지마다 `role`, `sha256`, `textHashes`), `toolResultIds`, `toolUseIds` |
| `bridge.verify_model_state` | 턴마다 effort 수준을 적용한 뒤, 턴을 보내기 전 | `requestId`, `responseId`, `sessionId`(SDK 세션), `model`, `requestedEffort`, `appliedEffort`, `requestedContextTier`, `ok`, `current`(SDK가 보고한 `modelId`, `reasoningEffort`, `contextTier`, 또는 null), `ok`가 false일 때 `error`(`timeout`, `aborted`, `unavailable`, `invalid_response`, `rpc_error` 중 하나) |
| `bridge.verify_progress` | 스트리밍 응답에서 비어 있지 않은 첫 루트 텍스트 증분이 왔을 때 | `requestId`, `responseId`, `kind` |
| `bridge.verify_response` | 결과와 관계없이 `POST /v1/messages` 응답이 끝나거나 연결이 닫혔을 때 | `requestId`, `responseId`, `status`(상태를 보내지 못했으면 null), `streaming`, `finished`, `aborted` |

같은 설정에서 `bridge.turn_completed`에는 `compactSummarySha256`이 더해집니다. Claude
Code가 `/compact` 요약을 저장할 때처럼 정규화한 응답 텍스트의 SHA-256이며, 응답 텍스트가
없으면 null입니다. `GET /health`에는 `timeouts`(`turnTimeoutMs`, `maxTurnDurationMs`,
`sessionOperationTimeoutMs`, `pendingToolWaitMs`, `abortTimeoutMs`, `cleanupTimeoutMs`,
`stateIdleTtlMs`, `mcpDiscoveryTimeoutMs`)가 더해집니다. 실행기는 이 값을 자신이 기록한
예산과 비교합니다.

`GET /health`는 SDK가 적용할 수 없는 샘플링 제어 값을
`capabilities.unsupportedNativeControls`로, 받지만 무시하는 필드를
`capabilities.ignoredRequestFields`로 보여 줍니다. 두 목록은
`src/request-policy.mjs`에서 오며,
[적용하지 않는 요청 값](COMPATIBILITY_KO.md#적용하지-않는-요청-값)에서 설명합니다.

## 업스트림 오류

요청 실패를 HTTP 상태와 오류 유형으로 바꾸는 규칙입니다(`src/server.mjs`의
`errorResponse`, `src/upstream-errors.mjs`의 `sessionError`). SSE 시작 전에는 해당
상태와 JSON 오류를 반환합니다. 시작 뒤에는 HTTP 200을 유지합니다. 아래의 스트리밍
규칙을 참고하세요.

| 조건 | 상태 | 오류 유형 |
|---|---|---|
| `GET /health`와 `HEAD /api/hello`를 뺀 경로에서 토큰이 없거나 틀림 | 401 | `authentication_error` |
| 인증된 요청이 알 수 없는 메서드나 경로를 요청함 | 404 | `not_found_error` |
| 본문이 `MAX_BODY_BYTES`보다 크거나, JSON이 잘못됐거나, 형식이 맞지 않음. 413은 쓰지 않습니다 | 400 | `invalid_request_error` |
| 도구 없이 `tool_choice`가 `any`임, 선언되지 않은 도구를 지정함, 지원하지 않는 모드 | 400 | `invalid_request_error` |
| 계정의 Copilot 카탈로그에 없는 모델 | 400 | `invalid_request_error` |
| 수준을 나열하는 모델에 알려진 수준이 아닌 effort 값 | 400 | `invalid_request_error` |
| Copilot이 세션 기록을 줄이기 시작함([컨텍스트 초과](ARCHITECTURE_KO.md#컨텍스트-초과)의 `prompt is too long` 오류) | 400 | `invalid_request_error` |
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
`bridge.turn_timeout`은 그 상태를 `upstreamRetryStatus`로 기록합니다. 이 변환에는
production 오프라인 회귀 테스트가 있습니다. V01–V06 실측 행렬은 업스트림 오류를
주입하지 않습니다.

**테스트용 오류 주입.** `BRIDGE_TEST_FAULTS`는 테스트 훅이며 기능이 아닙니다. 예를
들어 `BRIDGE_TEST_FAULTS="rate_limit:1,overloaded:1"`은 도구를 선언한 요청을 적힌
순서대로 그 수만큼, Copilot에 닿기 전에 실패시킵니다. 종류는 세 가지입니다.
`rate_limit`와 `overloaded`는 실제 업스트림 실패와 같은 변환을 거칩니다.
`context_limit`는 브리지 자체의 `prompt is too long` 오류를 일으킵니다. 실측 검증에서는
이 값을 설정하지 마세요. V01–V06 행렬은 이 변환을 검증하지 않습니다.

## 검증 산출물

검증 실패라면 `<실행 디렉터리>`는 실행기가 출력한 `artifacts:`와 `report:` 줄의
디렉터리입니다(`--out`을 주지 않았으면 `.verify-runs/<타임스탬프>/`). 보고서에는 그
정확한 디렉터리를 명시하고 가장 최근 실행을 임의로 고르지 마세요. 먼저 `summary.json`의
사전 점검, 실행 전체 무결성과 정리 문제를 확인하세요. 사전 점검은 설치된 Claude Code를
제한 시간이 있는 로컬 모의 Messages API에 연결하며 Copilot은 호출하지 않습니다.
쓸 수 없는 기능은 해당 슬롯을 blocked로 남기며 모델 실패를 증명하는 것은 아닙니다.

검증기가 비공개 브리지를 소유하고 정리 결과를 기록합니다. 여기에 `claude-ghcp-stop`을
쓰지 마세요. 검증기 소유 프로세스가 아니라 공유 데몬을 중지하는 명령입니다.

`slots.jsonl`에서 모델·시나리오 슬롯의 `reason`, 실패한 `checks`, `evidence.phases`를
찾은 뒤 기록된 경로를 따라가세요.

- print 단계는 `slots/<model>__Vxx/`에 `transcript-<phase>.jsonl`을 씁니다.
- native 실행은 원시 PTY 출력인 `terminal-<launchId>.log`와 입출력 기록인
  `terminal-events-<launchId>.jsonl`(종류, 목적, 순번, 바이트 수. 입력 바이트는 넣지
  않음)을 씁니다. Escape 중단 행(V05와 사전 점검의 중단 확인)에는 렌더링된 화면
  텍스트도 들어가며, 여기에는 입력한 프롬프트와 받은 만큼의 응답이 보입니다. native
  대화 기록에 중단이 기록됐다면 `cwd`와 세션 ID가 든 그 기록도 들어가므로, 공유하기
  전에 이 파일도 원시 로그처럼 검토하세요. 답의 근거는 터미널 표시 텍스트가 아니라
  기록된 `transcriptPath`의 native 세션 대화 기록입니다.
- 검증기가 쓰는 160×48 터미널에서 실행한 native 실행은 출력 전용 녹화인
  `terminal-output-<launchId>.jsonl`(스키마 `ghcp-terminal-output` v1)도 씁니다. 출력
  프레임은 원시 로그와 바이트 단위로 같고, 드라이버가 `seed`, `recall` 같은 단계 표시를
  더합니다. 입력 스트림(키 입력), 인수, 설정 파일, 환경 변수는 담지 않지만, 출력
  프레임은 터미널에 표시된 화면 그대로이므로 TUI가 다시 보여 주는 입력한 프롬프트와 모델
  응답이 모두 들어 있습니다. 공유하기 전에 원시 로그처럼 검토하세요. 마지막 줄은
  녹화가 완전했는지, 불완전했는지, 잘렸는지(8 MiB 또는 50,000프레임에서)를 나타냅니다.
  녹화 오류로 마지막 줄을 쓰기 전에 녹화가 멈추면 그 파일에는 마지막 줄이 없고 렌더러가
  받지 않습니다. 마지막 줄은 녹화 상태일 뿐이며, 녹화는 답의 근거가 아니고 판정에 영향을
  주지 않습니다. 다른 터미널 크기의 실행은 녹화하지 않습니다.
- `cleanup-<pid>.json`은 native 프로세스 정리 결과를 남깁니다. 종료 코드, 시그널, 강제
  종료나 `SIGKILL` 승격 여부, 아직 살아 있는 소유 PID(`remainingPids`)가 들어갑니다. PTY
  도우미는 하위 프로세스를 PID와 `ps` 시작 시각으로 추적하며 시작 시각이 바뀐 PID에는
  신호를 보내지 않습니다. 하위 프로세스는 약 0.25초마다 `ps` 표본을 떠서 찾으므로, 표본
  사이에 새 세션으로 분리되고 부모를 잃은 프로세스는 관측하지 못하며 그 프로세스가 아직
  실행 중이어도 `ok`가 true일 수 있습니다. 신호를 보낼 권한이 없었던 PID는
  `signalDeniedPids`에 남기며, 그 PID가 아직 살아 있으면 `ok`는 false입니다.
- 단계의 응답 ID를 `bridge.log`와 연결하세요. V06은 CLI 정상 종료와 첫 비공개 브리지
  정리 뒤 `bridge-2.log`도 사용합니다.
- `sources/files/`의 저장된 v2 소스 사본, `sources/manifest.json`,
  `artifact-manifest.json`으로 소스·해시 검증과 원시 근거 재검사를 지원합니다.
  저장된 `pass` 표시만으로는 충분하지 않습니다.

실패 요약은 내용을 줄여 보여 줄 수 있으므로 자세한 내용은 원래 슬롯 행과 파일에서
확인하세요. 전체 통과에는 36개 슬롯과 무결성·격리·정리 검사가 모두 필요합니다.
판정 기준과 작업 공간 보관 방식은 [테스트](TESTING_KO.md#결과-읽기와-문서-생성)에서
설명하고, 가장 최근에 기록된 결과는 [검증 결과](VERIFICATION_KO.md)에 있습니다.

### 검증 근거 연결

V01–V06의 완료 응답에서 검증기는 루트 assistant `message.id`를
`bridge.turn_completed.responseId`와 연결합니다. 요청·해석 모델, SDK 보고
`servedModels`의 모든 항목, 사용량 보고와 중지 사유가 해당 단계·응답과 맞아야 합니다.
V04의 source 단계는 의도적으로 다른 모델을 쓰며, V05의 중단 단계에는 성공 완료 대신
취소·중단 근거가 필요합니다. 무관한 부수 요청은 빠진 근거를 대신하지 못합니다.
SDK 보고 모델 ID를 확인하는 것이지 제공자 내부 구현의 증명은 아니며, 근거가 빠지면
통과할 수 없습니다.

검증기는 기본값으로 꺼진 **`BRIDGE_VERIFY_OBSERVE=1`**을 켭니다. 요청·응답 관측은
원시 프롬프트, 도구 내용, 헤더나 자격 증명 대신 ID, 개수와 콘텐츠 다이제스트를 쓰며,
이벤트는 [이벤트 목록](#이벤트-목록)에 있습니다. V06은 이 관측으로 압축 뒤 넘겨주기를
검사합니다. 압축 뒤 회상 단계의 모든 `bridge.verify_model_state.sessionId`는 seed와
compact 요청의 것과 달라야 하고, 회상 단계의 어떤 `bridge.verify_request`도
`userTextHashes`에 seed 프롬프트의 다이제스트를 담으면 안 됩니다.
모델·effort 관측은 최대 5초 안에 SDK `session.rpc.model.getCurrent()`를 호출합니다.
`current`는 요청 설정의 복사본이 아니라 실제 SDK 보고 상태입니다. 쓸 수 없거나 형식이
잘못됐거나 시간 초과한 읽기는 근거 누락으로 남깁니다. 관측 실패가 모델 응답을 다른
응답으로 바꾸지는 않습니다. 이 제한된 로그 정책은 native 대화 기록, settings나 합친
로그의 다른 항목을 가리지 않으므로 공유 전에 검토하세요.
