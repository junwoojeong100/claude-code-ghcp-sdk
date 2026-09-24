# Claude Code Compatibility

> **Language / 언어:** English | [한국어](COMPATIBILITY_KO.md)

This document separates three different claims:

1. **Supported:** implemented by the bridge or preserved by the local Claude Code
   process.
2. **Implementable:** not fully covered yet, but can be added in this repository.
3. **Structural limit:** depends on an Anthropic account service or model-provider
   capability that cannot be recreated by an Anthropic Messages compatibility
   bridge.

The project must not describe a structural limit as backlog that can be solved by
adding another request translation.

## Structural Limits

| Feature | Why the bridge cannot provide native equivalence | Available alternative |
|---|---|---|
| Remote Control | Claude Code disables Remote Control when `ANTHROPIC_BASE_URL` points to a non-Anthropic host. The session rendezvous and mobile/web clients are Anthropic account services. | Use the local terminal or an IDE terminal. |
| Claude Code on the web, `--cloud`, Teleport, mobile sessions | These run on Anthropic-managed infrastructure and require a claude.ai account session. | Keep execution local or use an officially supported Claude provider. |
| Artifacts, cloud ultrareview, routines, Desktop scheduled tasks | Publishing, scheduling, and cloud multi-agent execution are claude.ai services rather than Messages API operations. | Use local files, local agents, and an external scheduler. |
| Anthropic Analytics, billing, subscription usage, SSO/SCIM | These are Anthropic account and organization APIs. Copilot usage is accounted for by GitHub instead. | Use GitHub Copilot usage and organization reporting. |
| Anthropic server-side WebSearch, auto-mode classifier, Channels, account-managed MCP connectors | These depend on first-party server components that are not represented in the gateway Messages API. | Use local `WebFetch`, explicit MCP servers, and local permission modes. |
| Anthropic prompt caching | `cache_control` breakpoints and the cache they control belong to the Anthropic model service. The Copilot SDK has no cache-breakpoint control, so the markers have no effect. | The bridge reports Copilot's own cache read/write token counts as `cache_read_input_tokens` and `cache_creation_input_tokens`. They describe Copilot's cache, not Anthropic's. |
| Encrypted thinking signatures and Anthropic reasoning blocks | The Copilot SDK emits provider reasoning events, but it cannot mint the cryptographic signatures that Anthropic thinking blocks carry. | Reasoning effort is forwarded. The request's `thinking` field is ignored, and responses contain no thinking blocks: provider reasoning deltas only keep the turn's idle timer alive. |
| Exact Anthropic sampling semantics | The pinned Copilot SDK `SessionConfig` and `MessageOptions` do not expose native `temperature`, `top_p`, `max_tokens`, `stop_sequences`, or Anthropic `tool_choice`. Prompt-based emulation is not equivalent. | The four sampling controls are accepted but not applied; see [Unsupported Controls](#unsupported-controls). `tool_choice` is emulated with tool filtering and a system instruction. |
| Anthropic model availability, safety fallback, and Fable consent | These checks are tied to Anthropic organization policy and billing. | Use the GitHub Copilot model catalog and organization policy. |

## Implemented Compatibility Work

The following gaps are not structural and now have an implementation or a
bounded compatibility path in this repository:

- A persistent loopback bridge daemon for Claude Code background agents and
  agent view, with private registry permissions, locking, status, stop, and
  stale cleanup. Claude Code's separate transient daemon remains under Claude
  Code lifecycle management.
- Actual post-call token usage from Copilot SDK events, while preflight token
  counting remains explicitly marked as estimated
- History-shrink reconciliation, completed-tool cache invalidation, bounded
  cold replay, state split diagnostics, and state LRU/TTL cleanup
- Claude Code's native structured-output validator/retry through the bridge
- Safe full-schema fallback for local MCP tools, plus explicit native Claude Code
  ToolSearch opt-in with `GHCP_NATIVE_TOOL_SEARCH=1`. Tool references are preserved;
  full provider-side deferral equivalence remains a documented limitation.
- Native inline system instructions (including custom-agent definitions and output
  styles) are forwarded without treating token-budget or cache-control metadata
  changes as conversation rewinds.
- Request cancellation: a client disconnect drops a queued request before it
  starts, and calls `CopilotSession.abort()` on a turn that is already running
- Live E2E coverage for Edit, Write, NotebookEdit, Bash, permissions, hooks,
  skills, plugins, MCP, multimodal input, worktrees, sessions, streams, cron,
  subagents, and the launcher, daemon, and background agents; see
  [VERIFICATION.md](VERIFICATION.md)

Remaining caveats, such as exact native sampling semantics and recovery of a
turn that was in flight when the bridge crashed, are listed in the README
[Support Scope](../README.md#support-scope) table. These implementations do not
change the structural limits above.

## IDE Clarification

Remote Control and IDE integration are different features. Running `claude` from
the integrated terminal in VS Code or JetBrains uses this bridge. An IDE extension
that launches its own Claude Code process does not automatically inherit this
repository's wrapper or temporary settings; it must be configured to invoke the
wrapper or receive equivalent environment settings.

## Unsupported Controls

A request that asks for a control the Copilot SDK cannot represent is either
rejected or accepted and reported. The bridge never applies an approximation
and calls it Anthropic-equivalent.

- **Rejected with 400 `invalid_request_error`:** a `tool_choice` that cannot be
  met (`any` or `tool` with no declared tools, `tool` naming an undeclared tool,
  or an unknown mode).
- **Emulated:** `tool_choice: none` removes the tools. `tool_choice: tool` keeps
  only the named tool, and `tool` and `any` add a system instruction to call it.
  The model can still answer without a tool call.
- **Accepted, not applied, and reported:** `temperature`, `top_p`, `max_tokens`,
  and `stop_sequences`. Rejecting them would fail ordinary Claude Code requests,
  which always set `max_tokens`. Each request that sets one logs
  `bridge.degraded_controls`, and `GET /health` lists them as
  `unsupportedNativeControls`.
- **Accepted and ignored:** fields nothing downstream reads, such as `thinking`,
  `top_k`, `metadata`, and `output_config.format`. They are logged as
  `ignoredFields` on the same diagnostic and listed as `ignoredRequestFields` in
  `GET /health`.

The report goes to the bridge log and `GET /health` only. The response to
Claude Code carries no marker, so a caller that needs these guarantees must
check the bridge, not the response.

Relevant official references:

- [Claude Code feature availability](https://code.claude.com/docs/en/feature-availability)
- [Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol)
- [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control)
- [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web)
- [Claude Code model configuration](https://code.claude.com/docs/en/model-config)
