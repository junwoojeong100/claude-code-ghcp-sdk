# Architecture

> **Language / 언어:** English | [한국어](ARCHITECTURE_KO.md)

This document is an implementation and validation reference for maintainers. For installation and running, see the [README](../README.md); for LiteLLM operation, see the [LiteLLM Guide](LITELLM.md).

The core principle is singular: Claude Code owns the UI, session, and tool execution; this repository only swaps the model backend connection.

## System Overview

### Direct GitHub Copilot SDK

```text
Claude Code
  -> loopback Anthropic Messages bridge
  -> @github/copilot-sdk mode="empty"
  -> GitHub Copilot model
```

Used by `claude` and `claude-ghcp`. Respects the `copilot login` account and the organization's model policy.

### LiteLLM

```text
Claude Code
  -> LiteLLM /v1/messages
  -> provider configured in LiteLLM
```

Used by `claude-litellm`. Does not pass through the local Node.js bridge or `@github/copilot-sdk`. The GitHub Copilot backend uses LiteLLM's `github_copilot/` provider with a separate OAuth flow.

## Integration Rationale and Boundaries

The official Claude Code integration point this repository uses is not a model SDK provider plugin but the Anthropic Messages API format exposed by a gateway at `ANTHROPIC_BASE_URL`. The Copilot SDK, however, does not provide an HTTP Anthropic API; it communicates with the Copilot CLI server over JSON-RPC.

This integration is therefore an adapter between the following two public contracts:

| Boundary | What this repository handles |
|---|---|
| Claude Code → gateway | Implements the required subset of `/v1/messages`, SSE, token counting, and model discovery |
| Bridge → Copilot | Uses `@github/copilot-sdk` sessions, streaming events, and the pending external-tool RPC |
| Tool execution | Registers Copilot tools as declaration-only and returns actual execution to Claude Code |

Claude Code's official documentation permits connecting to third-party gateways that implement the supported API format, but Anthropic explicitly states it does not support routing non-Claude models through a gateway. The Copilot SDK upstream is GA and programmatically exposes the same runtime as the Copilot CLI, but does not provide a Claude Code integration. The pinned `@github/copilot-sdk@1.0.10-preview.0` and the overall combination form a separate, unofficial compatibility layer.

## Role Separation

Features handled by Claude Code:

- Terminal UI and conversation
- Permissions
- Hooks, plugins, skills, MCP
- Tool execution (local files, shell, edits, etc.)
- User-facing session lifecycle

The GitHub Copilot SDK and bridge on the Direct path handle only the model backend connection.

## Direct SDK Request Flow

1. Claude Code sends the system prompt, conversation, and tool schema to `/v1/messages`.
2. The bridge translates the Claude Code model ID to a Copilot model ID.
3. `output_config.effort` is compared against the model's `supportedReasoningEfforts`.
4. A Copilot SDK session is created with `mode: "empty"` and the selected `reasoningEffort`.
5. The Claude Code system prompt and tool declarations are registered with the SDK session.
6. Tool requests from the Copilot model are returned as Anthropic `tool_use` blocks.
7. Claude Code executes the tool and sends the `tool_result` in the next request.
8. The bridge delivers the result to the SDK session via `handlePendingToolCall`.
9. The final response is returned to Claude Code in Anthropic Messages format.

## Session and Model Mapping

### Session Isolation

The bridge separates root sessions and subagents using the following Claude Code headers:

- `x-claude-code-session-id`
- `x-claude-code-agent-id`

The Copilot SDK session ID is determined by a bridge-instance namespace plus
the Claude session, agent, resolved model, tool schema signature, and system
prompt signature. A persistent daemon can resume evicted sessions within the
same bridge process. After a process restart, the bridge performs bounded cold
history replay instead of reusing provider state from an earlier process; this
prevents cross-run conversation leakage.

### Model ID Translation

Translates the version-separator difference between Claude Code and Copilot model IDs.

| Claude Code frontend | GitHub Copilot |
|---|---|
| `claude-sonnet-5` | `claude-sonnet-5` |
| `claude-sonnet-4-6` | `claude-sonnet-4.6` |
| `claude-opus-4-8` | `claude-opus-4.8` |
| `claude-haiku-4-5` | `claude-haiku-4.5` |
| `gpt-5.6-sol` | `gpt-5.6-sol` |
| `gpt-5.6-terra` | `gpt-5.6-terra` |
| `gpt-5.6-luna` | `gpt-5.6-luna` |

The `sonnet`, `opus`, and `haiku` aliases resolve to the permitted family model for the current account. GPT-5.6 models use their full ID.

### Model Discovery and Context

The launch scripts enable `/v1/models` discovery via `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`. The endpoint returns the results of `listModels()` from the Copilot SDK, deduplicated by backend ID.

- Opus 5/4.8, Sonnet 5/4.6, and Haiku 4.5 already bundled with Claude Code 2.1.239 are not shown as duplicates.
- Fable is excluded from the list.
- Other Claude models have their dot-version converted to hyphen-version.
- Non-Claude models are returned in the format `github-copilot/claude-<copilot-model-id>` to pass the discovery filter.
- Non-native models that declare a context of 1M or more receive a `[1m]` suffix.
- Display names include the exact backend model ID.

The bridge removes the prefix and suffix from picker IDs to recover the original Copilot model ID. To prevent Claude Code from capping unknown models at 200k context, the catalog's 1,050,000-token context is also written to the temporary settings.

### Reasoning Effort

`/effort` and `--effort` are forwarded as `output_config.effort` in the Anthropic Messages request. The bridge compares the value against model metadata and adjusts unsupported values down to the nearest supported level. No override is forwarded to models that do not support reasoning effort.

Sessions are created and resumed with the selected `reasoningEffort`. If the effort changes or resets to the default within the same Claude session, `session.setModel()` is called to change it from the next turn while preserving the conversation. `ultracode` is normalized to `xhigh`; workflow orchestration and tool execution remain with Claude Code.

## Key Files

| File | Role |
|---|---|
| `bin/claude-ghcp` | Direct bridge lifecycle and temporary settings management |
| `bin/claude-litellm` | Temporary settings management for external LiteLLM |
| `bin/claude-current` | Pass-through to the original Claude Code provider |
| `src/server.mjs` | Loopback Anthropic Messages HTTP/SSE server |
| `src/session-manager.mjs` | Copilot SDK session and tool handoff |
| `src/anthropic.mjs` | Messages request/response translation |
| `src/model-map.mjs` | Claude Code and Copilot model ID translation |
| `src/write-launch-settings.mjs` | Generates mode `0600` settings for the Direct path |
| `src/write-litellm-settings.mjs` | Generates mode `0600` settings for the LiteLLM path |

## Bridge-Implemented Features

The following list describes the implementation scope, not the E2E validation scope. Automated and manual validation boundaries are defined in [Validation Scope](#validation-scope).

- `POST /v1/messages`
- Streaming SSE
- `POST /v1/messages/count_tokens`
- `HEAD /api/hello`
- Text messages
- Base64 image/document forwarding
- Dynamic JSON Schema tools
- Parallel tool-result submission
- Tool errors
- Per-model reasoning effort forwarding and mid-session effort changes
- Model alias and version conversion
- Claude Code root/subagent session isolation
- SDK session resume
- Request abort propagation to `CopilotSession.abort()`
- Actual post-call SDK usage and provider finish-reason mapping
- Bounded cold-history replay and history-shrink reconciliation
- State split diagnostics, LRU/TTL eviction, and history-event cache invalidation
- Persistent loopback bridge lifecycle for background agents and agent view
- Bounded `tool_choice` filtering/prompt emulation
- Safe full-schema fallback for large MCP tool sets

## Configuration, Network, and Logging

### Configuration Priority

- Existing user, project, local, and managed Claude settings continue to be loaded.
- Command-line settings override only the values needed for routing: base URL, authentication token, selected model, and family mapping. The Direct path also configures model discovery and custom model context.
- The Claude cloud-provider selector in user, project, or shell settings is overwritten with an empty value to prevent requests from bypassing the configured endpoint.
- Claude-native `tool_reference` remains disabled at the gateway boundary, while
  the bridge preloads the full declared tool set. Copilot SDK native deferral is
  disabled because declaration-only external tools can stall in that mode.
- Managed settings take precedence over these command-line settings. Therefore, if an organization policy enforces a provider selector or MCP tool search, the launch scripts do not override it.

### Network and Credentials

- The Direct launch script binds the bridge to `127.0.0.1` only.
- Foreground launches generate a random bridge token and delete it on exit.
  Background launches use a persistent loopback daemon with a `0600` registry,
  atomic lock, health check, stale cleanup, and explicit status/stop commands.
- The bridge uses the Copilot CLI login credentials. It does not read or copy Anthropic credentials into the project.

### Logging

The bridge does not directly log request bodies, prompts, tool arguments, tool results, or credentials. Default logging is limited to startup metadata and SDK or bridge errors. Temporary log files created by the launch scripts are deleted on exit.

## Known Constraints

- This is not an official backend integration jointly supported by GitHub and Anthropic.
- The Copilot SDK upstream is GA, but the pinned `@github/copilot-sdk` package is a preview release, and the public pending tool-call API it uses may change in the future.
- The primary request fields the bridge interprets are model, system text,
  messages, tools, attachments, `output_config.effort`, `tool_choice`, and
  whether streaming is enabled. Native `max_tokens`, `temperature`, `top_p`,
  and `stop_sequences` semantics are not exposed by the Copilot SDK and are
  reported as degraded controls.
- The Claude Code gateway contract is an open contract to which new headers and body fields may be added. Because this bridge translates to Copilot SDK format rather than forwarding to an Anthropic upstream unchanged, new Claude Code capabilities are not automatically supported and require per-release compatibility review.
- Extended-thinking signatures, encrypted reasoning content, reasoning summaries, server tools, citations, and prompt-cache metadata do not round-trip completely.
- Initial image/document content blocks are E2E-verified. Binary image/document
  results returned from a local tool remain provider-dependent and may require
  a text or initial-attachment fallback.
- `/v1/messages/count_tokens` remains a preflight estimate derived from JSON
  length and is labeled by response header. Completed turns use actual Copilot
  SDK usage events when available.
- The `toolCallId` → SDK `requestId` mapping for pending external tools lives in the bridge process memory. SDK conversation resume is implemented, but if the bridge exits while a tool call is in flight, that mapping is lost and recovery of the in-flight turn is not guaranteed.
- The in-memory state map has configurable LRU/TTL bounds and bounded replay.
  SDK session files remain in `COPILOT_HOME`; history shrink deletes the stale
  SDK session, while normal eviction preserves resumability.
- Tool-result retry/idempotency and background Agent updates are handled.
  General message retries are not deduplicated without a stable provider request
  identifier, and process-crash recovery during an in-flight external tool call
  remains best-effort.
- Background mode and agent view are supported through the persistent bridge
  daemon. Remote Control remains unavailable.
- Remote Control is disabled by the Claude Code constraint that applies when a custom `ANTHROPIC_BASE_URL` is used. Cloud/web sessions and cloud ultrareview are outside the local bridge path.
- Claude Code's structured-output validator/retry works through the bridge and
  is covered by live E2E. Native Claude `tool_reference` blocks are not
  round-tripped; a full-schema MCP fallback is used instead.
- Remote or shared deployments require TLS, user authentication, authorization, and tenant-isolated Copilot identity/session storage.
- Prompts and source code are sent to the GitHub Copilot model service. Review your enterprise policy, content exclusion settings, and data retention conditions before use.
- Model usage is subject to GitHub Copilot AI Credits and plan policy.

## Validation Scope

### Automated Reproducible Validation

`npm test` verifies the following behavior without consuming GitHub Copilot AI Credits:

- Anthropic Messages text, attachment, and tool-result translation and SSE conversion
- Claude/Copilot model ID and family alias translation
- GPT-5.6 context override and gateway discovery row
- `ultracode` → `xhigh` normalization and per-model unsupported-effort adjustment
- SDK session creation and reasoning-effort changes via `session.setModel()`
- Claude Code root session and subagent SDK session isolation
- Inherited history recovery for forked subagents and pending tool-call handoff with `agentId`
- Gateway routing values in the Direct/LiteLLM temporary settings
- Mode `0600`, argument handling, and provider detection for LiteLLM settings
- Request cancellation, state eviction, bounded replay, actual usage, strict
  model selection, request policy, daemon registry, and tool-result idempotency

E2E scripts call real models:

- `npm run test:e2e`: Direct SDK text response for the default `claude-haiku-4.5`, Claude Code native `Read` tool loop, and invariance of `~/.claude/settings.json` existence and content hash. The model can be changed with `GHCP_E2E_MODEL`.
- `npm run test:e2e:gpt-5.6`: Text response, `Read` tool loop, and invariance of `~/.claude/settings.json` existence and content hash for each of GPT-5.6 Sol, Terra, and Luna.
- `npm run test:e2e:primary`: Text response and `Read` loop for the
  guaranteed primary seven-model matrix.
- `npm run test:e2e:litellm`: LiteLLM health check, model discovery, token counting, text response, Claude Code native `Read` tool loop, and invariance of `~/.claude/settings.json` existence and content hash.
- `npm run test:e2e:features`: Structured output, Edit, Write, NotebookEdit,
  Bash, hooks, skills, plugins, local MCP, plan mode, subagents, image input,
  and cron.
- `npm run test:e2e:session`: Resume and fork.
- `npm run test:e2e:background`: Background agent, agent view, and daemon
  cleanup.
- `npm run test:e2e:stream`: stream-json input/output and replay.
- `npm run test:e2e:worktree`: Git worktree isolation.

All E2E tests consume real GitHub Copilot AI Credits.

Large multi-page PDF corpora, broad workflow fan-out, exact compact/rewind boundary
mapping, and crash-time in-flight tool recovery are not included in the
automated E2E scope.

### Additional Manual Validation

The following items were verified during development but are not automatically reproducible using only the repository's commands:

- Connected real Claude Code 2.1.235 to a local fake Anthropic gateway
- `output_config.effort: "ultracode"` and `thinking.type: "adaptive"` in an `--effort ultracode` request
- Workflow, subagent, and task-management tool schemas in an Ultracode request
- GPT-5.6 Sol, Terra, and Luna context from the Copilot catalog, and `none`, `low`, `medium`, `high`, `xhigh`, `max` reasoning effort metadata
- Non-streaming and streaming Messages responses for both Direct SDK and LiteLLM
- GPT-5.6 Sol root calling an Agent, Explore subagent's `Read` tool loop, and result forwarding to the parent

The bridge's observable scope ends where reasoning effort is delivered to the Copilot SDK session configuration. Provider-internal reasoning token usage and a complete multi-agent Ultracode workflow on a real GPT-5.6 model are not included in the automated E2E scope.

## References

- [GitHub Copilot SDK](https://github.com/github/copilot-sdk)
- [Copilot SDK multi-tenancy and `mode: empty`](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/multi-tenancy)
- [Copilot SDK Node.js API](https://github.com/github/copilot-sdk/blob/main/nodejs/README.md)
- [Copilot SDK manual external-tool handoff](https://github.com/github/copilot-sdk/blob/main/nodejs/samples/manual-tool-resume.ts)
- [Copilot SDK streaming events](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events)
- [Copilot SDK authentication](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate)
- [GitHub Copilot supported models](https://docs.github.com/en/copilot/reference/ai-models/supported-models)
- [Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol)
- [Claude Code third-party gateway support boundary](https://code.claude.com/docs/en/llm-gateway)
- [Claude Code gateway configuration](https://code.claude.com/docs/en/llm-gateway-connect)
- [Claude Code model and effort configuration](https://code.claude.com/docs/en/model-config)
- [Claude Code dynamic workflows](https://code.claude.com/docs/en/workflows)
- [Claude Code settings](https://code.claude.com/docs/en/settings)

The Direct path uses the public GitHub Copilot SDK, not an undocumented Copilot HTTP endpoint.
