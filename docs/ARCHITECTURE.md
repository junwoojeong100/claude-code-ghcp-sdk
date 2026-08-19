# Architecture

## 목표

Claude Code가 다음 역할을 계속 담당합니다.

- terminal UI와 conversation UX
- permissions
- hooks, plugins, skills, MCP
- local file, shell, edit 등 tool execution
- user-facing session lifecycle

GitHub Copilot SDK는 model backend 역할만 수행하도록 제한합니다.

## Request flow

1. Claude Code가 `/v1/messages`에 system prompt, conversation, tool schemas를 전송합니다.
2. Bridge가 Claude Code model ID를 허용된 Copilot model ID로 변환합니다.
3. Copilot SDK session을 `mode: "empty"`로 생성합니다.
4. Claude Code system prompt를 `systemMessage.mode: "replace"`로 전달합니다.
5. Claude Code tools를 handler 없는 declaration-only SDK tools로 등록합니다.
6. Copilot model이 tool을 요청하면 SDK가 `external_tool.requested`를 발생시킵니다.
7. Bridge가 이를 Anthropic `tool_use` content block으로 반환합니다.
8. Claude Code가 native tool을 실행하고 다음 `/v1/messages` 요청에 `tool_result`를 보냅니다.
9. Bridge가 `session.tools.handlePendingToolCall`로 결과를 주입합니다.
10. Copilot model이 generation을 계속하고 최종 응답을 Claude Code에 반환합니다.

## Session identity

Bridge는 다음 header를 사용해 session을 분리합니다.

- `x-claude-code-session-id`
- `x-claude-code-agent-id`

Copilot SDK session ID는 위 값, resolved model, tool schema signature의 SHA-256 digest로 결정됩니다. Bridge restart 후 기존 Copilot session이 있으면 resume을 시도합니다.

## Model mapping

Claude Code와 Copilot은 version separator가 다를 수 있습니다.

| Claude Code frontend | GitHub Copilot |
|---|---|
| `claude-sonnet-4-6` | `claude-sonnet-4.6` |
| `claude-opus-4-8` | `claude-opus-4.8` |
| `claude-haiku-4-5` | `claude-haiku-4.5` |

`sonnet`, `opus`, `haiku`, `fable` alias도 현재 사용자에게 허용된 최신 family model로 해석합니다.

## Network and credentials

- Bridge는 기본적으로 `127.0.0.1`에만 bind합니다.
- Launcher가 매 실행마다 random bridge token을 생성합니다.
- Claude Code는 token을 local bridge에만 보냅니다.
- Bridge는 기존 `copilot login` OAuth state를 사용합니다.
- Databricks credential은 bridge나 project 파일로 전달되지 않습니다.

## Streaming

Bridge는 SDK의 `assistant.message_delta`와 `assistant.tool_call_delta`를 Anthropic `text_delta`와 `input_json_delta`로 전달합니다. Turn이 길어지는 동안에는 SSE keepalive ping도 전송합니다.
