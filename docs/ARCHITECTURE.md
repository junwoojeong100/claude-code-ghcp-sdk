# Architecture

## 두 실행 경로

### Direct GitHub Copilot SDK

```text
Claude Code
  -> loopback Anthropic Messages bridge
  -> @github/copilot-sdk mode="empty"
  -> GitHub Copilot model
```

`claude`와 `claude-ghcp`가 사용하는 핵심 경로입니다. 사용자의 `copilot login` identity와
organization model policy를 따릅니다.

### LiteLLM

```text
Claude Code
  -> LiteLLM /v1/messages
  -> LiteLLM에 구성된 provider
```

`claude-litellm`이 사용합니다. Local Node.js bridge와 `@github/copilot-sdk` adapter를
통과하지 않습니다. GitHub Copilot backend를 선택하면 LiteLLM의 `github_copilot/`
provider와 별도 OAuth를 사용합니다.

## 역할 분리

Claude Code가 계속 담당하는 기능:

- Terminal UI와 conversation
- Permissions
- Hooks, plugins, skills, MCP
- Local file, shell, edit 등의 tool 실행
- User-facing session lifecycle

Direct 경로의 GitHub Copilot SDK는 model backend만 담당합니다.

## Direct SDK request flow

1. Claude Code가 `/v1/messages`에 system prompt, conversation, tool schema를 전송합니다.
2. Bridge가 Claude Code model ID를 허용된 Copilot model ID로 변환합니다.
3. Copilot SDK session을 `mode: "empty"`로 생성합니다.
4. Claude Code system prompt와 tool declaration을 SDK session에 등록합니다.
5. Copilot model의 tool 요청을 Anthropic `tool_use` block으로 Claude Code에 반환합니다.
6. Claude Code가 tool을 실행하고 `tool_result`를 다음 요청에 보냅니다.
7. Bridge가 `handlePendingToolCall`로 결과를 SDK session에 전달합니다.
8. Model의 최종 응답을 Anthropic Messages 응답으로 Claude Code에 반환합니다.

## Session과 model mapping

Bridge는 다음 Claude Code header로 root session과 subagent를 분리합니다.

- `x-claude-code-session-id`
- `x-claude-code-agent-id`

Copilot SDK session ID는 Claude session, agent, resolved model, tool schema signature로
결정됩니다. Bridge restart 후 기존 session resume을 시도합니다.

Claude Code와 Copilot model ID의 version separator 차이도 변환합니다.

| Claude Code frontend | GitHub Copilot |
|---|---|
| `claude-sonnet-4-6` | `claude-sonnet-4.6` |
| `claude-opus-4-8` | `claude-opus-4.8` |
| `claude-haiku-4-5` | `claude-haiku-4.5` |
| `gpt-5.6-sol` | `gpt-5.6-sol` |
| `gpt-5.6-terra` | `gpt-5.6-terra` |
| `gpt-5.6-luna` | `gpt-5.6-luna` |

`sonnet`, `opus`, `haiku`, `fable` alias는 현재 identity에 허용된 family model로 해석합니다.
GPT-5.6 model은 full ID를 사용합니다. Claude Code가 unknown model을 200k context로
제한하지 않도록 catalog의 1,050,000 token context를 임시 settings에 전달합니다.
`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`로 `/v1/models` discovery를 활성화하고,
endpoint에는 adapter가 지원하는 Claude 및 GPT-5.6 model만 반환합니다.

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

## 구현된 호환 surface

- `POST /v1/messages`
- Streaming SSE
- `POST /v1/messages/count_tokens`
- `HEAD /api/hello`
- Text messages
- Base64 image/document forwarding
- Dynamic JSON Schema tools
- Parallel tool-result submission
- Tool errors
- Model alias와 version conversion
- Claude Code root/subagent session 분리
- SDK session resume

## Settings, network와 logging

- 기존 user/project/local/managed Claude settings는 계속 로드됩니다.
- Provider 값만 command-line settings로 override합니다.
- Bridge는 기본적으로 `127.0.0.1`에만 bind합니다.
- Direct launcher는 실행마다 random bridge token을 생성하고 종료 시 삭제합니다.
- Bridge는 기존 provider credential을 읽거나 project로 복사하지 않습니다.
- Prompt, tool argument, tool result와 credential을 log에 기록하지 않습니다.
- 기본 log는 startup metadata와 error message로 제한됩니다.

## Production 제약

- GitHub와 Anthropic이 공동 지원하는 공식 backend integration은 아닙니다.
- Pin된 `@github/copilot-sdk`는 preview package이고 external-tool RPC는 experimental입니다.
- Extended-thinking signature, encrypted reasoning, server tools, citations와 prompt-cache
  metadata의 완전한 round-trip은 추가 검증이 필요합니다.
- Exact token counting, retry/idempotency, disconnect recovery와 context reconciliation은
  production hardening이 필요합니다.
- `claude-ghcp`의 bridge lifecycle 때문에 Claude Code background mode는 지원하지 않습니다.
- Remote/shared deployment에는 TLS, user authentication, authorization와 tenant-isolated
  Copilot identity/session storage가 필요합니다.
- Prompt와 source code가 GitHub Copilot model service로 전송되므로 enterprise policy,
  content exclusion과 data retention 조건을 확인해야 합니다.
- Model usage는 GitHub Copilot AI Credits와 plan policy를 따릅니다.

## 검증 범위

다음 항목을 실제 model 호출로 확인했습니다.

- Direct SDK text response와 streaming
- Direct SDK Claude Code native `Read` tool loop
- GPT-5.6 Sol, Terra, Luna text response와 native `Read` tool loop
- LiteLLM health, model discovery와 token counting
- LiteLLM non-streaming/streaming Messages response
- LiteLLM Claude Code native `Read` tool loop
- E2E 전후 기존 `~/.claude/settings.json` hash 불변

재현:

```bash
npm test
npm run test:e2e
npm run test:e2e:gpt-5.6
npm run test:e2e:litellm
```

## 공식 근거

- [GitHub Copilot SDK](https://github.com/github/copilot-sdk)
- [Copilot SDK multi-tenancy and `mode: empty`](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/multi-tenancy)
- [Copilot SDK Node.js API](https://github.com/github/copilot-sdk/blob/main/nodejs/README.md)
- [Copilot SDK manual external-tool handoff](https://github.com/github/copilot-sdk/blob/main/nodejs/samples/manual-tool-resume.ts)
- [Copilot SDK streaming events](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events)
- [Copilot SDK authentication](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate)
- [GitHub Copilot supported models](https://docs.github.com/en/copilot/reference/ai-models/supported-models)
- [Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol)
- [Claude Code gateway configuration](https://code.claude.com/docs/en/llm-gateway-connect)
- [Claude Code settings](https://code.claude.com/docs/en/settings)

Direct 경로의 model access는 undocumented Copilot HTTP endpoint가 아니라 public GitHub
Copilot SDK를 사용합니다.
