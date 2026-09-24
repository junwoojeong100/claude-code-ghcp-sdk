# Claude Code with GitHub Copilot Models

> **Language / 언어:** English | [한국어](README_KO.md)

This repository is a local bridge that lets Claude Code use GitHub Copilot models. Claude Code sends Anthropic Messages API requests to the bridge, directly or through a LiteLLM proxy, and the bridge runs them on Copilot models through the GitHub Copilot SDK (`@github/copilot-sdk`, pinned to 1.0.14). Claude Code's UI, tool execution, permissions, hooks, MCP servers and skills stay as they are.

**This is an unofficial integration.** Anthropic does not support routing non-Claude models through a gateway, and neither Anthropic nor GitHub supports this combination. See [What works and what does not](#what-works-and-what-does-not).

## Choose a path

| You want to | Path | Command |
|---|---|---|
| Use your own Copilot account under your organization's model policy | **Direct SDK** | `./bin/claude-ghcp` |
| Reach Copilot models through a LiteLLM gateway that fronts this bridge | LiteLLM | `./bin/claude-litellm` |

Most users want Direct SDK. Use LiteLLM only when you have to go through a LiteLLM gateway; see [LiteLLM (optional)](#litellm-optional).

## Quick start (Direct SDK)

### Requirements

- macOS or Linux (the Windows default shell is not supported)
- Claude Code (the `claude` command)
- GitHub Copilot CLI (the `copilot` command)
- Node.js `^20.19.0` or `>=22.12.0`
- `curl` and Git
- GitHub Copilot access, and a model your organization's Copilot policy allows

### 1. Install

```bash
git clone https://github.com/junwoojeong100/claude-code-ghcp-sdk.git
cd claude-code-ghcp-sdk
npm install
```

### 2. Sign in to GitHub Copilot

Install the Copilot CLI if `copilot` is not on your PATH, then sign in:

```bash
npm install -g @github/copilot
copilot login
```

You do not need an Anthropic API key.

### 3. Check the environment and models

```bash
./bin/ghcp-doctor
./bin/ghcp-models
```

Both commands should succeed, and `ghcp-models` should list the model you want to use.

### 4. Run Claude Code

```bash
# Start with the default model, Claude Sonnet 5
./bin/claude-ghcp

# Start with another model
./bin/claude-ghcp --ghcp-model gpt-6-sol

# Print mode (-p): answer one prompt, then exit
./bin/claude-ghcp --ghcp-model claude-haiku-4.5 -p "Describe the structure of this repository"
```

Inside Claude Code, `/model` switches between the six models listed in [Models](#models).

### 5. Optional: put claude on PATH

To run from any directory, add this repository's `bin` directory to your PATH. For Zsh, from the repository root:

```bash
echo "export PATH=\"$PWD/bin:\$PATH\"" >> ~/.zshrc
exec zsh
command -v claude   # <clone-path>/claude-code-ghcp-sdk/bin/claude
```

For other shells, add the same line to that shell's configuration file. `claude` then runs the Direct SDK launcher:

```bash
claude
claude --ghcp-model claude-haiku-4.5

# Change the default model
export GHCP_MODEL=claude-haiku-4.5

# Run Claude Code with its original provider
claude-current
```

## Models

| Picker label | `--ghcp-model` ID | Claude Code window | Reasoning effort |
|---|---|---|---|
| Claude Opus 5.5 | `claude-opus-5.5` | 1M | `low`, `medium`, `high`, `xhigh`, `max` |
| Claude Sonnet 5 | `claude-sonnet-5` (default) | 1M | `low`, `medium`, `high`, `xhigh`, `max` |
| Claude Haiku 4.5 | `claude-haiku-4.5` | 200K | not supported |
| GPT-6 Astra | `gpt-6-astra` | 1M | `low`, `medium`, `high`, `xhigh`, `max` |
| GPT-6 Sol | `gpt-6-sol` | 1M | `none`, `low`, `medium`, `high`, `xhigh`, `max` |
| GPT-6 Luna | `gpt-6-luna` | 1M | `none`, `low`, `medium`, `high`, `xhigh`, `max` |

In `/model` each row reads `GitHub Copilot · <label> (<ID>)`. The list shows only these six rows plus Claude Code's own `Default` row. In Claude Code 2.1.280 `Default` is Claude Opus 5.5, while a launch without `--ghcp-model` starts on Claude Sonnet 5.

Other models in your Copilot catalogue work with `--ghcp-model` when your policy allows them, but they are not verified. `./bin/ghcp-models` lists them.

The window column is the context size Claude Code plans for. Copilot accepts fewer input tokens than that on five of the six models; see [Long conversations](#long-conversations).

The effort levels are what the Copilot catalogue listed on 2026-09-24; `./bin/ghcp-models --json` shows what your account gets now. Set a level with `--effort <level>` or `/effort`. If the model does not list that level, the bridge uses the nearest lower level it does list, or the model's lowest level when none is lower: `none` on Claude Opus 5.5 runs as `low`. A model without reasoning effort gets no effort value.

Ultracode (`--effort ultracode`) reaches Copilot as `xhigh`, and a model that does not list `xhigh` gets its nearest lower level instead. It needs Claude Code 2.1.203 or later and can spend more GitHub Copilot AI Credits than a standard call.

Subagents that name no model, including the built-in Explore subagent, run on the launch model when you launch with a model other than Claude Opus 5.5, Sonnet 5 or Haiku 4.5, such as a GPT-6 model. With those three Claude models they inherit the main model, as Claude Code normally does.

How the windows, input limits and effort values are set: [Architecture](docs/ARCHITECTURE.md#model-discovery-and-context).

## Day-to-day use

### The background bridge

Every `claude-ghcp` launch except print mode shares one bridge that runs in the background on loopback. The launcher's help and the architecture guide call it the persistent bridge. Interactive sessions, `--background`, sessions you hand off with `/background` and the `agents` view all use it. It keeps running after Claude Code exits, so background jobs keep working.

- Print mode (`-p`) gets a private bridge that stops when the command exits. `-p` together with `--background` or `agents` uses the shared bridge.
- `./bin/claude-ghcp-status` shows whether the bridge is running, its PID and port, the model it was first started with, and how many replaced bridges are still running (`retired`).
- `./bin/claude-ghcp-stop` stops the bridge and every replaced bridge, and deletes `bridge.log` and all per-launch settings files. Sessions and `/background` jobs that still use them stop working, so run it when you are done.
- A different `--ghcp-model` reuses the running bridge. A launch with a different bridge configuration starts a new one: changed bridge code or dependencies, another checkout of this repository, a different `--bridge-port`, or a different bridge environment variable such as `TURN_IDLE_TIMEOUT_MS`. The full list is in [Architecture](docs/ARCHITECTURE.md#persistent-bridge-and-retirement).
- The replaced bridge keeps serving the sessions already open on it. It exits once their launchers have exited and it has had no request for `RETIRED_IDLE_MS` (default 1 hour). It is stopped at once instead when it comes from an older version of this repository that cannot keep serving after being replaced, or when the new launch pins the port it is using.
- The bridge's files (`bridge.log`, its registry and the per-launch settings files) live in `$GHCP_DAEMON_DIR` if set, otherwise in `~/Library/Caches/claude-code-ghcp-sdk` on macOS and `${XDG_CACHE_HOME:-~/.cache}/claude-code-ghcp-sdk` on Linux. The bridge runs in that directory, not in the project that started it.

### After updating this checkout

A running bridge keeps the code it loaded. After you update this checkout, the next launch starts a new bridge, and the old one keeps serving the sessions already open on it (unless it is too old for that; see [The background bridge](#the-background-bridge)). To move a conversation onto the new code, exit Claude Code and resume the conversation from the same project directory with the same model:

```bash
./bin/claude-ghcp --ghcp-model gpt-6-astra --continue
```

Use `--resume` to choose a different saved conversation. Resuming keeps Claude Code's transcripts and does not touch your user settings. Restart a session to load a changed `/model` list.

### Long conversations

Claude Code decides when to compact a conversation, as it always does. On every model except GPT-6 Astra, Copilot's input limit is lower than the point where Claude Code auto-compacts, so a long conversation reaches Copilot's limit first.

- When Copilot would start compacting or dropping history on its own, the bridge ends the turn with a 400 `invalid_request_error` whose message starts with `prompt is too long`. Claude Code then compacts its own transcript and continues. This hand-off is [not verified](#not-verified).
- If Copilot reports a context-limit error itself, the bridge returns 500 `api_error`, not the `prompt is too long` error that Claude Code compacts on. Run `/compact` if a long conversation keeps failing this way.
- Do not turn off auto-compaction to get a larger window.
- Cached input is counted once, so Claude Code's context meter is not inflated.

Per-model input limits: [Architecture](docs/ARCHITECTURE.md#model-discovery-and-context).

### Rate limits and timeouts

When Copilot rate-limits a request or its upstream fails, the Copilot runtime retries on its own first and waits out any `retry-after`. Nothing streams during that wait, so a turn can show no output for a minute or longer. If the retries fail, the bridge returns 429 `rate_limit_error` (rate limit or quota) or 529 `overloaded_error` (upstream 5xx), and Claude Code retries with its own backoff.

A turn fails with 500 `api_error` after 5 minutes without model progress (`TURN_IDLE_TIMEOUT_MS`) or after 30 minutes in total (`TURN_MAX_DURATION_MS`). If either limit is reached while Copilot is waiting to retry a 429 or 5xx, the turn fails as 429 or 529 instead, so Claude Code retries it.

The background bridge writes a content-free line to `bridge.log` for every failed Messages request (`bridge.request_failed`) and every completed turn (`bridge.turn_completed`, with the requested and served models and token counts). All status codes: [Upstream Errors](docs/ARCHITECTURE.md#upstream-errors). All log events: [Logging](docs/ARCHITECTURE.md#logging).

## LiteLLM (optional)

Choose this only when you have to reach Copilot models through a LiteLLM gateway, for example for its virtual keys or request logs. LiteLLM sits in front of this same bridge; it does not replace it. Every request through the gateway runs on the bridge operator's one Copilot seat and organization policy, whoever sends it. The client needs this checkout and Node.js, but not `npm install` or `copilot login`. It gets neither the six-model `/model` list nor the 1M windows, and the path is [not verified](#not-verified).

```bash
export LITELLM_BASE_URL="https://litellm.example.com"
export LITELLM_API_KEY="<scoped-virtual-key>"
export LITELLM_MODEL="claude-sonnet-5"
./bin/claude-litellm
```

To connect, run a gateway, or look up what differs from Direct SDK, see the [LiteLLM guide](docs/LITELLM.md).

## Commands and configuration

### Commands

| Purpose | Command |
|---|---|
| Run Claude Code on Copilot models (Direct SDK) | `./bin/claude-ghcp` or `./bin/claude` |
| List the Copilot models your account can use | `./bin/ghcp-models` |
| Check the environment | `./bin/ghcp-doctor` |
| Show the background bridge | `./bin/claude-ghcp-status` |
| Stop the background bridge and every replaced bridge | `./bin/claude-ghcp-stop` |
| Run Claude Code through a LiteLLM gateway | `./bin/claude-litellm` |
| Run Claude Code with its original provider | `./bin/claude-current` |

`claude-ghcp` rejects `--model` and `--settings`; choose the model with `--ghcp-model`. `-h`/`--help` shows the launcher's own help, and `./bin/claude-current --help` shows Claude Code's. Every other option and prompt goes to Claude Code unchanged. With `bin` on your PATH, drop the `./bin/` prefix.

### Configuration

Command-line options win over environment variables. The launchers read exported variables and do not load `.env` files. [`.env.example`](.env.example) lists every variable with its default.

| Option / variable | Default | Effect |
|---|---|---|
| `--ghcp-model` / `GHCP_MODEL` | `claude-sonnet-5` | Launch model for Direct SDK |
| `--bridge-port` / `GHCP_BRIDGE_PORT` | a free port | Fixes the bridge's loopback port |
| `GHCP_NATIVE_TOOL_SEARCH` | `0` | `1` turns on Claude Code's own MCP tool search. By default every tool is sent with its full schema |
| `GHCP_DAEMON_DIR` | see [The background bridge](#the-background-bridge) | Directory of the background bridge |
| `CLAUDE_CODE_BIN` | the first `claude` on PATH that is not one of this repository's launchers | The real Claude Code executable the launchers run |
| `COPILOT_CLI_PATH` | unset | Runs an existing Copilot CLI instead of the runtime bundled with the SDK. Another runtime is not verified |
| `MAX_BODY_BYTES`, `MAX_REPLAY_BYTES` | `268435456` (256 MiB) each | Largest request body and largest replayed history. Raising them uses more memory and does not enlarge a model's window |
| `TURN_IDLE_TIMEOUT_MS`, `TURN_MAX_DURATION_MS` | `300000`, `1800000` | Turn limits; see [Rate limits and timeouts](#rate-limits-and-timeouts) |
| `--litellm-base-url` / `LITELLM_BASE_URL` | none, required | LiteLLM gateway URL |
| `LITELLM_API_KEY` | none, required | LiteLLM virtual key |
| `--litellm-model` / `LITELLM_MODEL` | `claude-sonnet-5` | Gateway model alias |

`--bridge-port`, `COPILOT_CLI_PATH`, the byte limits and the turn limits are part of the bridge's configuration. Changing one starts a new background bridge at the next launch, and sessions already open on the old bridge keep its values.

### Your settings are left alone

The launchers never write `~/.claude/settings.json` or your project settings. Each launch hands Claude Code one extra settings file (mode `0600`) with `--settings`.

- It points Claude Code at the bridge, or at the gateway for `claude-litellm`, with its token, the model names and the subagent and Explore model settings.
- It blanks provider selectors such as `CLAUDE_CODE_USE_BEDROCK` and inherited model variables such as `ANTHROPIC_DEFAULT_MODEL`, so shell or user values cannot send requests elsewhere.
- The Direct file also sets the `/model` list, sets `CLAUDE_CODE_ATTRIBUTION_HEADER=0` and `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`, and clears `CLAUDE_CODE_MAX_CONTEXT_TOKENS`. It clears `ENABLE_TOOL_SEARCH` unless `GHCP_NATIVE_TOOL_SEARCH=1`.
- The `claude-litellm` file clears `ENABLE_TOOL_SEARCH` and sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.

Everything else still loads: theme, permissions, hooks, plugins, skills, MCP servers and project settings. Managed (organization) settings rank above command-line settings in Claude Code, so an enforced provider selector, `availableModels` list or MCP tool search setting still applies. This repository does not test that.

Print mode and `claude-litellm` delete that file when they exit. Other Direct launches keep it in the bridge directory, because Claude Code restarts a `/background` job from it later. When those files are removed: [Files the bridge keeps](docs/ARCHITECTURE.md#files-the-bridge-keeps).

The bridge also keeps the Copilot CLI's own MCP servers (from `~/.copilot/mcp-config.json`, workspace files, installed Copilot plugins, and the built-in `github-mcp-server`) from starting in its sessions, without changing their configuration. Claude Code's MCP servers are unaffected. See [Copilot Runtime MCP Servers](docs/ARCHITECTURE.md#copilot-runtime-mcp-servers).

## What works and what does not

### Verified

The last full matrix run passed **66 of 66 slots** on 2026-09-23 (KST), on commit `bed30ce`, with Claude Code 2.1.280: six models × 11 scenarios. A slot is one model running one scenario. Per-scenario results: [Verification results](docs/VERIFICATION.md).

What a pass shows:

- Each slot ran the real Claude Code binary against the bridge, the Copilot SDK and a real Copilot model. Nothing was mocked.
- Each slot had its own workspace and Claude Code configuration directory.
- Slots were judged on files on disk, git history, hook logs and Claude Code's record of which tools ran. The model's answer was checked for values planted in the test data, plus two other things: in the multi-step scenario a claim that every step is done must match the files, and in the hooks scenario the answer must say the command was blocked.
- The 11 scenarios cover searching a repository; an exact Edit and a new file after a plan-mode turn; a test-fix loop; a background shell process, a git commit and a worktree; a four-step plan across source, text, markdown and notebook files that ends by reading a PDF and an image; a project subagent; a Playwright MCP server; CLAUDE.md rules, hooks, commands, skills, a plugin and a scheduled task; session resume and fork; long-context retrieval; and the launcher with its background bridge and a background agent.

The passing run did not use the default settings. It used `--timeout-scale 2` (default 1), 3 model workers × 2 scenario workers (default 6 × 2), and `PENDING_TOOL_WAIT_MS=30000`. That variable sets how long the bridge waits for Copilot to register a tool call. Its bridge default is 10000, and the 30000 reached every bridge the run started.

The matrix has not been re-run since `bed30ce`. The code changes below came later. `npm test` covers each of them. One-off live checks, recorded in [Verification history](docs/VERIFICATION_HISTORY.md), also cover the subagent model and the upstream 429 and 503 handling. No matrix run covers them.

- Interactive sessions use the background bridge, and a replaced bridge keeps serving its open sessions (`ceecc8e`).
- Copilot rate limits and outages map to 429/529 (`9c68f01`), including turns cut short during a Copilot retry wait (`9f1649a`).
- Subagents and Explore that name no model stay on the launch model (`f6c1827`).
- Each streamed content block is closed before the next one starts (`279caa6`).
- User text sent next to a tool result is folded into that result (`b53208d`).
- Request fields the bridge accepts but ignores are listed in `bridge.degraded_controls` and `GET /health` (`7775be6`).
- Every completed turn writes a content-free log line (`24989f1`).
- Bridge credentials are compared in constant time (`9adbc28`).
- The bridge starts when this checkout is reached through a symlinked directory, such as `/tmp` on macOS (`909fbc1`).

### Not verified

The matrix does not exercise these, so treat them as unproven:

- Automatic compaction, and the context-limit error that hands a long conversation to it. Five of the six models depend on this in long conversations.
- Copilot rate-limit and outage handling (429/529). Only `npm test` with injected faults and a one-off probe cover it.
- Interactive terminal sessions, including `/rewind` and Esc cancellation. Every slot runs Claude Code without its interactive UI: in print mode (`-p`), and in the launcher scenario also with `--background` and `agents --json --all`.
- Permission prompts. No slot answers one: slots run with permission checks bypassed, except one plan-mode turn and the launcher scenario, which uses `acceptEdits`.
- Which Copilot model served a turn. The check reads the model name Claude Code requested, not the model Copilot reports in `bridge.turn_completed`.
- WebFetch, and dynamic workflows that start many subagents. The subagent scenario delegates to one subagent.
- Running skills, plugin commands and scheduled jobs. The checks confirm they load or are created, not that they run.
- A bridge restart in the middle of a session. The resume scenario keeps one bridge running across its three processes.
- The LiteLLM path.
- Models outside the six in [Models](#models).
- Other machines, and Linux. The run used one macOS (darwin arm64) machine.

The generated list: [Not verified by this run](docs/VERIFICATION.md#not-verified-by-this-run).

### Not supported

- Official support or an SLA from Anthropic or GitHub.
- The Windows default shell.
- Remote Control. Claude Code turns it off when `ANTHROPIC_BASE_URL` points to a custom gateway.
- Claude Code on the web, `--cloud`, `--teleport`, mobile sessions and cloud ultrareview. They run on Anthropic's infrastructure and never reach the bridge.
- Claude Code started by IDE extensions or Claude Desktop. They do not use the launcher. Running the launcher in an IDE's integrated terminal works.
- Extended thinking. The `thinking` field is ignored and replies carry no thinking blocks or signatures. Reasoning effort is forwarded instead.
- Citations, and prompt caching: `cache_control` markers have no effect.
- WebSearch. Anthropic runs it on its servers.
- Sampling controls such as `temperature`, `top_p` and `stop_sequences`. The bridge accepts them, does not apply them, and records them in `bridge.degraded_controls`.

Feature by feature: [Compatibility](docs/COMPATIBILITY.md#feature-lookup).

### Is it right for you?

| Use case | Fit |
|---|---|
| Personal experiments and research | Suitable |
| Coding in the Claude Code UI with Copilot models | Works for the verified scenarios. Check your own tool combinations first |
| Long sessions and unattended automation | Not yet. Compaction, rate-limit recovery and interactive sessions are not verified end to end |
| A gateway shared by a team | Not suitable. Every request runs on one person's Copilot seat |
| Work that needs official support or an SLA | Not suitable |

## Running the checks

```bash
# Unit and structural tests. No model calls, free.
npm test

# The full live matrix with the settings of the last passing run.
# Spends real GitHub Copilot AI Credits. The passing run took 479 s.
PENDING_TOOL_WAIT_MS=30000 npm run verify -- \
  --timeout-scale 2 --model-concurrency 3 --scenario-concurrency 2
```

Plain `npm run verify` uses the defaults: 6 model workers, `--timeout-scale 1` and a `PENDING_TOOL_WAIT_MS` of 10000. No six-model full run with those defaults has passed. Other flags, focused runs, how a run is judged and how to publish `docs/VERIFICATION.md`: [Validation Scope](docs/ARCHITECTURE.md#validation-scope).

## Documentation

| To learn | Read |
|---|---|
| How the bridge works, its security boundaries and how it is validated | [Architecture](docs/ARCHITECTURE.md) |
| Whether a specific Claude Code feature works | [Compatibility](docs/COMPATIBILITY.md) |
| Per-scenario results of the last full run | [Verification results](docs/VERIFICATION.md) |
| Earlier runs and one-off live checks | [Verification history](docs/VERIFICATION_HISTORY.md) |
| How to use or run a LiteLLM gateway | [LiteLLM guide](docs/LITELLM.md) |
| Every environment variable and its default | [`.env.example`](.env.example) |
