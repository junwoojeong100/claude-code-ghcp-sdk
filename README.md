# Claude Code with GitHub Copilot Models

> **Language / 언어:** English | [한국어](README_KO.md)

An Anthropic Messages API bridge that routes Claude Code's model calls to GitHub Copilot models via the GitHub Copilot SDK or LiteLLM. Claude Code's UI, tool execution, permissions, hooks, MCP, and skills remain unchanged.

## Path Selection

| Situation | Path | Command |
|---|---|---|
| Use your GitHub Copilot account and organization model policy as-is | **Direct SDK** | `./bin/claude-ghcp` |
| Use an existing gateway, virtual key, or a different provider | **LiteLLM** | `./bin/claude-litellm` |

**Most users should choose the Direct SDK path.** Choose LiteLLM only when your organization already operates a LiteLLM gateway or requires a different provider. There is no need to configure both paths.

## Documentation

| Purpose | Document |
|---|---|
| Initial installation and first run | This README's [Direct SDK Quick Start](#direct-sdk-quick-start) |
| Configure a LiteLLM client or gateway | [LiteLLM Setup Guide](docs/LITELLM.md) |
| Review implementation, security boundaries, and validation scope | [Architecture](docs/ARCHITECTURE.md) |
| Distinguish implementable gaps from structural limits | [Compatibility](docs/COMPATIBILITY.md) |
| Review feature-by-feature evidence and coverage percentages | [Feature Coverage](docs/FEATURE_COVERAGE.md) |

## Availability and Official Support Boundary

**Using GitHub Copilot models from Claude Code is possible, but not by registering the Copilot SDK as a model provider plugin inside Claude Code.** Claude Code sends requests in Anthropic Messages format to `ANTHROPIC_BASE_URL`, while the Copilot SDK communicates with the Copilot CLI server over JSON-RPC. This repository's bridge is therefore required to translate messages, SSE, and tool calls between the two protocols.

Claude Code documents connecting to third-party gateways that implement the supported API format, but Anthropic explicitly states it does not support routing non-Claude models through a gateway. The GitHub Copilot SDK itself is currently GA, but this repository pins `@github/copilot-sdk@1.0.10-preview.0`, which includes the required APIs. This combination is therefore a technically working unofficial integration and is not jointly supported by Anthropic or GitHub. For detailed translation boundaries, see [Architecture](docs/ARCHITECTURE.md#integration-rationale-and-boundaries).

## Direct SDK Quick Start

```text
Claude Code
  -> this repository's local bridge
  -> @github/copilot-sdk
  -> GitHub Copilot model
```

### Prerequisites

- macOS or Linux
- Claude Code's `claude` command
- Node.js `^20.19.0` or `>=22.12.0`
- Git
- GitHub Copilot access
- A model permitted by your organization's Copilot model policy

The Windows default shell is not supported. Ultracode requires Claude Code 2.1.203 or later.

### 1. Installation

```bash
git clone https://github.com/junwoojeong100/claude-code-ghcp-sdk.git
cd claude-code-ghcp-sdk
npm install
```

### 2. GitHub Copilot Sign-in

```bash
npx copilot login
```

No separate Anthropic API key is required.

### 3. Verify Environment and Models

```bash
./bin/ghcp-doctor
./bin/ghcp-models
```

Confirm that both commands succeed and that the model you intend to use appears in the `ghcp-models` output.

### 4. Run Claude Code

```bash
# Default model: GitHub Copilot's Claude Sonnet 5
./bin/claude-ghcp

# Select a different model
./bin/claude-ghcp --ghcp-model claude-haiku-4.5

# Non-interactive prompt
./bin/claude-ghcp \
  --ghcp-model claude-haiku-4.5 \
  -p "Describe the structure of this repository"
```

If permitted by your account and organization policy, the following GPT-5.6 models are also available:

```bash
./bin/claude-ghcp --ghcp-model gpt-5.6-sol
./bin/claude-ghcp --ghcp-model gpt-5.6-terra
./bin/claude-ghcp --ghcp-model gpt-5.6-luna
```

All three models are configured with a 1,050,000-token context as listed in the Copilot catalog.

### 5. Optional: Add `claude` to PATH

To run from any directory, add the repository's `bin` directory to your PATH from the repository root. Example for Zsh:

```bash
echo "export PATH=\"$PWD/bin:\$PATH\"" >> ~/.zshrc
exec zsh
```

For other shells, add the same value to the appropriate shell configuration file.

Verify the configuration:

```bash
command -v claude
# <clone-path>/claude-code-ghcp-sdk/bin/claude
```

After this, `claude` will use the Direct SDK launch script from this repository.

```bash
claude
claude --ghcp-model claude-haiku-4.5
```

To change the default model:

```bash
export GHCP_MODEL=claude-haiku-4.5
claude
```

To run with the original Claude Code provider:

```bash
claude-current
```

### Models and Reasoning Effort

Check the models available to your account and their supported features before specifying a reasoning effort.

```bash
./bin/ghcp-models --json

./bin/claude-ghcp --ghcp-model gpt-5.6-sol --effort high
./bin/claude-ghcp --ghcp-model gpt-5.6-sol --effort ultracode
```

`/effort` and `--effort` are forwarded to the Copilot SDK. If the selected model does not support the specified value, it is adjusted down to the nearest supported level. No value is forwarded to models that do not support reasoning effort. GPT-5.6 Sol, Terra, and Luna currently support `none`, `low`, `medium`, `high`, `xhigh`, and `max`.

Ultracode is available only on models that support `xhigh` and may consume more GitHub Copilot AI Credits than a standard call. For details on the `/model` picker and effort translation, see the [Architecture document](docs/ARCHITECTURE.md#model-discovery-and-context).

Standard sessions support subagents and dynamic workflows. `--background` and
the `agents` view automatically use a persistent loopback bridge. Inspect or
stop it with `claude-ghcp-status` and `claude-ghcp-stop`.

## LiteLLM Quick Start

LiteLLM is a separate path that does not use the local Node.js bridge or `@github/copilot-sdk`.

```text
Claude Code
  -> LiteLLM /v1/messages
  -> provider configured in LiteLLM
```

When connecting to an existing LiteLLM gateway, only clone the repository — `npm install` and `copilot login` are not required.

```bash
git clone https://github.com/junwoojeong100/claude-code-ghcp-sdk.git
cd claude-code-ghcp-sdk
```

Set the base URL, scoped virtual key, and model alias provided by your administrator:

```bash
export LITELLM_BASE_URL="https://litellm.example.com"
export LITELLM_API_KEY="<scoped-virtual-key>"
export LITELLM_MODEL="claude-sonnet-5"

./bin/claude-litellm
```

To use GitHub Copilot models, the model alias must be connected to a `github_copilot/claude-*` backend. Aliases connected to other providers do not use GitHub Copilot.

For local gateway installation, GitHub device OAuth, model mapping, multi-user authentication, and troubleshooting, follow the [LiteLLM Guide](docs/LITELLM.md).

## Command Reference

| Purpose | Command |
|---|---|
| Use the GitHub Copilot SDK directly | `./bin/claude` or `./bin/claude-ghcp` |
| List permitted Copilot models | `./bin/ghcp-models` |
| Diagnose the GHCP environment | `./bin/ghcp-doctor` |
| Inspect the persistent bridge | `./bin/claude-ghcp-status` |
| Stop the persistent bridge | `./bin/claude-ghcp-stop` |
| Use the LiteLLM gateway | `./bin/claude-litellm` |
| Use the original Claude Code provider | `./bin/claude-current` |

Use `--ghcp-model` instead of `--model` with `claude-ghcp`. All other Claude Code options and prompts are passed through unchanged. If `bin` is in your PATH, the `./bin/` prefix can be omitted.

### Configuration Inputs

Command-line options take precedence over environment variables. This repository does not automatically load `.env` files; `export` values in your current shell or specify them before the command. `.env.example` is a reference list of available environment variables.

| Path | Required | Optional |
|---|---|---|
| Direct SDK | none | `--ghcp-model` / `GHCP_MODEL`, `--bridge-port` / `GHCP_BRIDGE_PORT` |
| LiteLLM | `LITELLM_BASE_URL`, `LITELLM_API_KEY` | `--litellm-model` / `LITELLM_MODEL` |

## Configuration and Support Scope

### Settings Preservation

The launch scripts do not modify `~/.claude/settings.json`. A temporary settings file with `0600` permissions records only the values needed for gateway routing. Existing theme, permissions, hooks, plugins, skills, MCP, and project settings continue to be loaded.

On exit, the Direct path removes the local bridge and the temporary credentials and settings; the LiteLLM path removes the temporary settings.

Managed settings take precedence over the temporary settings written by the launch scripts. If an organization policy enforces a provider selector, `availableModels`, or MCP tool search, the launch scripts do not override it.

### Support Scope

The table below shows the current status for the Direct SDK path.

| Feature | Status |
|---|---|
| Terminal UI, permissions, user/project settings | Handled by Claude Code |
| Text, native `Read` tool | Verified end-to-end with a real model |
| SSE, Anthropic Messages translation | Verified by unit tests |
| Reasoning effort, Ultracode `xhigh` routing | Verified by unit tests and local protocol checks |
| `Edit`, `Write`, `NotebookEdit`, `Bash`, hooks, plugins, skills, local MCP | Verified by feature E2E |
| Image/document translation | Image and valid PDF verified by live E2E |
| Root/subagent session isolation | Verified by unit tests and six-model Agent→`Read` E2E |
| SDK resume | Resume/fork and history-shrink reconciliation implemented; in-flight crash recovery remains best-effort |
| Token counting | Actual post-call SDK usage; `/count_tokens` preflight remains an explicit estimate |
| Sampling and generation controls | Unsupported native controls are diagnosed; `tool_choice` has bounded filtering/prompt emulation |
| MCP tool search | Copilot SDK-side tool search enabled; native Claude `tool_reference` round-trip remains provider-dependent |
| `--json-schema` structured output | Claude Code validator/retry verified through the bridge by live E2E |
| Remote Control | Disabled by Claude Code when a custom `ANTHROPIC_BASE_URL` is set |
| `--background`/agent view | Supported through the private persistent bridge daemon |
| Claude web/cloud, `--cloud`, `--teleport`, cloud ultrareview | Outside the local execution path; the GHCP bridge is not used |
| Reasoning text/signature, citations, prompt-cache metadata | Full round-trip not supported |

Running the launch scripts directly from the integrated terminal in VS Code or JetBrains uses the same path. The scripts are not automatically applied to Claude Code processes started by IDE extensions, Claude Desktop, or cloud sessions.

## Validation

```bash
# Unit tests
npm test

# Direct SDK E2E: text + Read tool
npm run test:e2e

# GPT-5.6 Sol, Terra, Luna E2E
npm run test:e2e:gpt-5.6

# Running local LiteLLM E2E
npm run test:e2e:litellm
```

E2E tests consume real GitHub Copilot AI Credits. Tests fail if the existence or content hash of `~/.claude/settings.json` changes before and after the run.

For the exact scope each command validates, see the [Validation Scope in the Architecture document](docs/ARCHITECTURE.md#validation-scope).

## Support Status

This project is a verified working prototype and is not an officially supported integration jointly maintained by GitHub and Anthropic. The Copilot SDK upstream is GA, but the package pinned by this project is a preview release.

For implementation scope, security, and production constraints, see the [Architecture document](docs/ARCHITECTURE.md).

| Use case | Recommendation |
|---|---|
| Personal experimentation and research | Suitable |
| Using Copilot models from the Claude Code UI | Core path is functional |
| General coding tasks | Use after verifying the required tool combinations end-to-end |
| Mission-critical or long-running automation | Use after strengthening recovery, session cleanup, and per-feature validation |
| Environments requiring official support or an SLA | Not suitable |
