# Implementation

## Runtime

| 파일 | 역할 |
|---|---|
| `src/server.mjs` | Loopback Anthropic Messages-compatible HTTP/SSE server |
| `src/session-manager.mjs` | Copilot SDK lifecycle, session mapping, tool handoff |
| `src/anthropic.mjs` | Messages request parsing and Anthropic response encoding |
| `src/model-map.mjs` | Claude Code model names과 Copilot model ID 변환 |
| `src/list-models.mjs` | 현재 identity와 policy에서 허용된 model 조회 |
| `src/provider-detection.mjs` | Secret을 출력하지 않는 기존 provider 감지 |
| `src/write-launch-settings.mjs` | Mode `0600` 임시 Claude settings 생성 |

## Commands

| 파일 | 역할 |
|---|---|
| `bin/claude` | PATH에서 `claude` 명령을 GHCP launcher로 연결하는 wrapper |
| `bin/claude-ghcp` | Bridge lifecycle과 temporary settings를 관리하는 launcher |
| `bin/claude-litellm` | 외부 LiteLLM gateway용 temporary settings launcher |
| `bin/claude-current` | 기존 provider를 그대로 사용하는 pass-through |
| `bin/resolve-claude.sh` | Wrapper 재귀를 피하면서 실제 Claude Code executable 탐색 |
| `bin/ghcp-models` | GitHub Copilot Claude model 목록 |
| `bin/ghcp-doctor` | Node, Claude Code, Copilot CLI, current provider 진단 |

## Claude Code compatibility

구현된 surface:

- `POST /v1/messages`
- streaming SSE envelope
- `POST /v1/messages/count_tokens`
- `HEAD /api/hello`
- text messages
- base64 image/document attachment forwarding
- dynamic JSON Schema tools
- parallel tool-result submission
- tool errors
- model aliases와 version ID conversion
- Claude Code session 및 subagent separation
- SDK session resume

## Settings behavior

Launcher는 user settings를 대체하지 않고 추가 command-line settings를 전달합니다. Provider-related env만 더 높은 precedence로 override되며, 다른 Claude settings는 기존 source에서 병합됩니다.

`claude-litellm`도 같은 precedence 방식을 사용하지만 local bridge를 시작하지 않습니다.
Gateway URL, virtual key, model alias만 mode `0600` 임시 settings에 기록하고 종료 시 삭제합니다.

## Logging

Bridge는 prompt, tool arguments, tool results, credentials를 기록하지 않습니다. 기본 log는 startup metadata와 error message로 제한됩니다.
