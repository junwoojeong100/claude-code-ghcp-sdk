# Test Results

확인 시점: 2026-08-19

## Versions

| Component | Version |
|---|---|
| Claude Code | `2.1.223` |
| GitHub Copilot CLI | `1.0.81-1` |
| GitHub Copilot SDK | `1.0.10-preview.0` |
| LiteLLM | `1.97.0` |
| FastAPI for LiteLLM | `0.139.0` |
| Node.js | `22.16.0` |

## Completed checks

| Check | Backend model | Result |
|---|---|---|
| SDK declaration-only tool request and result resume | Claude Haiku 4.5 | PASS |
| Claude Code text response through adapter | Claude Haiku 4.5 | PASS |
| Claude Code native `Read` tool loop through adapter | Claude Haiku 4.5 | PASS |
| Claude Code text response through adapter | GPT-5 mini | PASS |
| Claude Code native `Read` tool loop through adapter | GPT-5 mini | PASS |
| `--settings` override while user Databricks settings remain loaded | Claude Haiku 4.5 | PASS |
| Launcher default model and realtime text deltas | Claude Sonnet 4.6 | PASS |
| Project unit suite | N/A | 20/20 PASS |
| Existing `~/.claude/settings.json` unchanged after E2E | N/A | PASS |
| LiteLLM health and model discovery | Claude Sonnet 4.6 | PASS |
| LiteLLM `/v1/messages/count_tokens` | Claude Sonnet 4.6 | PASS |
| LiteLLM non-streaming `/v1/messages` | Claude Sonnet 4.6 | PASS |
| LiteLLM streaming `/v1/messages` | Claude Sonnet 4.6 | PASS |
| Claude Code text response through LiteLLM | Claude Sonnet 4.6 | PASS |
| Claude Code native `Read` tool loop through LiteLLM | Claude Sonnet 4.6 | PASS |
| LiteLLM E2E leaves `~/.claude/settings.json` unchanged | N/A | PASS |
| Direct GHCP SDK E2E after LiteLLM setup | Claude Haiku 4.5 | PASS |

LiteLLM 1.97.0은 `github_copilot/claude-sonnet-4.6` mapping의 built-in cost metadata를
찾지 못해 local cost/cache-cost reporting warning을 출력합니다. 호출 및 실제 Copilot AIC
과금은 성공하지만 LiteLLM의 표시 비용은 별도 가격 mapping 전까지 신뢰하지 않습니다.

Observed markers:

```text
CLAUDE_CODE_UI_COPILOT_MODEL_OK
CLAUDE_CODE_UI_COPILOT_GPT_MODEL_OK
CLAUDE_CODE_COPILOT_SDK_END_TO_END_OK
CLI_SETTINGS_OVERRIDE_PRESERVED_USER_CONFIG_OK
GHCP_SONNET_STREAMING_OK
LITELLM_MESSAGES_TEXT_OK
LITELLM_MESSAGES_STREAM_OK
CLAUDE_LITELLM_TEXT_OK
CLAUDE_LITELLM_READ_TOOL_OK
```

## Reproduce

Unit tests:

```bash
npm test
```

Live E2E:

```bash
npm run test:e2e

# Start the local gateway in another terminal first.
npm run litellm:start
npm run test:e2e:litellm
```

Both E2E tests consume GitHub Copilot AI Credits and verify that the SHA-256 hash of
`~/.claude/settings.json` is unchanged.
