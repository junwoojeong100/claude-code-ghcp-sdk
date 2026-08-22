# 아키텍처

이 문서는 maintainer를 위한 구현·검증 설명입니다. 설치와 실행은
[README](../README.md), LiteLLM 운영은 [LiteLLM 가이드](LITELLM.md)를 따릅니다.

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
  -> LiteLLM에 구성된 provider
```

`claude-litellm`이 사용합니다. 로컬 Node.js bridge와 `@github/copilot-sdk`를 통과하지
않습니다. GitHub Copilot backend는 LiteLLM의 `github_copilot/` provider와 별도 OAuth를
사용합니다.

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

Copilot SDK session ID는 Claude session, agent, resolved model, tool schema signature,
system prompt signature로 결정됩니다. Bridge를 다시 시작하면 기존 session의 resume을
시도합니다.

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

`sonnet`, `opus`, `haiku` alias는 현재 계정에서 허용된 family 모델로 해석합니다.
GPT-5.6 모델은 full ID를 사용합니다.

### 모델 discovery와 context

실행 스크립트는 `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`로 `/v1/models` discovery를
활성화합니다. Endpoint는 Copilot SDK `listModels()` 결과를 backend ID 기준으로 중복
제거해 반환합니다.

- Claude Code 2.1.239가 기본 제공하는 Opus 5/4.8, Sonnet 5/4.6, Haiku 4.5는 중복 표시하지
  않습니다.
- Fable은 목록에서 제외합니다.
- 나머지 Claude 모델은 dot version을 hyphen version으로 바꿉니다.
- Claude가 아닌 모델은 discovery filter를 통과하도록
  `github-copilot/claude-<copilot-model-id>` 형식으로 반환합니다.
- 1M 이상 context를 선언한 non-native 모델에는 `[1m]` suffix를 붙입니다.
- Display name에는 정확한 backend 모델 ID를 포함합니다.

Bridge는 picker ID의 prefix와 suffix를 제거해 원래 Copilot 모델 ID를 복원합니다.
Claude Code가 unknown 모델을 200k context로 제한하지 않도록 catalog의 1,050,000 token
context도 임시 settings에 전달합니다.

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

## 설정, 네트워크와 로그

### 설정 우선순위

- 기존 user/project/local/managed Claude settings는 계속 불러옵니다.
- Command-line settings는 base URL, 인증 token, 선택 모델과 family mapping 등 routing에
  필요한 값만 override합니다. Direct 경로는 모델 discovery와 custom model context도
  설정합니다.
- User/project/shell의 Claude cloud-provider selector는 빈 값으로 덮어써 요청이 설정된
  endpoint를 우회하지 않게 합니다.
- User/project/shell의 `ENABLE_TOOL_SEARCH`도 빈 값으로 덮어씁니다. Direct bridge는 일반
  MCP tool schema는 전달하지만 `tool_reference` protocol은 구현하지 않았기 때문입니다.
- Managed settings는 위 command-line settings보다 우선합니다. 따라서 조직 정책이
  provider selector나 MCP tool search를 강제하면 실행 스크립트는 이를 우회하지 않습니다.

### 네트워크와 credential

- Direct 실행 스크립트는 bridge를 `127.0.0.1`에만 bind합니다.
- Direct 실행 스크립트는 실행마다 임의의 bridge token을 생성하고 종료 시 삭제합니다.
- Bridge는 Copilot CLI 로그인 정보를 사용합니다. Anthropic credential을 읽거나
  프로젝트로 복사하지 않습니다.

### 로그

Bridge는 request body, prompt, tool argument, tool result, credential을 직접 log하지
않습니다. 기본 log는 startup metadata와 SDK 또는 bridge error로 제한하며 실행
스크립트가 만든 임시 log는 종료 시 삭제합니다.

## 알려진 제약

- GitHub와 Anthropic이 공동 지원하는 공식 backend integration은 아닙니다.
- Pin된 `@github/copilot-sdk`는 preview package이므로 public pending tool-call API도
  향후 변경될 수 있습니다.
- Extended-thinking signature, encrypted reasoning content, reasoning summary, server
  tools, citations와 prompt-cache metadata는 완전하게 round-trip하지 않습니다.
- Exact token counting, retry/idempotency, disconnect recovery와 context reconciliation은
  production hardening이 필요합니다.
- `claude-ghcp`의 bridge lifecycle 때문에 Claude Code background mode는 지원하지 않습니다.
- Custom `ANTHROPIC_BASE_URL`을 사용하는 Claude Code 제약에 따라 Remote Control은
  비활성화됩니다. Cloud/web session과 cloud ultrareview는 local bridge 경로 밖입니다.
- Structured output의 `output_config` schema translation과 MCP `tool_reference`는
  구현하지 않았습니다.
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
- GPT-5.6 context override와 gateway discovery row
- `ultracode`에서 `xhigh`로의 변환과 model별 unsupported effort 조정
- SDK session 생성과 `session.setModel()`을 통한 reasoning effort 변경
- Direct/LiteLLM 임시 settings의 gateway routing 값
- LiteLLM settings의 mode `0600`, 실행 인자 처리와 provider detection

E2E 스크립트는 실제 모델을 호출합니다.

- `npm run test:e2e`: 기본 `claude-haiku-4.5`의 Direct SDK text response, Claude Code
  native `Read` tool loop와 user settings 파일 존재 여부 및 content hash 불변.
  `GHCP_E2E_MODEL`로 model 변경 가능
- `npm run test:e2e:gpt-5.6`: GPT-5.6 Sol, Terra, Luna 각각의 text response, `Read` tool
  loop와 user settings 파일 존재 여부 및 content hash 불변
- `npm run test:e2e:litellm`: LiteLLM health, model discovery, token counting, text response,
  Claude Code native `Read` tool loop와 user settings 파일 존재 여부 및 content hash 불변

모든 E2E는 실제 GitHub Copilot AI Credits를 사용합니다.

### 별도로 수행한 수동 검증

다음 항목은 구현 과정에서 확인했지만 저장소의 명령만으로는 자동 재현되지 않습니다.

- 실제 Claude Code 2.1.235를 로컬 fake Anthropic gateway에 연결
- `--effort ultracode` request의 `output_config.effort: "ultracode"`와
  `thinking.type: "adaptive"`
- Ultracode request의 workflow, subagent와 task 관리 tool schema
- Copilot catalog의 GPT-5.6 Sol, Terra, Luna context와
  `none`, `low`, `medium`, `high`, `xhigh`, `max` reasoning effort metadata
- Direct SDK와 LiteLLM의 non-streaming/streaming Messages response

Bridge에서 확인할 수 있는 범위는 reasoning effort가 Copilot SDK session configuration에
전달되는 지점까지입니다. Provider 내부 reasoning token 사용량과 실제 GPT-5.6 모델의
complete multi-agent Ultracode workflow는 자동 E2E 범위에 포함되지 않습니다.

## 참고 자료

- [GitHub Copilot SDK](https://github.com/github/copilot-sdk)
- [Copilot SDK multi-tenancy and `mode: empty`](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/multi-tenancy)
- [Copilot SDK Node.js API](https://github.com/github/copilot-sdk/blob/main/nodejs/README.md)
- [Copilot SDK manual external-tool handoff](https://github.com/github/copilot-sdk/blob/main/nodejs/samples/manual-tool-resume.ts)
- [Copilot SDK streaming events](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events)
- [Copilot SDK authentication](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate)
- [GitHub Copilot supported models](https://docs.github.com/en/copilot/reference/ai-models/supported-models)
- [Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol)
- [Claude Code gateway configuration](https://code.claude.com/docs/en/llm-gateway-connect)
- [Claude Code model과 effort 설정](https://code.claude.com/docs/en/model-config)
- [Claude Code dynamic workflows](https://code.claude.com/docs/en/workflows)
- [Claude Code settings](https://code.claude.com/docs/en/settings)

Direct 경로는 undocumented Copilot HTTP endpoint가 아닌 public GitHub Copilot SDK를
사용합니다.
