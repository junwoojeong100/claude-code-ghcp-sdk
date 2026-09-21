# Claude Code with GitHub Copilot Models

> **Language / 언어:** English | [한국어](README_KO.md)

An Anthropic Messages API bridge that routes Claude Code's model calls to GitHub Copilot models via the GitHub Copilot SDK, either directly or through a LiteLLM proxy placed in front of the same bridge. Claude Code's UI, tool execution, permissions, hooks, MCP, and skills remain unchanged.

## Path Selection

| Situation | Path | Command |
|---|---|---|
| Use your GitHub Copilot account and organization model policy as-is | **Direct SDK** | `./bin/claude-ghcp` |
| Put an existing gateway, virtual keys, budgets, or request logging in front of the bridge | **LiteLLM** | `./bin/claude-litellm` |

**Most users should choose the Direct SDK path.** Choose LiteLLM only when your organization already operates a LiteLLM gateway, or when you need its virtual keys, budgets, and request logging. LiteLLM sits in front of the same bridge and adds a hop, not a capability. There is no need to configure both paths.

## Documentation

| Purpose | Document |
|---|---|
| Initial installation and first run | This README's [Direct SDK Quick Start](#direct-sdk-quick-start) |
| Put a LiteLLM proxy in front of the bridge | [LiteLLM Setup Guide](docs/LITELLM.md) |
| Review implementation, security boundaries, and validation scope | [Architecture](docs/ARCHITECTURE.md) |
| Distinguish implementable gaps from structural limits | [Compatibility](docs/COMPATIBILITY.md) |
| Review feature-by-feature evidence and coverage percentages | [Verification Results](docs/VERIFICATION.md) |

## Availability and Official Support Boundary

**Using GitHub Copilot models from Claude Code is possible, but not by registering the Copilot SDK as a model provider plugin inside Claude Code.** Claude Code sends requests in Anthropic Messages format to `ANTHROPIC_BASE_URL`, while the Copilot SDK communicates with the Copilot CLI server over JSON-RPC. This repository's bridge is therefore required to translate messages, SSE, and tool calls between the two protocols.

Claude Code documents connecting to third-party gateways that implement the supported API format, but Anthropic explicitly states it does not support routing non-Claude models through a gateway. This repository pins the stable `@github/copilot-sdk@1.0.14` release. The combination remains a technically working unofficial integration and is not jointly supported by Anthropic or GitHub. For detailed translation boundaries, see [Architecture](docs/ARCHITECTURE.md#integration-rationale-and-boundaries).

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
- GitHub Copilot CLI's `copilot` command for sign-in and launcher checks
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

If the Copilot CLI is not already installed:

```bash
npm install -g @github/copilot
```

```bash
copilot login
```

No separate Anthropic API key is required.

SDK 1.0.14 includes its own platform-specific Copilot runtime (1.0.85); it no
longer installs the `@github/copilot` CLI package as a dependency. Install the
Copilot CLI separately if `copilot` is not on PATH. The bridge uses the SDK's
bundled runtime by default; `COPILOT_CLI_PATH` can explicitly select an existing
CLI installation. Changing the runtime requires repeating compatibility checks.

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

If permitted by your account and organization policy, GPT-6 Astra and the following GPT-5.6 models are also available:

```bash
./bin/claude-ghcp --ghcp-model gpt-6-astra
./bin/claude-ghcp --ghcp-model gpt-5.6-sol
./bin/claude-ghcp --ghcp-model gpt-5.6-terra
./bin/claude-ghcp --ghcp-model gpt-5.6-luna
```

GPT-6 Astra is configured with a 1,178,000-token context; the three GPT-5.6
models use 1,050,000 tokens, as listed in the Copilot catalog.

The model list is discovered dynamically, not limited to a fixed set of 16.
When available to your account, `/model` includes
`GitHub Copilot · GPT-6 Astra (gpt-6-astra)`. Restart an existing Claude Code
session to refresh discovery after new models become available.

The current full-feature validation matrix is exactly `claude-opus-5`, `claude-sonnet-5`,
`claude-haiku-4.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, and
`gpt-6-astra`. Historical validation records have been reset; only fresh
execution evidence establishes compatibility. All seven carry the same eleven
scenarios — there is no reduced smoke-test tier for any model. See the
[verification results](docs/VERIFICATION.md).
`gpt-5.5` and other catalog models are not part of that verification. Catalog
visibility alone does not guarantee tool, image, reasoning, or other feature
compatibility for every model.

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

LiteLLM is a proxy placed in front of this repository's bridge. It does not replace the bridge or `@github/copilot-sdk`; it adds virtual keys, budgets, and request logging in front of them.

```text
Claude Code
  -> LiteLLM /v1/messages
  -> this repository's local bridge
  -> @github/copilot-sdk
  -> GitHub Copilot model
```

LiteLLM reaches the bridge through its `anthropic/*` provider, with `api_base` set to the bridge root. LiteLLM's own `github_copilot/*` provider is not used, and there is no separate LiteLLM-side GitHub device OAuth.

Whoever operates the gateway also operates the bridge, and therefore needs `npm install`, a `copilot login` session, and a running bridge daemon. When you are only connecting to a gateway that someone else operates, clone the repository — `npm install` and `copilot login` are not required.

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

`LITELLM_MODEL` is a `model_name` alias from the gateway's configuration. To serve GitHub Copilot models, that alias must resolve to `model: anthropic/<copilot-model-id>` with `api_base` set to this repository's bridge root. Aliases pointing anywhere else do not use GitHub Copilot.

The bridge binds to loopback unless `ALLOW_NON_LOOPBACK=1` is set, so LiteLLM runs on the same host as the bridge it fronts. If that host also runs `claude-ghcp`, export the same `GHCP_BRIDGE_PORT` in both shells. The requested port is part of the daemon's configuration fingerprint, so a launcher started without it stops the pinned daemon and starts a new one on a new port with a new token, and LiteLLM gets connection refused.

LiteLLM is outside this repository's verification scope. The `npm run verify` matrix (7 models x 11 scenarios = 77 slots) starts `src/server.mjs` directly and never starts LiteLLM, so the LiteLLM path is a configuration reference, not a validated path.

For the bridge daemon, its pinned port and token, the example configuration, model mapping, multi-user authentication, and troubleshooting, follow the [LiteLLM Guide](docs/LITELLM.md).

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

The Direct SDK bridge defaults to **256 MiB (268,435,456 bytes)** for both HTTP request bodies (`MAX_BODY_BYTES`) and replayed conversation history (`MAX_REPLAY_BYTES`). Export either variable to override its limit. Larger limits can increase memory use; they do not expand the model's context window. Changes take effect when the bridge next starts, not in an already running bridge.

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
| Text, native `Read` tool | Implemented; fresh execution evidence required |
| SSE, Anthropic Messages translation | Implemented; regression tests available |
| Reasoning effort, Ultracode `xhigh` routing | Implemented with model capability mapping |
| `Edit`, `Write`, `NotebookEdit`, `Bash`, hooks, plugins, skills, local MCP | Native feature E2E runner available |
| Image/document translation | Initial attachments implemented; provider limits apply |
| Root/subagent session isolation | Implemented using Claude session and agent IDs |
| SDK resume | Resume/fork and history-shrink reconciliation implemented; in-flight crash recovery remains best-effort |
| Token counting | Actual post-call SDK usage; `/count_tokens` preflight remains an explicit estimate |
| Sampling and generation controls | Unsupported native controls are diagnosed; `tool_choice` has bounded filtering/prompt emulation |
| MCP tool search | Full-schema default; native ToolSearch available by explicit opt-in |
| `--json-schema` structured output | Uses Claude Code's native validator/retry |
| Remote Control | Disabled by Claude Code when a custom `ANTHROPIC_BASE_URL` is set |
| `--background`/agent view | Supported through the private persistent bridge daemon |
| Claude web/cloud, `--cloud`, `--teleport`, cloud ultrareview | Outside the local execution path; the GHCP bridge is not used |
| Reasoning text/signature, citations, prompt-cache metadata | Full round-trip not supported |

Running the launch scripts directly from the integrated terminal in VS Code or JetBrains uses the same path. The scripts are not automatically applied to Claude Code processes started by IDE extensions, Claude Desktop, or cloud sessions.

## Validation

### 2026-09-22 closeout (KST)

The second full run below is the final live verification for this closeout.
**Strict result: NOT GREEN.** Both full runs finalized with exactly 77 unique
expected records and no missing, duplicate or unexpected slots. Results remain
separate; passes from different runs are not combined into an all-pass matrix.

- Offline tests: **280/280 passed** (0 failed, cancelled or skipped).
- Focused Haiku verification: **3/3 passed**, meaning three repetitions of
  `claude-haiku-4.5` × `v04-shell-ops`, not three different scenarios or a full-matrix pass.

| Full run | Run ID (UTC) | Pass / fail / blocked / unknown | Duration | User-settings integrity |
|---|---|---|---|---|
| First — NOT GREEN | `2026-09-21T22-54-08-294Z` | 76 / 1 / 0 / 0 | 456 s | Before/after digests differ; writer and cause unknown |
| Second, final — NOT GREEN | `2026-09-21T23-07-19-056Z` | 74 / 2 / 1 / 0 | 863 s | Before/after digests match |

Remaining non-passes:

- First run: Sonnet `v09-session-resume` failed build-ID recall, context-only
  answering (it used `Write`/`Read`), and fork-context inheritance checks.
- Second run: Sonnet `v09-session-resume` failed the fork-context inheritance
  check; Opus `v09-session-resume` failed the resumed-turn usage check (`input=0`);
  Haiku `v05-multi-step` was **blocked** after a 602 s main-turn timeout, with
  0/4 requested edits landed and neither attachment token returned.

Both runs recorded the same start/end commit
`3b42a61af1d461f3aa6c9bcc807fcb7afdfdd4e1` (dirty checkout) and identical
41-file `verification-code-v1` SHA-256 fingerprint:
`0101162ad82ba5f80f123368628f64a325b17dc79eb9ef47897385e9dd2b0f6e`.
The implementation matched within and across runs; the first run's settings
change is a separate integrity failure, not an attributed root cause.

Both generated verification documents use **only the second full run**. Raw
local evidence remains ignored under `.verify-runs/`: `summary.json` and
`slots.jsonl` in each run directory above; final console
`worktree-full-2-5VAuJx` (lines 94–99); offline log `offline-handoff-kBZzxb`
(lines 1688–1695); focused logs `worktree-focused-1.ERWlLC`,
`worktree-focused-2.BLp7uS`, and `worktree-focused-3.AARTsW` (lines 16–24 each).
No additional fixes, tests or live reruns were performed during this documentation
closeout; unresolved outcomes are retained, not waived.

```bash
# Unit and structural tests. No model calls, no credits.
npm test

# Full verification matrix: 11 scenarios x 7 models = 77 live slots (timeout scale: 1)
npm run verify

# Longer verification waits; overrides apply only to this command
PENDING_TOOL_WAIT_MS=30000 npm run verify -- --timeout-scale 2

# One cell, while iterating on a driver
npm run verify -- --models claude-opus-5 --scenarios v04-shell-ops

# Plan, coverage and single-turn schedule estimate. Starts nothing.
npm run verify -- --dry-run
PENDING_TOOL_WAIT_MS=30000 npm run verify -- --timeout-scale 2 --dry-run

# Keep slot workspaces for a post-mortem instead of deleting them
npm run verify -- --scenarios v08-hooks-memory --keep-workspaces

# Re-read the newest run from its own record
npm run verify:report

# Regenerate docs/VERIFICATION.md and docs/VERIFICATION_KO.md from the newest run
npm run verify:doc
```

Automatic newest-run selection can pick a focused or incomplete run. To publish
results from a specific completed full run, select its local artifact directory
explicitly and use the same directory for both languages:

```bash
run_dir=".verify-runs/<completed-run-id>"
node scripts/verify/report.mjs "$run_dir"
node scripts/verify/report.mjs "$run_dir" --markdown > docs/VERIFICATION.md
node scripts/verify/report.mjs "$run_dir" --markdown=ko > docs/VERIFICATION_KO.md
```

`--timeout-scale` defaults to `1`, so the unchanged `npm run verify` command
keeps the existing verification budgets. `2` doubles the verification runner's
model-facing waits (headless turns, plan turns and v11 launcher/output waits)
and its bridge-health wait. For v01–v10, a scenario timeout applies **per headless
turn/invocation, not per slot**; multi-turn slots can use several such waits.
v11's catalog-derived `scenarioMs` value is **planning only**: its actual waits
use the independent launcher/output limits. Status/list/stop/final-cleanup
wrappers, polls/probes, the local-test limit, SIGKILL grace and operational
launcher/daemon startup defaults stay unchanged.

The command-scoped `PENDING_TOOL_WAIT_MS=30000` override sets a separate 30-second
pending-tool wait; it is not multiplied by `--timeout-scale` or saved as a runtime
default. It is a precaution for verification, **not an established fix for
no-result exits**. `--model-concurrency` and `--scenario-concurrency` control model
workers and scenario workers per model (defaults: `7` and `2`). Dry-run single-turn
schedule estimates are planning aids, **not deadlines or true worst-case bounds**.

`npm run verify` consumes real GitHub Copilot AI Credits. Every slot runs the
real path end to end: the real Claude Code binary, the bridge, the Copilot SDK,
and a real model. Nothing is mocked or replayed. Each slot gets its own bridge,
port, token, `CLAUDE_CONFIG_DIR` and git workspace, so one model's stall cannot
be read as another's failure. The runner reads only a before/after digest of
`~/.claude/settings.json` to check that it was not changed; it never stores that
file's contents or uses it as a slot's settings.

Slots are judged on primary evidence — files on disk, git history, hook logs,
and the stream's own record of which tools ran. Model prose is only ever checked
for a planted token, never for style, structure, or agreement. The serving model
is read back from `result.modelUsage`, so a silently substituted backend fails
the slot instead of passing it.

`blocked` is not a pass. A timeout, a dead bridge, or an unpaired
`tool_use`/`tool_result` stays in the denominator. New runs use the
`strict-all-pass-v1` policy: **77 of 77** for the full matrix, or every selected
slot for an explicitly **focused** run. The runner fixes the expected unique
model × scenario set before execution and exits non-zero for any missing,
duplicate, unexpected, failed, blocked or unknown-outcome slot. Empty matrices,
invalid concurrency values, and empty/duplicate/unknown selections are rejected
before artifacts or model calls. Weighted feature coverage describes the selected
scenario catalogue, **not the pass rate**; a focused pass is not a full-matrix pass.

`summary.json` records the policy, expected and actual totals, full/focused scope,
and local git commit/dirty state at the start and end. A deterministic SHA-256
fingerprint includes tracked and relevant untracked implementation files in
`src/`, `scripts/verify/`, `bin/` and the root package files; logs, run artifacts
and generated documentation are excluded. Changed code/commit, changed user
settings, or missing provenance prevents green even if every slot passed. A dirty
checkout may pass when the recorded implementation stays unchanged. Terminal and
EN/KO reports use the same strict assessment as the runner. Older summaries keep
their **legacy stored gate and green** explicitly; they are never relabelled as
strict all-pass results, and missing metadata is not reconstructed as success.

Neither command covers LiteLLM. `npm run verify` starts `src/server.mjs`
directly and never starts LiteLLM, so the LiteLLM path is a configuration
reference rather than a validated one.

[Verification results](docs/VERIFICATION.md) records the latest full matrix, what
each scenario is for, and the bridge defect each one is built to catch. It is
generated from a run's own record; regenerating overwrites it. Terminal and EN/KO
reports also read `summary.execution` to show the recorded timeout scale,
pending-tool wait, concurrency and actual configured per-scenario/per-step limits.
Reproduction commands include those recorded overrides; older runs without this
metadata are marked as not recorded rather than filled with today's defaults.

For the scope each command validates, see the
[Validation Scope in the Architecture document](docs/ARCHITECTURE.md#validation-scope).
`GHCP_NATIVE_TOOL_SEARCH=1` explicitly enables Claude Code's native ToolSearch;
the default remains the existing full-schema fallback.

## Support Status

This project is a working prototype and is not an officially supported integration jointly maintained by GitHub and Anthropic. The project pins the stable Copilot SDK 1.0.14 release; a stable SDK does not make this bridge an officially supported Claude Code integration.

For implementation scope, security, and production constraints, see the [Architecture document](docs/ARCHITECTURE.md).

| Use case | Recommendation |
|---|---|
| Personal experimentation and research | Suitable |
| Using Copilot models from the Claude Code UI | Core path is functional |
| General coding tasks | Use after verifying the required tool combinations end-to-end |
| Mission-critical or long-running automation | Use after strengthening recovery, session cleanup, and per-feature validation |
| Environments requiring official support or an SLA | Not suitable |
