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
  -> loopback Anthropic Messages bridge
  -> @github/copilot-sdk mode="empty"
  -> GitHub Copilot model
```

Used by `claude-litellm`. LiteLLM is a proxy in front of the same local bridge, reached through its `anthropic/*` provider with `api_base` set to the bridge root. LiteLLM strips the `anthropic/` prefix and sends the remainder as the request body's model, and the configured `api_key` arrives as `x-api-key`. LiteLLM's own `github_copilot/` provider and its separate GitHub device OAuth flow are not used.

Two Direct-path behaviors do not survive the extra hop: `/v1/models` returns LiteLLM's own aliases rather than the bridge's discovery rows, and `POST /v1/messages/count_tokens` is answered by LiteLLM's local estimate instead of reaching the bridge. The bridge binds to loopback unless `ALLOW_NON_LOOPBACK=1` is set, so LiteLLM runs on the same host. This path is outside the [Validation Scope](#validation-scope).

## Integration Rationale and Boundaries

The official Claude Code integration point this repository uses is not a model SDK provider plugin but the Anthropic Messages API format exposed by a gateway at `ANTHROPIC_BASE_URL`. The Copilot SDK, however, does not provide an HTTP Anthropic API; it communicates with the Copilot CLI server over JSON-RPC.

This integration is therefore an adapter between the following two public contracts:

| Boundary | What this repository handles |
|---|---|
| Claude Code → gateway | Implements the required subset of `/v1/messages`, SSE, token counting, and model discovery |
| Bridge → Copilot | Uses `@github/copilot-sdk` sessions, streaming events, and the pending external-tool RPC |
| Tool execution | Registers Copilot tools as declaration-only and returns actual execution to Claude Code |

Claude Code's official documentation permits connecting to third-party gateways that implement the supported API format, but Anthropic explicitly states it does not support routing non-Claude models through a gateway. The stable Copilot SDK programmatically exposes the Copilot runtime, but does not provide a Claude Code integration. The pinned `@github/copilot-sdk@1.0.14` and the overall combination form a separate, unofficial compatibility layer.

SDK 1.0.14 uses a platform-specific `@github/copilot-sdk-*` package containing
runtime 1.0.85 rather than depending on the separate `@github/copilot` CLI
package. `CopilotClient` uses that bundled runtime unless `COPILOT_CLI_PATH`
explicitly selects another installation. A globally installed CLI version is
therefore not necessarily the version serving bridge requests.

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

History identity excludes moving `cache_control` transport annotations and
inline `system` entries from the conversational-turn comparison. Meaningful
inline system text, including native custom-agent definitions and output styles,
is merged into the SDK system message instead of being discarded. Only recognized
per-request token-budget annotations are removed from that inline context.
Changes to real user/assistant content, tool input data, or system instructions
still trigger the existing reconciliation/state-split behavior.

Cold replay retains tool-use IDs, tool-result error status, and native
`tool_reference` names. Pending ToolSearch results retain their references as
tool-result text, preserving the discovered tool identity through the SDK.

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
| `gpt-6-astra` | `gpt-6-astra` |

The `sonnet`, `opus`, and `haiku` aliases resolve to the permitted family model for the current account. GPT-5.6 models and GPT-6 Astra use their full ID.

### Model Discovery and Context

The Direct launch settings enable `/v1/models` discovery via `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`; the LiteLLM settings do not, because LiteLLM answers `/v1/models` with its own aliases. The endpoint returns the results of `listModels()` from the Copilot SDK, deduplicated by backend ID.

- Opus 5/4.8, Sonnet 5/4.6, and Haiku 4.5 already bundled with Claude Code 2.1.239 are not shown as duplicates.
- Fable is excluded from the list.
- Other Claude models have their dot-version converted to hyphen-version.
- Non-Claude models are returned in the format `github-copilot/claude-<copilot-model-id>` to pass the discovery filter.
- Non-native models that declare a context of 1M or more receive a `[1m]` suffix.
- Display names include the exact backend model ID.

The bridge removes the prefix and suffix from picker IDs to recover the original Copilot model ID. Astra is advertised as `github-copilot/claude-gpt-6-astra[1m]`. To prevent Claude Code from capping unknown models at 200k context, temporary launch settings include the catalog context for GPT-5.6 Sol/Terra/Luna (1,050,000 tokens) and GPT-6 Astra (1,178,000 tokens).

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
- The pinned Copilot SDK 1.0.14 is a stable release. The bridge also relies on SDK-exposed pending-tool RPCs; SDK or runtime upgrades still require compatibility testing.
- The primary request fields the bridge interprets are model, system text,
  messages, tools, attachments, `output_config.effort`, `tool_choice`, and
  whether streaming is enabled. Native `max_tokens`, `temperature`, `top_p`,
  and `stop_sequences` semantics are not exposed by the Copilot SDK and are
  reported as degraded controls.
- The Claude Code gateway contract is an open contract to which new headers and body fields may be added. Because this bridge translates to Copilot SDK format rather than forwarding to an Anthropic upstream unchanged, new Claude Code capabilities are not automatically supported and require per-release compatibility review.
- Extended-thinking signatures, encrypted reasoning content, reasoning summaries, server tools, citations, and prompt-cache metadata do not round-trip completely.
- Initial image/document content blocks are translated by the bridge. Binary image/document
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
- GPT-5.6 and GPT-6 Astra context overrides and gateway discovery rows
- `ultracode` → `xhigh` normalization and per-model unsupported-effort adjustment
- SDK session creation and reasoning-effort changes via `session.setModel()`
- Claude Code root session and subagent SDK session isolation
- Seven-model interleaved root/worker tool-result isolation and sibling survival
  after cancellation
- Inherited history recovery for forked subagents and pending tool-call handoff with `agentId`
- Gateway routing values in the Direct/LiteLLM temporary settings
- Mode `0600`, argument handling, and provider detection for LiteLLM settings
- Request cancellation, state eviction, bounded replay, actual usage, strict
  model selection, request policy, daemon registry, and tool-result idempotency

`npm run verify` drives the real path with real models:

- 11 scenarios x 7 models = 77 slots. Every slot launches the real `claude`
  binary with `-p --output-format stream-json`, routed through a bridge of its
  own, against a real Copilot model.
- The scenarios: repository reconnaissance, surgical edit and file creation,
  failing-test diagnose and fix, background shell and git workflow, a four-step
  plan across file types, subagent delegation, headless MCP browser automation,
  hooks/memory/commands/skills, session resume across processes,
  long-context retrieval, and the `claude-ghcp` launcher with its persistent
  daemon and a detached background agent.
- Each slot is judged from primary evidence: files on disk, git history, hook
  logs, and the stream's own record of which tools ran. Model prose is only ever
  checked for a specific planted token, never for style or agreement.
- The model that served a slot is read from `result.modelUsage`, not from the
  displayed label. A slot whose wire protocol is unsound — unpaired
  `tool_use`/`tool_result`, or the wrong model served — is `blocked`, not
  `fail`, and stays in the denominator. Blocked is never a pass.
- Each slot gets its own workspace, `settings.json`, and `CLAUDE_CONFIG_DIR`.
  The runner reads a before/after digest of `~/.claude/settings.json` to detect
  changes; it does not store the contents or use them as slot settings.
- New runs use `strict-all-pass-v1`: all 77 unique expected slots must pass for
  a full run, and every selected slot must pass for a focused run. Missing,
  duplicate or unexpected slots, changed user settings, or missing/changed
  implementation provenance prevent green even if the recorded slots all pass.
- `npm run verify:report` renders the latest run, and `npm run verify:doc`
  regenerates [Verification Results](VERIFICATION.md) in both languages.
  To document a specific completed full run, pass its directory explicitly to
  `node scripts/verify/report.mjs <run-directory> --markdown` (or `--markdown=ko`);
  automatic latest-run selection can otherwise pick a focused or incomplete run.

`npm run verify` consumes real GitHub Copilot AI Credits; `npm test` does not.

Large multi-page PDF corpora, broad workflow fan-out, exact compact/rewind
boundary mapping, and crash-time in-flight tool recovery are outside the
automated scope.

LiteLLM is also outside the verification scope. Every slot starts
`src/server.mjs` directly and never starts LiteLLM, so the LiteLLM path in
[System Overview](#system-overview) and the [LiteLLM Guide](LITELLM.md) is a
configuration reference, not a validated path.

### Evidence Boundary

Historical manual validation records have been removed. Fresh verification must
use real Claude Code routed through the Copilot SDK, with native transcript and
actual SDK model/session evidence. A mock protocol test is not live compatibility
evidence. Provider-internal behavior beyond exposed SDK fields is not inferred.

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
