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
| Native Anthropic prompt-cache metadata | `cache_control` accounting and cache read/write metadata are produced by the Anthropic model service. | Copilot may apply its own provider cache, but the bridge cannot report Anthropic cache semantics. |
| Encrypted thinking signatures and Anthropic reasoning blocks | Copilot SDK can expose model-specific reasoning events or summaries, but it cannot mint Anthropic cryptographic thinking signatures. | Forward effort and, where available, expose provider reasoning summaries as non-signed text. |
| Exact Anthropic sampling semantics | The pinned Copilot SDK `SessionConfig` and `MessageOptions` do not expose native `temperature`, `top_p`, `max_tokens`, `stop_sequences`, or Anthropic `tool_choice`. Prompt-based emulation is not equivalent. | Validate unsupported controls explicitly or provide documented best-effort emulation. |
| Anthropic model availability, safety fallback, and Fable consent | These checks are tied to Anthropic organization policy and billing. | Use the GitHub Copilot model catalog and organization policy. |

## Implemented Compatibility Work

The following gaps are not structural and now have an implementation or a
bounded compatibility path in this repository:

- A persistent loopback bridge daemon for Claude Code background agents and
  agent view, with private registry permissions, locking, status, stop, and
  stale cleanup
- Actual post-call token usage from Copilot SDK events, while preflight token
  counting remains explicitly marked as estimated
- History-shrink reconciliation, completed-tool cache invalidation, bounded
  cold replay, state split diagnostics, and state LRU/TTL cleanup
- Claude Code's native structured-output validator/retry, verified through the
  bridge with a live model
- Copilot SDK-side tool search and a full-schema fallback for local MCP tools
- Request cancellation to `CopilotSession.abort()`
- Live E2E coverage for Edit, Write, NotebookEdit, Bash, permissions, hooks,
  skills, plugins, MCP, multimodal input, worktrees, sessions, streams, cron,
  and subagents

Remaining caveats, such as exact native sampling semantics and crash-atomic
in-flight recovery, are recorded in the feature coverage matrix. These
implementations do not change the structural limits above.

## IDE Clarification

Remote Control and IDE integration are different features. Running `claude` from
the integrated terminal in VS Code or JetBrains uses this bridge. An IDE extension
that launches its own Claude Code process does not automatically inherit this
repository's wrapper or temporary settings; it must be configured to invoke the
wrapper or receive equivalent environment settings.

## Unsupported Controls

When a request asks for provider controls that cannot be represented by the
Copilot SDK, the bridge should fail explicitly or label the behavior as
best-effort. It must not silently claim Anthropic-equivalent semantics.

Relevant official references:

- [Claude Code feature availability](https://code.claude.com/docs/en/feature-availability)
- [Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol)
- [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control)
- [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web)
- [Claude Code model configuration](https://code.claude.com/docs/en/model-config)
