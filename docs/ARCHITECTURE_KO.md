# 아키텍처

> **언어 / Language:** [English](ARCHITECTURE.md) | 한국어

이 문서는 maintainer를 위한 구현·검증 설명입니다. 설치와 실행은
[README](../README_KO.md), LiteLLM 운영은 [LiteLLM 가이드](LITELLM_KO.md)를 따릅니다.

핵심 원칙은 하나입니다. Claude Code가 UI, 세션, 도구 실행을 담당하고 이 저장소는
모델 backend 연결만 바꿉니다.

## 시스템 구성

### Direct GitHub Copilot SDK

```text
Claude Code
  -> loopback Anthropic Messages bridge
  -> @github/copilot-sdk mode="empty"
  -> GitHub Copilot model
```

`claude`와 `claude-ghcp`가 사용합니다. `copilot login` 계정과 조직의 모델 정책을
그대로 따릅니다.

### LiteLLM

```text
Claude Code
  -> LiteLLM /v1/messages
  -> loopback Anthropic Messages bridge
  -> @github/copilot-sdk mode="empty"
  -> GitHub Copilot model
```

`claude-litellm`이 사용합니다. LiteLLM은 같은 로컬 bridge 앞에 놓이는 proxy이며,
`anthropic/*` provider로 연결하고 `api_base`는 bridge root를 가리킵니다. LiteLLM은
`anthropic/` prefix를 제거한 나머지를 요청 body의 model로 보내고, 구성한 `api_key`는
`x-api-key` header로 전달됩니다. LiteLLM 자체 `github_copilot/` provider와 별도
GitHub device OAuth는 사용하지 않습니다.

hop이 하나 늘면서 Direct 경로의 두 동작은 유지되지 않습니다. `/v1/models`는 bridge의
discovery row가 아니라 LiteLLM 자체 alias를 반환하고, `POST /v1/messages/count_tokens`는
bridge에 도달하지 않고 LiteLLM의 자체 추정값으로 응답합니다. bridge는
`ALLOW_NON_LOOPBACK=1`을 설정하지 않는 한 loopback에만 bind하므로 LiteLLM은 같은
호스트에서 실행합니다. 이 경로는 [검증 범위](#검증-범위) 밖입니다.

## 통합 가능 근거와 경계

이 저장소가 사용하는 Claude Code의 공식 연결점은 model SDK provider plugin이 아니라
`ANTHROPIC_BASE_URL`이 가리키는 gateway의 Anthropic Messages API 형식입니다. 반면
Copilot SDK는 HTTP Anthropic API를 제공하지 않고 Copilot CLI server와 JSON-RPC로
통신합니다.

따라서 이 통합은 다음 두 public contract 사이의 adapter입니다.

| 경계 | 이 저장소의 처리 |
|---|---|
| Claude Code → gateway | `/v1/messages`, SSE, token counting, model discovery의 필요한 subset 구현 |
| Bridge → Copilot | `@github/copilot-sdk` session, streaming event와 pending external-tool RPC 사용 |
| Tool execution | Copilot 도구를 declaration-only로 등록하고 실제 실행은 Claude Code에 반환 |

Claude Code 공식 문서는 지원 API 형식을 구현한 third-party gateway 연결을 허용하지만,
Anthropic이 gateway를 통한 non-Claude model routing을 지원하지는 않는다고 명시합니다.
정식 Copilot SDK는 Copilot runtime을 programmatic하게 노출하지만,
Claude Code integration을 제공하지는 않습니다. 이 저장소가 pin한
`@github/copilot-sdk@1.0.14`와 전체 조합은 별도의 비공식 compatibility
layer입니다.

SDK 1.0.14는 별도 `@github/copilot` CLI package에 의존하는 대신 플랫폼별
`@github/copilot-sdk-*` package로 runtime 1.0.85를 포함합니다. `CopilotClient`는
`COPILOT_CLI_PATH`로 다른 설치본을 명시하지 않으면 이 내장 runtime을 사용합니다.
따라서 전역 CLI 버전과 bridge 요청을 처리하는 runtime 버전은 다를 수 있습니다.

## 역할 분리

Claude Code가 담당하는 기능:

- Terminal UI와 conversation
- Permissions
- Hooks, plugins, skills, MCP
- 로컬 파일, shell, edit 등의 tool 실행
- User-facing session lifecycle

Direct 경로의 GitHub Copilot SDK와 bridge는 모델 backend 연결만 담당합니다.

## Direct SDK 요청 흐름

1. Claude Code가 `/v1/messages`에 system prompt, conversation, tool schema를 전송합니다.
2. Bridge가 Claude Code 모델 ID를 Copilot 모델 ID로 변환합니다.
3. `output_config.effort`를 모델의 `supportedReasoningEfforts`와 대조합니다.
4. Copilot SDK session을 `mode: "empty"`와 선택된 `reasoningEffort`로 생성합니다.
5. Claude Code system prompt와 tool declaration을 SDK session에 등록합니다.
6. Copilot 모델의 tool 요청을 Anthropic `tool_use` block으로 반환합니다.
7. Claude Code가 tool을 실행하고 `tool_result`를 다음 요청에 보냅니다.
8. Bridge가 `handlePendingToolCall`로 결과를 SDK session에 전달합니다.
9. 최종 응답을 Anthropic Messages 형식으로 Claude Code에 반환합니다.

## 세션과 모델 매핑

### 세션 분리

Bridge는 다음 Claude Code header로 root session과 subagent를 분리합니다.

- `x-claude-code-session-id`
- `x-claude-code-agent-id`

대화 history 비교에서는 이동하는 `cache_control` 전송 metadata와 inline
`system` 항목을 대화 turn으로 취급하지 않습니다. 대신 native custom agent 정의,
output style 등 의미 있는 inline system 내용은 SDK system message에 합칩니다.
해당 inline context에서 요청별 token-budget annotation만 정규화하며, 실제
user/assistant 내용·tool input·system 지시 변경은 기존 reconciliation/state split을
유지합니다.

Cold replay는 tool-use ID, tool-result 오류 여부와 native `tool_reference` 이름을
보존합니다. 진행 중인 ToolSearch 결과도 SDK tool-result text에 참조 이름을 남겨
발견한 도구의 식별자가 유실되지 않도록 합니다.

Copilot SDK session ID는 bridge-instance namespace와 Claude session, agent, resolved
model, tool schema signature, system prompt signature로 결정됩니다. Persistent
daemon은 같은 bridge process 안에서 evicted session을 resume할 수 있습니다. Process
재시작 후에는 과거 provider state를 재사용하지 않고 bounded cold history replay를
수행해 cross-run conversation leakage를 방지합니다.

SDK session 생성·재개와 `setModel()`에는 추론 timeout과 별도로
`SESSION_OPERATION_TIMEOUT_MS`(기본 60초)를 적용합니다. 호출 취소와 shutdown도
이 대기를 중단하며, 큐에서 취소된 요청 때문에 후속 요청이 실행 중인 턴을
추월하지 않습니다. 준비 실패 시 세션 generation을 바꾸고 늦게 도착한 응답은
캐시에 설치하지 않고 정리합니다. Persistent daemon의 설정 지문에도 이 제한이
포함됩니다.

모델 턴의 idle 대기와 전체 시간 상한은 별개입니다. Root의 실제 텍스트·추론·
도구 입력 delta는 idle timer를 갱신하지만, 빈 delta나 subagent 이벤트는
갱신하지 않습니다. 계속 출력하는 턴에도 전체 시간 상한은 유지하며, 두 값 모두
daemon 설정 지문에 포함됩니다.

### 모델 ID 변환

Claude Code와 Copilot 모델 ID의 version separator 차이를 변환합니다.

| Claude Code frontend | GitHub Copilot |
|---|---|
| `claude-sonnet-5` | `claude-sonnet-5` |
| `claude-sonnet-4-6` | `claude-sonnet-4.6` |
| `claude-opus-4-8` | `claude-opus-4.8` |
| `claude-haiku-4-5` | `claude-haiku-4.5` |
| `gpt-5.6-sol` | `gpt-5.6-sol` |
| `gpt-5.6-terra` | `gpt-5.6-terra` |
| `gpt-5.6-luna` | `gpt-5.6-luna` |
| `gpt-6-astra` | `gpt-6-astra` |

`sonnet`, `opus`, `haiku` alias는 현재 계정에서 허용된 family 모델로 해석합니다.
GPT-5.6 모델과 GPT-6 Astra는 full ID를 사용합니다.

### 모델 discovery와 context

Runtime과 검증 catalog는 같은 `PRIMARY_MODELS`를 사용합니다. Direct 실행 설정의
`modelPicker.replaceBuiltInOptions`로 주요 7개 모델을 정해진 순서대로 표시하며,
Claude Code의 `Default` 별칭은 남습니다. Bridge 응답만 보고 추정하지 않고
설치된 CLI의 native `supportedModels()` control 요청으로 실제 목록을 확인했습니다.

호환 client를 위한 gateway discovery는 유지하되 `/v1/models`에는 주요 모델 중
built-in과 중복되지 않는 항목만 backend ID 기준으로 중복 제거해 반환합니다.
`/v1/models?all=true`와 `ghcp-models`의 더 넓은 backend catalog는 유지하며,
명시적인 모델 선택은 해당 모델이 사용 불가능할 때 실패합니다.
LiteLLM은 독립적으로 설정한 gateway alias를 유지합니다.

네 GPT 모델은 launch와 picker 모두
`github-copilot/claude-<copilot-model-id>[1m]`을 사용하고, bridge가 prefix/suffix를
제거해 모델을 해석합니다. Claude Code frontend 예산은 1M으로, SDK catalog의
GPT-5.6 1,050,000·Astra 1,178,000 한도 안에 둡니다. 임시 settings는 시작 모델의
한도를 전역에 고정하는 대신 상속된 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`를 비웁니다.
Claude 모델은 native 한도를 사용하며 Haiku로 바꾸면 200K로 돌아갑니다.
Native 자동 압축과 사용자가 지정한 더 작은 window도 유지됩니다.

주요 GPT 네 모델의 SDK 세션은 생성·재개·effort 변경 시
`contextTier: "long_context"`를 명시하고, 조회한 catalog의 숫자
context/prompt/output 한도만 전달합니다. Catalog에 큰 window가 표시되는 것만으로
runtime의 tier가 선택되지는 않습니다. 실제 Astra 입력 예산은 기본 272K였고,
long tier와 catalog 한도를 함께 적용하자 1.05M이었습니다.
`bridge.context_budget`으로 유효한 SDK 예산을 기록합니다.

SDK는 `infiniteSessions.enabled`가 false여도 자체 압축을 수행할 수 있습니다.
턴 도중과 요청 사이의 root 압축·잘라내기를 추적해 축소된 backend 문맥을 조용히
재사용하지 않습니다. 해당 상태를 폐기하고 `prompt is too long` invalid-request
오류를 반환합니다. 모델 출력·추론이 시작되기 전에는 HTTP 스트리밍 header를
확정하지 않아, 초기 오류가 HTTP 400으로 전달되고 Claude Code의 native 압축
복구가 작동하게 합니다. 스트리밍이 시작되면 쉬는 동안에도 keepalive를 유지합니다.
추론 진행 이벤트로 스트림을 열더라도 추론 텍스트 자체를 노출하지는 않습니다.

Copilot의 input total에는 캐시 토큰이 포함되지만 Anthropic의 세 입력 범주는
서로 겹치지 않습니다. 따라서 uncached input은
`max(0, inputTokens - cacheReadTokens - cacheWriteTokens)`로 변환하고 원래 캐시
카운터를 함께 전달합니다. 캐시를 사용한 230K 요청이 Claude Code에서 약 460K로
보이는 문제를 막습니다. 명시적 0은 유지하며 usage 누락에만 기존 추정치를
사용합니다. SDK usage 이벤트 중 입력/출력 카운터가 하나라도 누락되면 해당 합계도
알 수 없는 값으로 유지하며 실측 0으로 바꾸지 않습니다. 이는 집계 수정이지
prompt-cache 제어 전체의 동등성을 뜻하지 않습니다.

### Reasoning effort

`/effort`와 `--effort`는 Anthropic Messages의 `output_config.effort`로 전달됩니다.
Bridge는 모델 metadata와 비교해 지원하지 않는 값을 가장 가까운 하위 level로 조정합니다.
Reasoning effort를 지원하지 않는 모델에는 override를 전달하지 않습니다.

Session 생성과 resume에는 선택된 `reasoningEffort`를 지정합니다. 같은 Claude session에서
effort가 바뀌거나 기본값으로 reset되면 SDK `session.setModel()`로 conversation을 유지한
채 다음 turn부터 변경합니다. `ultracode`는 `xhigh`로 정규화하며, workflow orchestration과
tool 실행은 Claude Code가 담당합니다.

## 주요 파일

| 파일 | 역할 |
|---|---|
| `bin/claude-ghcp` | Direct bridge lifecycle과 임시 settings 관리 |
| `bin/claude-litellm` | 외부 LiteLLM용 임시 settings 관리 |
| `bin/claude-current` | 기존 Claude Code provider pass-through |
| `src/server.mjs` | Loopback Anthropic Messages HTTP/SSE server |
| `src/session-manager.mjs` | Copilot SDK session과 tool handoff |
| `src/anthropic.mjs` | Messages request/response 변환 |
| `src/model-map.mjs` | Claude Code와 Copilot model ID 변환 |
| `src/write-launch-settings.mjs` | Direct 경로의 mode `0600` settings 생성 |
| `src/write-litellm-settings.mjs` | LiteLLM 경로의 mode `0600` settings 생성 |

## Bridge가 구현한 호환 기능

다음 목록은 구현 범위이며 E2E 검증 목록이 아닙니다. 자동·수동 검증 범위는
[검증 범위](#검증-범위)에서 구분합니다.

- `POST /v1/messages`
- Streaming SSE
- `POST /v1/messages/count_tokens`
- `HEAD /api/hello`
- Text messages
- Base64 image/document forwarding
- Dynamic JSON Schema tools
- Parallel tool-result submission
- Tool errors
- Model별 reasoning effort 전달과 session 중 effort 변경
- Model alias와 version conversion
- Claude Code root/subagent session 분리
- SDK session resume
- `CopilotSession.abort()`까지 request abort 전달
- Call 이후 실제 SDK usage와 provider finish reason mapping
- Bounded cold-history replay와 history 축소 reconciliation
- State split 진단, LRU/TTL eviction, history event cache invalidation
- Background agent와 agent view용 persistent loopback bridge
- Bounded `tool_choice` filtering/prompt emulation
- 대규모 MCP tool set의 안전한 full-schema fallback

## 설정, 네트워크와 로그

### 설정 우선순위

- 기존 user/project/local/managed Claude settings는 계속 불러옵니다.
- Command-line settings는 base URL, 인증 token, 선택 모델과 family mapping 등 routing에
  필요한 값만 override합니다. Direct 경로는 모델 discovery와 custom model context도
  설정합니다.
- User/project/shell의 Claude cloud-provider selector는 빈 값으로 덮어써 요청이 설정된
  endpoint를 우회하지 않게 합니다.
- Gateway 경계의 Claude-native `tool_reference`는 비활성 상태로 두고, Copilot SDK가
  provider-side tool search를 수행하며 필요하면 전체 선언 tool set으로 fallback합니다.
- Managed settings는 위 command-line settings보다 우선합니다. 따라서 조직 정책이
  provider selector나 MCP tool search를 강제하면 실행 스크립트는 이를 우회하지 않습니다.

### 네트워크와 credential

- Direct 실행 스크립트는 bridge를 `127.0.0.1`에만 bind합니다.
- Foreground 실행은 임의의 bridge token을 만들고 종료 시 삭제합니다. Background 실행은
  `0600` registry, atomic lock, health check, stale cleanup, status/stop 명령을 갖는
  persistent loopback daemon을 사용합니다.
- Bridge는 Copilot CLI 로그인 정보를 사용합니다. Anthropic credential을 읽거나
  프로젝트로 복사하지 않습니다.

### 로그

Bridge는 request body, prompt, tool argument, tool result, credential을 직접 log하지
않습니다. 기본 log는 startup metadata와 SDK 또는 bridge error로 제한하며 실행
스크립트가 만든 임시 log는 종료 시 삭제합니다.

## 알려진 제약

- GitHub와 Anthropic이 공동 지원하는 공식 backend integration은 아닙니다.
- 고정된 Copilot SDK 1.0.14는 정식 릴리스입니다. Bridge는 SDK가 노출한 pending-tool
  RPC에도 의존하므로 SDK나 runtime을 업데이트할 때 호환성 검증이 필요합니다.
- Bridge가 해석하는 주요 request field는 model, system text, messages, tools,
  attachments, `output_config.effort`, `tool_choice`와 stream 여부입니다.
  Copilot SDK에 없는 native `max_tokens`, `temperature`, `top_p`, `stop_sequences`
  semantics는 degraded control 진단으로 노출합니다.
- Claude Code gateway contract는 새 header와 body field가 추가되는 open contract입니다.
  이 bridge는 Anthropic upstream으로 그대로 forward하지 않고 Copilot SDK 형식으로
  변환하므로, Claude Code의 새 capability는 자동으로 지원되지 않으며 release별 호환성
  검토가 필요합니다.
- Extended-thinking signature, encrypted reasoning content, reasoning summary, server
  tools, citations와 prompt-cache metadata는 완전하게 round-trip하지 않습니다.
- Initial image/document content block은 E2E로 확인했습니다. Local tool이 반환하는
  binary image/document result는 provider 의존이며 text 또는 initial attachment
  fallback이 필요할 수 있습니다.
- `/v1/messages/count_tokens`는 JSON 길이 기반 preflight 추정이며 response header로
  표시합니다. 완료된 turn은 가능한 경우 실제 Copilot SDK usage event를 사용합니다.
- Pending external-tool의 `toolCallId` → SDK `requestId` mapping은 bridge process memory에
  있습니다. SDK conversation resume은 구현했지만 tool 실행 중 bridge가 종료되면 해당
  mapping을 잃으므로 in-flight turn 복구를 보장하지 않습니다.
- In-memory state map은 configurable LRU/TTL과 bounded replay를 사용합니다. SDK session
  file은 `COPILOT_HOME`에 남으며 history 축소 시 stale session을 삭제하고 일반 eviction은
  resume 가능성을 보존합니다.
- Tool-result retry/idempotency와 background Agent update는 처리합니다. 안정적인
  provider request ID가 없는 일반 message retry는 deduplicate하지 않으며 process crash
  중 in-flight external tool call 복구는 best-effort입니다.
- Background mode와 agent view는 persistent bridge daemon으로 지원합니다. Remote
  Control은 계속 사용할 수 없습니다.
- Custom `ANTHROPIC_BASE_URL`을 사용하는 Claude Code 제약에 따라 Remote Control은
  비활성화됩니다. Cloud/web session과 cloud ultrareview는 local bridge 경로 밖입니다.
- Claude Code structured-output validator/retry는 bridge를 통과해 동작하며 live E2E로
  확인합니다. Native Claude `tool_reference` block은 round-trip하지 않고 Copilot
  round-trip하지 않습니다. Declaration-only external tool과 native deferral 조합은
  stall할 수 있어 전체 MCP schema preload fallback을 사용합니다.
- 원격·공유 배포에는 TLS, user authentication, authorization와 tenant-isolated
  Copilot identity/session storage가 필요합니다.
- Prompt와 source code는 GitHub Copilot model service로 전송됩니다. 사용 전 enterprise
  policy, content exclusion과 data retention 조건을 확인해야 합니다.
- 모델 사용량은 GitHub Copilot AI Credits와 plan policy를 따릅니다.

## 검증 범위

### 자동으로 재현되는 검증

`npm test`는 AI Credit을 사용하지 않고 다음 동작을 확인합니다.

- Anthropic Messages text, attachment, tool result와 SSE 변환
- Claude/Copilot model ID와 family alias 변환
- 주요 7개 피커, 모델별 context hint와 gateway discovery row
- `ultracode`에서 `xhigh`로의 변환과 model별 unsupported effort 조정
- SDK session 생성과 `session.setModel()`을 통한 reasoning effort 변경
- Claude Code root session과 subagent의 SDK session 분리
- 7모델의 interleaved root/worker tool-result 격리와
  취소 후 sibling 생존 검사
- Forked subagent의 inherited history 복구와 `agentId`가 있는 pending tool-call handoff
- Direct/LiteLLM 임시 settings의 gateway routing 값
- LiteLLM settings의 mode `0600`, 실행 인자 처리와 provider detection
- Request cancellation, state eviction, bounded replay, 실제 usage, strict model
  selection, request policy, daemon registry, tool-result idempotency
- JSON/SSE의 명시적 usage 0은 추정치로 대체하지 않습니다. 누락/null일 때만
  기존 fallback을 사용하며, Claude Code result envelope의 캐시 포함 입력 총합이 0이면
  실제 검증은 여전히 실패합니다.

`npm run verify`는 실제 모델로 실제 경로를 구동합니다.

- 11개 시나리오 x 7개 모델 = 77개 슬롯. 각 슬롯은 실제 `claude` 바이너리를
  `-p --output-format stream-json`으로 실행하고, 슬롯 전용 bridge를 거쳐 실제
  Copilot 모델에 연결합니다.
- 시나리오: 저장소 정찰, 정밀 편집과 파일 생성, 실패 테스트 진단과 수정,
  백그라운드 셸과 git 워크플로, 파일 종류를 넘나드는 4단계 계획, 서브에이전트
  위임, 헤드리스 MCP 브라우저 자동화, 훅·메모리·명령·스킬, 프로세스 간 세션
  재개, 대형 컨텍스트 검색과 추론, 그리고 `claude-ghcp` 런처와 상주 데몬·분리형
  백그라운드 에이전트.
- 판정은 1차 증거로만 합니다. 디스크의 파일, git 이력, hook 로그, 스트림이
  직접 기록한 도구 호출 내역입니다. 모델의 산문은 심어 둔 토큰이 있는지만
  확인하며 문체나 동의 여부로는 판정하지 않습니다.
- 슬롯을 실제로 서비스한 모델은 표시 라벨이 아니라 `result.modelUsage`에서
  읽습니다. `tool_use`/`tool_result` 짝이 맞지 않거나 다른 모델이 응답하는 등
  와이어 수준이 불건전한 슬롯은 `fail`이 아니라 `blocked`이며 분모에 남습니다.
  `blocked`는 절대 통과가 아닙니다.
- 슬롯마다 자체 workspace, `settings.json`, `CLAUDE_CONFIG_DIR`을 갖습니다.
  실행기는 변경 감지를 위해 `~/.claude/settings.json`의 실행 전후 해시를
  읽지만, 내용을 저장하거나 슬롯 설정으로 사용하지 않습니다.
- 재개/fork 검사는 seed·resume·fork 모두 도구 없이 원래 문자열을 회상해야 합니다.
  영구 메모리 쓰기로 대화 이력 상속을 대신할 수 없으며, 추론한 날짜를 덧붙인
  응답은 원래 배포 시간 문자열로 인정하지 않습니다.
- 런처 검증은 명령별 stdout/stderr와 종료 전에 복사한 bridge/native daemon 로그를
  보존합니다. 백그라운드 작업 스냅샷은 상태·시간 필드만 허용하며 provider 환경과
  소켓 인증 정보는 제외합니다.
- 새 실행은 `strict-all-pass-v1`을 적용합니다. 전체 실행은 예상한 고유 슬롯
  77개 모두, 부분 실행은 선택한 모든 슬롯이 통과해야 합니다. 누락·중복·예상 밖
  슬롯, 사용자 설정 변경, 구현 출처 기록 누락·변경이 있으면 기록된 슬롯이 모두
  pass여도 전체 판정은 통과가 아닙니다.
- `npm run verify:report`는 최신 실행을 출력하고, `npm run verify:doc`은
  [검증 결과](VERIFICATION_KO.md)를 두 언어로 다시 생성합니다.
  특정 완료된 전체 실행을 문서화하려면
  `node scripts/verify/report.mjs <run-directory> --markdown`(또는 `--markdown=ko`)에
  실행 디렉터리를 명시합니다. 최신 실행 자동 선택은 부분 실행이나 미완료 실행을
  고를 수 있습니다.

`npm run verify`는 실제 GitHub Copilot AI Credits를 사용하며, `npm test`는 사용하지 않습니다.

피커·롱턴 수정을 포함한 전체 실행 `2026-09-22T03-37-17-139Z`는 모델 작업자 3개와
모델별 시나리오 작업자 2개로 77/77 통과했습니다. 앞선 7 × 2 실행의 네이티브 백그라운드 정지 이후
랩탑의 기동 부하를 낮춘 설정이며 기본값, timeout 예산, 통과 기준을 낮추지는
않았습니다. 분리된 실행 이력은 README에, 최종 실행만의 결과는
[검증 결과](VERIFICATION_KO.md)에 기록합니다.

실행 중인 bridge 턴의 timeout과 클라이언트 취소 시 요청 ID로 연결되는
`bridge.turn_timeout` / `bridge.turn_aborted` 스냅샷을 남기고,
`bridge.turn_abort_completed`로 중단 승인 여부를 기록합니다. 작업 단계, RPC 승인 수,
root/subagent 이벤트 수와 최대 8개의 최근 이벤트 종류·시각만 기록하며 프롬프트,
도구 페이로드, 첨부 파일, 인증 정보는 기록하지 않습니다. 진단 출력 실패는 알리되
요청 종료 결과를 바꾸지 않습니다. 이 관측 기능은 재시도나 timeout 연장을 추가하거나
미완료 슬롯을 통과로 바꾸지 않습니다.

대규모 multi-page PDF corpus, workflow fan-out, 정확한 compact/rewind boundary mapping,
crash 시점 in-flight tool 복구는 위 자동 범위에 포함되지 않습니다.

LiteLLM도 검증 범위 밖입니다. 모든 슬롯은 `src/server.mjs`를 직접 실행하며 LiteLLM을
기동하지 않으므로, [시스템 구성](#시스템-구성)과 [LiteLLM 가이드](LITELLM_KO.md)의
LiteLLM 경로는 검증된 경로가 아니라 구성 참고 자료입니다.

### 증거 경계

과거 수동 검증 기록은 제거했습니다. 새 검증은 실제 Claude Code와 Copilot SDK
경로에서 실행하고 native transcript와 실제 SDK model/session 증거를 남깁니다.
모의 protocol 테스트는 live 호환성 증거가 아니며 SDK가 노출하지 않는 provider
내부 동작을 추론해 성공 처리하지 않습니다.

## 참고 자료

- [GitHub Copilot SDK](https://github.com/github/copilot-sdk)
- [Copilot SDK multi-tenancy and `mode: empty`](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/multi-tenancy)
- [Copilot SDK Node.js API](https://github.com/github/copilot-sdk/blob/main/nodejs/README.md)
- [Copilot SDK manual external-tool handoff](https://github.com/github/copilot-sdk/blob/main/nodejs/samples/manual-tool-resume.ts)
- [Copilot SDK streaming events](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events)
- [Copilot SDK authentication](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate)
- [GitHub Copilot supported models](https://docs.github.com/en/copilot/reference/ai-models/supported-models)
- [Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol)
- [Claude Code third-party gateway 지원 경계](https://code.claude.com/docs/en/llm-gateway)
- [Claude Code gateway configuration](https://code.claude.com/docs/en/llm-gateway-connect)
- [Claude Code model과 effort 설정](https://code.claude.com/docs/en/model-config)
- [Claude Code dynamic workflows](https://code.claude.com/docs/en/workflows)
- [Claude Code settings](https://code.claude.com/docs/en/settings)

Direct 경로는 undocumented Copilot HTTP endpoint가 아닌 public GitHub Copilot SDK를
사용합니다.
