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
- `curl` and Git
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

# Print mode (-p): answer one prompt, then exit
./bin/claude-ghcp \
  --ghcp-model claude-haiku-4.5 \
  -p "Describe the structure of this repository"
```

If permitted by your account and organization policy, the following GPT-6 models are also available:

```bash
./bin/claude-ghcp --ghcp-model gpt-6-astra
./bin/claude-ghcp --ghcp-model gpt-6-sol
./bin/claude-ghcp --ghcp-model gpt-6-luna
```

The Copilot catalog advertises 1,050,000 tokens for GPT-6 Astra and 1,000,000
for GPT-6 Sol and Luna (872,000 of which are prompt tokens). The launcher uses
Claude Code's model-scoped **1M** context hint for these three models and for
Claude Opus 5.5 and Claude Sonnet 5, rather than a process-wide context
override; behind a gateway, Claude Code would otherwise budget a bare
`claude-opus-5-5` or `claude-sonnet-5` at 200K. Changing models therefore does
not carry the startup model's window into the next model; native smaller
windows and automatic compaction remain in effect.

The Direct SDK `/model` picker is pinned to the **six primary models below**,
plus Claude Code's own `Default` row, which it always keeps. Temporary
`modelPicker` settings replace the built-in and discovered lineups, so older
models and newly discovered catalog entries do not reappear as extra choices.
This is picker curation, not an authorization allowlist: `ghcp-models` still
lists the broader catalog, explicit `--ghcp-model` requests retain their
existing routing, and account policy still controls model access. Restart an
existing session to load the new picker.

| Picker row | Copilot model | Claude Code window |
|---|---|---|
| GitHub Copilot · Claude Opus 5.5 | `claude-opus-5.5` | 1M (model-scoped hint) |
| GitHub Copilot · Claude Sonnet 5 | `claude-sonnet-5` | 1M (model-scoped hint) |
| GitHub Copilot · Claude Haiku 4.5 | `claude-haiku-4.5` | 200K (native gateway window) |
| GitHub Copilot · GPT-6 Astra | `gpt-6-astra` | 1M (model-scoped hint) |
| GitHub Copilot · GPT-6 Sol | `gpt-6-sol` | 1M (model-scoped hint) |
| GitHub Copilot · GPT-6 Luna | `gpt-6-luna` | 1M (model-scoped hint) |

In Claude Code 2.1.280 the `Default` row resolves to `claude-opus-5-5[1m]`, the
same ID as the Opus 5.5 row, so both get the same 1M budget and the same
long-context backend; see [Long conversations](#long-conversations-and-existing-sessions).

The current full-feature validation matrix is exactly `claude-opus-5.5`,
`claude-sonnet-5`, `claude-haiku-4.5`, `gpt-6-astra`, `gpt-6-sol`, and
`gpt-6-luna`. Only fresh execution evidence establishes compatibility. All six
carry the same eleven scenarios — there is no reduced smoke-test tier for any
model. See the [verification results](docs/VERIFICATION.md).
The previous primaries (`claude-opus-5`, `gpt-5.6-sol`, `gpt-5.6-terra`,
`gpt-5.6-luna`), `gpt-5.5` and other catalog models are not part of that
verification; they remain reachable through `--ghcp-model` where your policy
allows them. Catalog visibility alone does not guarantee tool, image,
reasoning, or other feature compatibility for every model.

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

./bin/claude-ghcp --ghcp-model gpt-6-sol --effort high
./bin/claude-ghcp --ghcp-model gpt-6-sol --effort ultracode
```

`/effort` and `--effort` are forwarded to the Copilot SDK. If the selected model does not support the specified value, it is adjusted down to the nearest supported level. No value is forwarded to models that do not support reasoning effort. In the current catalog GPT-6 Sol and Luna support `none`, `low`, `medium`, `high`, `xhigh`, and `max`; GPT-6 Astra, Claude Opus 5.5, and Claude Sonnet 5 support `low` through `max`; Claude Haiku 4.5 takes no reasoning effort.

Ultracode is available only on models that support `xhigh` and may consume more GitHub Copilot AI Credits than a standard call. For details on the `/model` picker and effort translation, see the [Architecture document](docs/ARCHITECTURE.md#model-discovery-and-context).

Subagents and dynamic workflows work in every session. When the launch model is
not Claude Opus 5.5, Sonnet 5 or Haiku 4.5 (a GPT-6 model, for example), Explore
and subagents that name no model run on the launch model: the launcher's settings
set `CLAUDE_CODE_SUBAGENT_MODEL` to it and `CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP=1`.

### Persistent bridge and print mode

Every launch except print mode (`-p`/`--print`) uses one shared persistent
loopback bridge: interactive sessions, `--background`, sessions handed off with
`/background`, and the `agents` view. Print mode gets a private bridge that stops
when the launcher exits.

- Inspect the persistent bridge with `claude-ghcp-status`; stop it with
  `claude-ghcp-stop`. It keeps running after Claude Code exits, so a
  `/background` job can keep using it.
- A different `--ghcp-model` reuses the running bridge. A launch with a different
  configuration replaces it: changed bridge code or dependencies, another checkout
  of this repository, a different `--bridge-port`, or a different bridge
  environment variable such as `TURN_IDLE_TIMEOUT_MS` or `MAX_BODY_BYTES`.
- The replaced bridge is retired, not stopped. It keeps serving the sessions
  already open on it, and exits once none of their launchers is still running and
  it has had no request for `RETIRED_IDLE_MS` (default 1 hour). It is stopped
  instead if the new launch pins its port, or if it was started by an older
  version that cannot retire.
- `claude-ghcp-status` counts running retired bridges as `retired`, and
  `claude-ghcp-stop` stops them too.
- The bridge's registry, `bridge.log` and per-launch settings files live in its
  daemon directory: `$GHCP_DAEMON_DIR` if set, otherwise
  `~/Library/Caches/claude-code-ghcp-sdk` on macOS and
  `${XDG_CACHE_HOME:-~/.cache}/claude-code-ghcp-sdk` on Linux. The bridge runs in
  that directory, not in the project that started it.

### Rate limits and upstream errors

When Copilot rate-limits a request or its upstream fails, the Copilot runtime
first retries by itself, waiting out any upstream `retry-after`; nothing streams
while it waits. Failures that reach the bridge leave it as:

| Failure | Bridge response |
|---|---|
| Copilot `rate_limit` or `quota` error, or upstream HTTP 429 | 429 `rate_limit_error` |
| Upstream HTTP 5xx | 529 `overloaded_error` |
| A fault in the request itself, including a context-limit error | 400 `invalid_request_error` |
| Anything else | 500 `api_error` |

Claude Code retries 429 and 529 with its own backoff; the bridge sends no
`retry-after` header, because the SDK reports no retry time. Every failed request
writes a content-free `bridge.request_failed` line with its status and error type,
and every completed turn a `bridge.turn_completed` line with the requested and
serving models and token counts. The persistent bridge writes these to
`bridge.log` in its daemon directory. A turn timeout during the runtime's wait
also ends as 429 or 529; see [turn timeouts](#long-conversations-and-existing-sessions).

### Long conversations and existing sessions

Cached input is counted once: Copilot's total input count is split into
Anthropic's uncached, cache-read and cache-creation fields, so Claude Code's
context meter is not inflated. Automatic compaction remains owned by Claude Code.

SDK session creation, resume and effort changes have their own
`SESSION_OPERATION_TIMEOUT_MS` deadline (default **60,000 ms**); a step that runs
out fails with a content-free `bridge.session_operation_failed` diagnostic
instead of waiting indefinitely. Cancellation also works during setup and while
queued, and a late setup reply cannot restore an abandoned session.

A model turn has a **5-minute idle timeout** reset by real root text, reasoning
or tool-input progress, plus a separate **30-minute hard cap**
(`TURN_IDLE_TIMEOUT_MS`, `TURN_MAX_DURATION_MS`), so a response that keeps
streaming is not cut off at five minutes. If either timer fires while the Copilot
runtime is waiting to retry an upstream 429 or 5xx, with no progress since the
last root model call failed that way, the request fails as 429
`rate_limit_error` or 529 `overloaded_error`, which Claude Code retries, instead
of 500 `api_error`. The message names the upstream status, and
`bridge.turn_timeout` records it as `upstreamRetryStatus`.

The primary GPT-6 models, Claude Opus 5.5 and Claude Sonnet 5 (and explicitly
selected GPT-5.6 models and Claude Opus 5, 4.8 and 4.7) select the SDK's long-context tier and pass through
their discovered numeric catalogue limits. The SDK's default tier can be much
smaller than the advertised model window: an earlier overnight probe measured
Astra at 272K input tokens by default, versus 1.05M after applying its long tier
and catalogue capabilities, and the default tier holds Opus 5.5 and Sonnet 5 to
200,000. `bridge.context_budget` records the actual runtime limit: 1,050,000 for
Astra, 936,000 for Sonnet 5, and 872,000 for Opus 5.5, Sol and Luna. All of
these except Astra accept fewer prompt tokens than Claude Code's 1M budget for
them, so a conversation that outgrows its limit takes the overflow path
described next before Claude Code's own ~967K auto-compact threshold. Haiku 4.5
stays on the SDK default tier (136,000) under Claude Code's native 200K gateway
window; its limit sits below Claude Code's 167K auto-compact trigger, so it can
take the same overflow path.

SDK-side compaction/truncation is not accepted as silent history loss:
the bridge invalidates that state and returns a recognizable context-limit
error so Claude Code can compact its canonical transcript. Errors detected
before model streaming retain HTTP 400 instead of becoming a successful HTTP
200 stream, which is necessary for native overflow recovery.

A running bridge keeps the code it loaded. After you update this checkout, the
next launch starts a new bridge and retires the old one, which keeps serving the
sessions already open on it. To move a conversation onto the new code, exit its
Claude Code process and resume it from the same project directory with the same
model, for example:

```bash
./bin/claude-ghcp --ghcp-model gpt-6-astra --continue
```

Use `--resume` to choose a different saved conversation. Resuming does not erase
Claude Code transcripts or modify global user settings. Do not disable
auto-compaction merely to force a larger window.

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

The bridge binds to loopback unless `ALLOW_NON_LOOPBACK=1` is set, so LiteLLM runs on the same host as the bridge it fronts. If that host also runs `claude-ghcp` (any launch except `-p`), export the same `GHCP_BRIDGE_PORT` in both shells. The requested port is part of the bridge's configuration fingerprint, so a launcher started without it replaces the pinned bridge with one on a new port and token. The pinned bridge is retired: it keeps answering LiteLLM, but once it has gone `RETIRED_IDLE_MS` (default 1 hour) without a request it exits, and LiteLLM gets connection refused.

LiteLLM is outside this repository's verification scope. The `npm run verify` matrix (6 models x 11 scenarios = 66 slots) starts `src/server.mjs` directly and never starts LiteLLM, so the LiteLLM path is a configuration reference, not a validated path.

For the bridge daemon, its pinned port and token, the example configuration, model mapping, multi-user authentication, and troubleshooting, follow the [LiteLLM Guide](docs/LITELLM.md).

## Command Reference

| Purpose | Command |
|---|---|
| Use the GitHub Copilot SDK directly | `./bin/claude` or `./bin/claude-ghcp` |
| List permitted Copilot models | `./bin/ghcp-models` |
| Diagnose the GHCP environment | `./bin/ghcp-doctor` |
| Inspect the persistent bridge | `./bin/claude-ghcp-status` |
| Stop the persistent bridge and any retired ones | `./bin/claude-ghcp-stop` |
| Use the LiteLLM gateway | `./bin/claude-litellm` |
| Use the original Claude Code provider | `./bin/claude-current` |

`claude-ghcp` rejects `--model` and `--settings`; choose the model with `--ghcp-model`. All other Claude Code options and prompts are passed through unchanged. If `bin` is in your PATH, the `./bin/` prefix can be omitted.

### Configuration Inputs

Command-line options take precedence over environment variables. This repository does not automatically load `.env` files; `export` values in your current shell or specify them before the command. `.env.example` is a reference list of available environment variables.

| Path | Required | Optional |
|---|---|---|
| Direct SDK | none | `--ghcp-model` / `GHCP_MODEL`, `--bridge-port` / `GHCP_BRIDGE_PORT` |
| LiteLLM | `LITELLM_BASE_URL`, `LITELLM_API_KEY` | `--litellm-model` / `LITELLM_MODEL` |

The Direct SDK bridge defaults to **256 MiB (268,435,456 bytes)** for both HTTP request bodies (`MAX_BODY_BYTES`) and replayed conversation history (`MAX_REPLAY_BYTES`). Export either variable to override its limit. Larger limits can increase memory use; they do not expand the model's context window. A launch with a changed value replaces the persistent bridge; sessions already open on the old one keep its limits.

## Configuration and Support Scope

### Settings Preservation

The launch scripts do not modify `~/.claude/settings.json`. A per-launch settings file with `0600` permissions records only the values needed for gateway routing. Existing theme, permissions, hooks, plugins, skills, MCP, and project settings continue to be loaded.

On exit, print mode (`-p`) stops its private bridge and deletes its settings file. Other Direct launches leave the [persistent bridge](#persistent-bridge-and-print-mode) running, and keep their settings file, which holds the bridge token, in the daemon directory so a `/background` job can be respawned from it. A later launch deletes it after 24 hours, and `claude-ghcp-stop` deletes it at once. The LiteLLM path deletes its temporary settings.

Managed settings take precedence over the settings written by the launch scripts. If an organization policy enforces a provider selector, `availableModels`, or MCP tool search, the launch scripts do not override it.

The Copilot runtime behind the bridge would otherwise start the Copilot CLI's
own MCP servers — `~/.copilot/mcp-config.json`, installed Copilot plugins,
workspace files and the built-in `github-mcp-server` — for every SDK session,
although only Claude Code's tools ever reach the model. The bridge discovers
their registered names at startup, adds the built-in server that discovery does
not report, and disables them per session with `disabledMcpServers`, without
changing that configuration. Claude Code's own MCP servers are unaffected. See
[Copilot Runtime MCP Servers](docs/ARCHITECTURE.md#copilot-runtime-mcp-servers).

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
| Sampling and generation controls | Unsupported controls (`temperature`, `top_p`, ...) and accepted-but-ignored fields (`thinking`, `top_k`, ...) are reported by `bridge.degraded_controls` and `GET /health`; `tool_choice` has bounded filtering/prompt emulation |
| MCP tool search | Full-schema default; native ToolSearch available by explicit opt-in |
| `--json-schema` structured output | Uses Claude Code's native validator/retry |
| Remote Control | Disabled by Claude Code when a custom `ANTHROPIC_BASE_URL` is set |
| `--background`, `/background`, agent view | Supported through the shared persistent bridge |
| Claude web/cloud, `--cloud`, `--teleport`, cloud ultrareview | Outside the local execution path; the GHCP bridge is not used |
| Reasoning text/signature, citations, prompt-cache metadata | Full round-trip not supported |

Running the launch scripts directly from the integrated terminal in VS Code or JetBrains uses the same path. The scripts are not automatically applied to Claude Code processes started by IDE extensions, Claude Desktop, or cloud sessions.

## Validation

### 2026-09-23 six-model revalidation (KST)

**Strict result: PASS — 66/66 (100%) in one complete run.** The primary matrix is
now Claude Opus 5.5, Claude Sonnet 5, Claude Haiku 4.5, GPT-6 Astra, GPT-6 Sol and
GPT-6 Luna, each with the same eleven scenarios. The laptop's native Claude Code
**2.1.280** executed every slot through the bridge and Copilot SDK. The final run,
on commit `bed30ce`, which gives Opus 5.5 and Sonnet 5 their 1M Copilot window,
keeps the Copilot runtime from starting unused MCP servers and carries two
harness fixes, took **479 seconds (7 min 59 s)** with no failed, blocked,
missing, duplicate or unexpected slots and unchanged code/user settings. This is
the selected matrix's pass rate, not a claim of complete feature coverage or
guaranteed success on future executions.

- **Pinned picker:** Claude Code's native `supportedModels()` control request
  returned `Default` plus exactly the six rows above, in order. `setModel()` into
  each row sent no request to the bridge, and `getContextUsage()` reported 1M
  (auto-compact at 967K) for Opus 5.5, Sonnet 5 and the three GPT-6 rows, and
  200K (167K) for Haiku 4.5. `Default` and the `opus`/`sonnet` aliases resolved
  to `claude-opus-5-5[1m]` and `claude-sonnet-5[1m]` (1M). An ID typed outside
  the picker is confirmed with one request: Opus 4.8 and 4.7 confirmed at 1M,
  while for Opus 5 Claude Code gave up after 5 seconds, before the model
  answered, in this measurement (an earlier one confirmed it). Artifacts:
  `.verify-runs/picker-1m-2026-09-23T09-32-55Z/`.
- **Runtime MCP servers:** all 72 retained bridge logs of the final run (66
  per-slot bridges plus six v11 daemons) record `bridge.mcp_servers_disabled` for
  five servers; the six v11 foreground launches used ephemeral bridges whose logs
  the launcher deletes on exit. During the earlier full run
  `2026-09-23T00-38-10-470Z`, a `ps` sampler took 354 samples over 12 minutes
  with up to nine concurrent runtimes and never saw an MCP server process under
  them; the only children were short-lived `git` calls and exiting processes
  (`<defunct>`, `(copilot-runtime)`).
  Before the change, one open session started azmcp and two Playwright MCP node
  servers (~330 MB), and a bridge serving two concurrent sessions ran six such
  children. Two concurrent cold first requests now finish in a median 3.95 s
  instead of 8.08 s. Artifacts: `.verify-runs/runtime-sampler-2026-09-23T00-38-10Z/`
  and `.verify-runs/mcp-check-2026-09-23T00-32-13Z/`.
- **SDK budgets** recorded by `bridge.context_budget`: on the long-context tier
  Astra 1,050,000, Sonnet 5 936,000, and Opus 5.5, Sol and Luna 872,000; Haiku
  4.5 136,000 on the default tier. Separately, a 493,805-token prompt to Opus 5.5
  was answered correctly through a bridge on this code. Before the change, the
  default tier held Opus 5.5 and Sonnet 5 to 200,000.
- **Offline:** `npm test` passed **394/394**, with no failures, cancellations or
  skips.
- **Independent audit** of the raw artifacts (`audit.json`): **1,146 recorded
  checks** with none failing, **90 headless phase transcripts** carrying 95 result
  envelopes, all with positive input usage and the expected serving model, no
  unanswered `tool_use`, and retained command/daemon evidence for all six launcher
  slots. GPT-6 Astra's v01 envelope also lists `claude-opus-5-5[1m]`: at this
  commit Claude Code's built-in Explore subagent ran on the Opus alias, as it did
  in the earlier green runs. `f6c1827` has since kept Explore on the launch model
  (see the live checks below). All twelve media-token checks read their token
  exactly.
- **Before the final run,** the first six-model full run scored 64/66 and was NOT
  GREEN. Claude Opus 5.5 completed v02 and v08 correctly but through shell
  commands (`sed -i`, a redirect) instead of Edit and Write, so the Edit
  exact-match check and the Write|Edit PreToolUse observer had nothing to observe.
  Separately, an interactive Claude Code session outside the harness saved a
  `/model` choice to `~/.claude/settings.json` mid-run, which the settings gate
  correctly refused. The v02 and v08 prompts now name Edit and Write, as the v08
  cron turn already names CronCreate; checks and pass criteria are unchanged. A
  focused Opus 5.5 rerun of both scenarios passed 2/2, and the next full run
  passed 66/66 in 624 s. The runtime MCP change then required a fresh full run on
  its own commit; it took longer while another repository's Copilot runtime
  stability jobs were loading the same laptop (load average ≈ 8.5).
- **1M windows:** the first run with the change, still uncommitted and on the
  heavier 6 × 2 profile at timeout scale 1, scored 64/66: GPT-6 Luna's v02 plan
  turn blocked at 90 s, and Claude Haiku 4.5 typed the slashed zero of
  `IMGTAG84370D` as `Ø`. Next, the first attempt from a clean worktree
  (`2026-09-23T08-22-51-615Z`) was stopped after every slot blocked: both
  launcher resolvers only recognised their own checkout's wrappers and picked
  the main checkout's `bin/claude` from PATH. With the repository removed from
  PATH, the committed change scored 65/66 when GPT-6 Luna read the F of
  `IMGTAGA3F755` as E; re-rendered in the same font, E and F are clearly
  distinct. The v05 attachment checks exist to catch a bridge that drops the PDF
  or image block, and a model that never received it cannot place five of six
  random hex glyphs (91 of 16^6 suffixes). They now accept one misread glyph,
  read `Ø` as `0`, and name any tolerated misread in the check detail. Replayed
  over every recorded v05 answer, all 292 earlier passes still pass, and the 11
  that flip are all single-glyph misreads. The resolvers now skip every
  checkout's launchers, and the final run resolved `~/.local/bin/claude` with
  PATH unchanged.
- **Live checks after the final run** (Claude Code 2.1.281, outside the matrix):
  - *Subagent model:* with the launcher's gateway settings on GPT-6 Luna and
    GPT-6 Astra, an Explore subagent and a general-purpose subagent with no model
    both requested the launch model, and `bridge.turn_completed` `servedModels`
    showed Copilot serving every root and subagent turn with it.
  - *Upstream 429 and 503:* with the Copilot runtime's `COPILOT_API_URL` pointed at
    a local proxy that failed inference with 429 or 503 (Claude Haiku 4.5, `-p`),
    the runtime made 6 attempts (about 50 s for the 429, about 17 s for the 503),
    the bridge then returned 429 `rate_limit_error` and 529 `overloaded_error`, and
    Claude Code's single retry about 0.5 s later succeeded. This needed a bridge
    fix, because the runtime ends the turn before it reports `session.error` and
    the bridge used to finish that turn as an empty success.
  - *`retry-after`:* the runtime waited out a 90 s upstream `retry-after` by
    itself, about 95 s with no events.

Full-run history remains separate, under each run's recorded implementation and
model catalogue:

| Full run | Run ID (UTC) | Matrix | Pass / fail / blocked / unknown | Model × scenario workers | Duration | User settings |
|---|---|---|---|---|---|---|
| Six-model first run — NOT GREEN | `2026-09-22T23-29-13-171Z` | 6 × 11 | 64 / 2 / 0 / 0 | 3 × 2 | 778 s | Changed by an interactive session outside the harness |
| Six-model before the runtime MCP change — PASS | `2026-09-22T23-45-15-077Z` | 6 × 11 | 66 / 0 / 0 / 0 | 3 × 2 | 624 s | Intact |
| Six-model, runtime MCP servers disabled — PASS | `2026-09-23T00-38-10-470Z` | 6 × 11 | 66 / 0 / 0 / 0 | 3 × 2 | 740 s | Intact |
| Six-model, uncommitted 1M windows — NOT GREEN | `2026-09-23T07-29-33-556Z` | 6 × 11 | 64 / 1 / 1 / 0 | 6 × 2 | 487 s | Intact |
| Six-model, 1M windows (`44fb772`) — NOT GREEN | `2026-09-23T08-28-09-543Z` | 6 × 11 | 65 / 1 / 0 / 0 | 3 × 2 | 474 s | Intact |
| Six-model final, 1M windows and harness fixes — PASS | `2026-09-23T09-11-26-241Z` | 6 × 11 | **66 / 0 / 0 / 0** | **3 × 2** | **479 s** | **Intact** |
| Seven-model: previous closeout 1 — NOT GREEN | `2026-09-21T22-54-08-294Z` | 7 × 11 | 76 / 1 / 0 / 0 | 7 × 2 | 456 s | Changed; writer/cause unknown |
| Seven-model: previous closeout 2 — NOT GREEN | `2026-09-21T23-07-19-056Z` | 7 × 11 | 74 / 2 / 1 / 0 | 7 × 2 | 863 s | Intact |
| Seven-model: fresh baseline — NOT GREEN | `2026-09-22T00-01-29-757Z` | 7 × 11 | 76 / 1 / 0 / 0 | 7 × 2 | 943 s | Intact |
| Seven-model: first correction — NOT GREEN | `2026-09-22T00-30-59-086Z` | 7 × 11 | 75 / 2 / 0 / 0 | 7 × 2 | 973 s | Intact |
| Seven-model: before picker/long-turn follow-up — PASS | `2026-09-22T00-52-51-013Z` | 7 × 11 | 77 / 0 / 0 / 0 | 3 × 2 | 782 s | Intact |
| Seven-model: picker/long-turn fixes — PASS | `2026-09-22T03-37-17-139Z` | 7 × 11 | 77 / 0 / 0 / 0 | 3 × 2 | 794 s | Intact |
| Seven-model: context/streaming recovery — PASS | `2026-09-22T12-29-58-559Z` | 7 × 11 | 77 / 0 / 0 / 0 | 3 × 2 | 812 s | Intact |

The final run recorded commit
`bed30cebc49b155b09c2795618b7e28ad044aae5` (clean checkout) and matching start/end
41-file `verification-code-v1` SHA-256 fingerprints:
`1fa37d3abcd284e9d1481fafef02c211d976e63fabeaa8d64d4879a159fb5bc7`.
Both generated verification documents use **only that final full run**.
Its ignored local directory `.verify-runs/2026-09-23T09-11-26-241Z/` contains
`summary.json`, `slots.jsonl`, `console.log`, `audit.json`, phase transcripts and
launcher logs. The earlier six-model runs and the focused reruns
(`2026-09-22T23-44-23-074Z`, `2026-09-23T07-41-07-507Z`) remain separate local
records; none of their cells contribute to the final 66/66.

### Previous seven-model record (2026-09-22)

The previous primaries were Claude Opus 5, Claude Sonnet 5, Claude Haiku 4.5,
GPT-5.6 Sol, GPT-5.6 Terra, GPT-5.6 Luna and GPT-6 Astra. Their last full run,
`2026-09-22T12-29-58-559Z` on commit `d84bd22` with Claude Code 2.1.278, passed
77/77. The same work produced these separate probes, which do not contribute
cells to any matrix:

- A real Astra conversation completed **10 turns and four automatic compactions**
  with a test-only 100K compact window (67K trigger), then recalled the marker
  planted in its first turn:
  `.verify-runs/long-conversation-2026-09-22T02-30-14-506Z/`.
- Recovery probes: **Astra 24/24 turns** with one native compaction and
  first-marker recall at up to **809,115 input tokens**, and **Haiku 9/9 turns**
  with two native compactions.
- A focused seven-model resume/fork and long-context run passed **14/14**:
  `.verify-runs/picker-longturn-regression/2026-09-22T02-40-55-670Z/`.

Its failures stay recorded as history rather than being reclassified: the
Sonnet fork mismatch, Opus zero-result usage and Haiku timeout of the previous
closeout; a Luna and a Haiku native background worker stuck at startup before the
first bridge model request; and an Opus refusal to broad earlier-message
extraction wording, since replaced by clarified factual questions. Those runs
also hardened the harness rather than relaxing the gate:

- Resume/fork prompts ask for the example deployment's original facts. All three
  phases must use no tools, so persistent-memory writes cannot masquerade as
  inherited conversation context. Wrong dates, facts and session IDs still fail.
- Explicit usage zero is no longer replaced by estimates. Zero total input
  usage, including cache, still fails; finalized assistant usage or cumulative
  `modelUsage` is not substituted to make it pass.
- Content-free timeout/cancellation diagnostics and pre-cleanup native daemon
  snapshots distinguish bridge stalls from native startup stalls. Command
  stdout/stderr and daemon logs survive cleanup.

The upstream causes of those earlier intermittent SDK/native stalls are not
established or claimed eliminated. Earlier offline evidence remains in
`.verify-runs/soak-20260922-1403/overnight/runtime-fix-offline-v2.log`.

```bash
# Unit and structural tests. No model calls, no credits.
npm test

# Reproduce the fully passing laptop profile (six concurrent matrix workers)
PENDING_TOOL_WAIT_MS=30000 npm run verify -- \
  --timeout-scale 2 --model-concurrency 3 --scenario-concurrency 2

# Full verification matrix: 11 scenarios x 6 models = 66 live slots (timeout scale: 1)
npm run verify

# Longer verification waits; overrides apply only to this command
PENDING_TOOL_WAIT_MS=30000 npm run verify -- --timeout-scale 2

# One cell, while iterating on a driver
npm run verify -- --models claude-opus-5.5 --scenarios v04-shell-ops

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
workers and scenario workers per model (defaults: `6` and `2`). Dry-run single-turn
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
`strict-all-pass-v1` policy: **66 of 66** for the full matrix, or every selected
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

Neither command covers LiteLLM; see [LiteLLM Quick Start](#litellm-quick-start).

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
