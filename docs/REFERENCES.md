# References

Official sources used for the implementation:

- [GitHub Copilot SDK](https://github.com/github/copilot-sdk)
- [Copilot SDK multi-tenancy and `mode: empty`](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/multi-tenancy)
- [Copilot SDK Node.js API](https://github.com/github/copilot-sdk/blob/main/nodejs/README.md)
- [Copilot SDK manual external-tool handoff sample](https://github.com/github/copilot-sdk/blob/main/nodejs/samples/manual-tool-resume.ts)
- [Copilot SDK streaming events](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events)
- [Copilot SDK authentication](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate)
- [GitHub Copilot supported models](https://docs.github.com/en/copilot/reference/ai-models/supported-models)
- [Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol)
- [Claude Code gateway configuration](https://code.claude.com/docs/en/llm-gateway-connect)
- [Claude Code settings precedence](https://code.claude.com/docs/en/settings)
- [LiteLLM Claude Code quickstart](https://docs.litellm.ai/docs/tutorials/claude_responses_api)
- [LiteLLM Anthropic Messages endpoint](https://docs.litellm.ai/docs/anthropic_unified)
- [LiteLLM GitHub Copilot provider](https://docs.litellm.ai/docs/providers/github_copilot)
- [LiteLLM Claude Code compatibility matrix](https://docs.litellm.ai/docs/claude_code_compatibility)

This project does not depend on undocumented GitHub Copilot HTTP endpoints. Model access is through the public GitHub Copilot SDK and the user or organization's supported authentication path.
