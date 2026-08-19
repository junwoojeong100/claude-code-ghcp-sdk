# Limitations and Production Gaps

## Support status

- GitHub와 Anthropic이 공동 지원하는 공식 Claude Code backend integration은 아닙니다.
- Copilot SDK의 pending external-tool RPC는 experimental입니다.
- 현재 pin된 `@github/copilot-sdk` package는 `1.0.10-preview.0`입니다.
- Anthropic은 gateway를 통한 non-Claude model routing을 공식 지원하지 않습니다.

## Protocol fidelity

현재 prototype에서 추가 hardening이 필요한 항목:

- exact `max_tokens`, stop sequence, temperature semantics
- extended-thinking signature와 encrypted reasoning round-trip
- server tools, citations, prompt-cache metadata
- exact token counting
- structured-output edge cases
- very large binary attachment limits
- retries, request idempotency, disconnect recovery
- Claude context compaction과 Copilot session history reconciliation
- dynamic tool-schema changes mid-session
- exhaustive parallel tool-call ordering
- Claude Code `--background` sessions; the launcher currently owns the bridge lifecycle

## Security

- Loopback 외 bind는 기본 차단되지만 remote deployment는 별도 TLS, user authentication, authorization이 필요합니다.
- Shared server deployment는 per-user GitHub OAuth token, tenant-isolated `COPILOT_HOME` 또는 session filesystem이 필요합니다.
- Managed settings can override command-line settings and may intentionally block provider switching.
- Prompt와 source code가 GitHub Copilot model service로 전송되므로 GitHub enterprise policy, content exclusion, data retention 조건을 확인해야 합니다.
- Claude Code 자체의 licensing과 Anthropic product terms도 별도로 확인해야 합니다.

## Billing

- Model usage는 GitHub Copilot AI Credits와 해당 plan 정책을 따릅니다.
- 이 경로는 Microsoft Foundry model consumption이 아닙니다.
- Azure에서 bridge를 운영할 수는 있지만 Claude model inference가 Azure Foundry에서 제공되는 것으로 표현하면 안 됩니다.
