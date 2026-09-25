# Claude Code with GitHub Copilot Models

> **Language / 언어:** English | [한국어](README_KO.md)

Run Claude Code with GitHub Copilot models through a local bridge. The bridge translates Anthropic Messages API requests through the GitHub Copilot SDK (`@github/copilot-sdk`, pinned to 1.0.14); Claude Code keeps its UI, local tool execution, permissions, hooks, MCP servers and skills.

**This is an unofficial integration.** Anthropic does not support routing non-Claude models through a gateway, and neither Anthropic nor GitHub supports this combination. See [What works and what does not](#what-works-and-what-does-not).

[Quick start](#quick-start-direct-sdk) · [Recorded results](docs/VERIFICATION.md) · [Diagnostics](docs/DIAGNOSTICS.md#start-with-the-symptom)

## Choose a path

Use **Direct SDK** (recommended) with your own Copilot account and your organization's model policy. Follow the quick start below. Choose [LiteLLM (optional)](#litellm-optional) only if you need a LiteLLM gateway in front of this bridge.

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
npm ci
```

Installation and checks run in this checkout; your actual work runs in your own project. In the examples below, replace `/absolute/path/to/claude-code-ghcp-sdk` with this checkout's absolute path (`pwd` here), and `/path/to/your-project` with your project directory.

### 2. Sign in to GitHub Copilot

If `command -v copilot` prints nothing, install the Copilot CLI:

```bash
npm install -g @github/copilot
```

Then sign in:

```bash
copilot login
```

You do not need an Anthropic API key.

### 3. Check the environment and models

From the checkout root:

```bash
./bin/ghcp-doctor
./bin/ghcp-models
```

- `ghcp-doctor` checks Node, npm, Claude Code and Copilot CLI. Resolve failed checks before continuing; [Environment check](docs/DIAGNOSTICS.md#environment-check) explains the report.
- `ghcp-models` lists the models your account can access. Make sure your model is listed. This checks account access, not whether the model can answer a prompt. If it fails, follow [Diagnostics](docs/DIAGNOSTICS.md#start-with-the-symptom); not every error needs a new login.

### 4. Run Claude Code

Move to the project you want to work on, then call the launcher by its absolute path. No PATH change is needed:

```bash
cd "/path/to/your-project"
"/absolute/path/to/claude-code-ghcp-sdk/bin/claude-ghcp"
```

The launch model is chosen in this order: `--ghcp-model` → exported `GHCP_MODEL` → `claude-sonnet-5` (Claude Sonnet 5).

Prompts use your Copilot allowance. In Claude Code, ask `Reply with OK`. A reply confirms that one request completed, not that every feature works. Use `/exit` to return to the shell. The shared bridge stays running; see [The background bridge](#the-background-bridge) before stopping it. For startup or request failures, see [Diagnostics](docs/DIAGNOSTICS.md#start-with-the-symptom).

**Optional alternatives — not additional setup steps.** Start an interactive session with another model:

```bash
cd "/path/to/your-project"
"/absolute/path/to/claude-code-ghcp-sdk/bin/claude-ghcp" --ghcp-model gpt-6-sol
```

Or use print mode (`-p`), which answers one prompt and exits:

```bash
cd "/path/to/your-project"
"/absolute/path/to/claude-code-ghcp-sdk/bin/claude-ghcp" --ghcp-model claude-haiku-4.5 -p "Describe the structure of this repository"
```

Inside Claude Code, `/model` switches between the six models listed in [Models](#models).

### 5. Optional: put claude on PATH

The absolute paths above already work from any directory. **Prepending this checkout's `bin` to PATH makes `claude` run Direct SDK instead of your existing `claude` command.** To opt in with Zsh:

```bash
cd "/absolute/path/to/claude-code-ghcp-sdk"
echo "export PATH=\"$PWD/bin:\$PATH\"" >> ~/.zshrc
exec zsh
command -v claude
```

The last command should print `<clone-path>/claude-code-ghcp-sdk/bin/claude`. For other shells, add the same export to that shell's configuration file. Use `claude-current` to run Claude Code with its original provider. `export GHCP_MODEL=claude-haiku-4.5` changes the launch default unless you pass `--ghcp-model`.

Alternatively, run `npm link` from the checkout, with npm's global bin directory on PATH. It registers `claude-ghcp`, `claude-current` and the other package commands, **not `claude`**. The launchers follow symlinks back to this checkout. To reverse either setup, see [Undo the optional command setup](#undo-the-optional-command-setup).

## Models

| Picker label | `--ghcp-model` ID | Claude Code window | Reasoning effort |
|---|---|---|---|
| Claude Opus 5.5 | `claude-opus-5.5` | 1M | `low`, `medium`, `high`, `xhigh`, `max` |
| Claude Sonnet 5 | `claude-sonnet-5` (default) | 1M | `low`, `medium`, `high`, `xhigh`, `max` |
| Claude Haiku 4.5 | `claude-haiku-4.5` | 200K | not supported |
| GPT-6 Astra | `gpt-6-astra` | 1M | `low`, `medium`, `high`, `xhigh`, `max` |
| GPT-6 Sol | `gpt-6-sol` | 1M | `none`, `low`, `medium`, `high`, `xhigh`, `max` |
| GPT-6 Luna | `gpt-6-luna` | 1M | `none`, `low`, `medium`, `high`, `xhigh`, `max` |

In `/model` each row reads `GitHub Copilot · <label> (<ID>)`. The list shows only these six rows plus Claude Code's own `Default` row. In Claude Code 2.1.280 `Default` is Claude Opus 5.5. That is separate from the launcher's priority: `--ghcp-model`, then exported `GHCP_MODEL`, then Claude Sonnet 5.

Other models in your Copilot catalogue work with `--ghcp-model` when your policy allows them, but they are not verified. Run `./bin/ghcp-models` from the checkout root to list them.

The window column is the context size Claude Code plans for, not a measured Copilot input limit. The runtime may impose a lower limit; see [Long conversations](#long-conversations).

**Reasoning effort: catalogue snapshot, 2026-09-24.** These per-model lists are observations, not hardcoded capabilities or a test result. The bridge uses the supported levels it reads from the SDK catalogue at startup. From the checkout root, `./bin/ghcp-models --json` connects to Copilot to show your account's current catalogue; it does not refresh an already-running bridge. Set a level with `--effort <level>` or `/effort`. If the model does not list that level, the bridge uses the nearest lower level it does list, or the model's lowest level when none is lower: `none` on Claude Opus 5.5 runs as `low`. A model without reasoning effort gets no effort value.

Ultracode (`--effort ultracode`) reaches Copilot as `xhigh`, and a model that does not list `xhigh` gets its nearest lower level instead. It needs Claude Code 2.1.203 or later and can spend more GitHub Copilot AI Credits than a standard call.

Subagents that name no model, including the built-in Explore subagent, run on the launch model when you launch with a model other than Claude Opus 5.5, Sonnet 5 or Haiku 4.5, such as a GPT-6 model. With those three Claude models they inherit the main model, as Claude Code normally does.

How the windows, input limits and effort values are set: [Architecture](docs/ARCHITECTURE.md#model-discovery-and-context).

## Day-to-day use

### The background bridge

Interactive sessions, `--background`, sessions handed off with `/background` and the `agents` view share one loopback bridge (the *persistent bridge*). It stays running after Claude Code exits so background jobs can continue. Print mode (`-p`) uses a private bridge that stops on exit, unless combined with `--background` or `agents`.

Check it from any directory with `"/absolute/path/to/claude-code-ghcp-sdk/bin/claude-ghcp-status"`. The report shows the PID, port, model the bridge started with and number of replaced bridges still running (`retired`).

**Before stopping, finish all sessions and background jobs and copy any logs you need.** `claude-ghcp-stop` stops the shared bridge and every replaced bridge, interrupting all sessions and `/background` jobs that use them. It deletes `bridge.log` and the bridge's per-launch settings files, even if stopping the current bridge fails. It does not delete user settings, saved conversations or the `claude-litellm` settings files, which can retain your key; see [Your settings are left alone](#your-settings-are-left-alone).

```bash
"/absolute/path/to/claude-code-ghcp-sdk/bin/claude-ghcp-stop"
```

Bridge files live in `$GHCP_DAEMON_DIR` if set, otherwise in `~/Library/Caches/claude-code-ghcp-sdk` on macOS or `${XDG_CACHE_HOME:-~/.cache}/claude-code-ghcp-sdk` on Linux. For replacement and retention rules, see [Architecture](docs/ARCHITECTURE.md#persistent-bridge-and-retirement); for an unresponsive bridge, see [Diagnostics](docs/DIAGNOSTICS.md#start-with-the-symptom).

### After updating this checkout

Finish active jobs before changing dependencies. Check `git status --short` in the checkout and preserve any local changes first. With a clean checkout, update and install the locked dependencies:

```bash
cd "/absolute/path/to/claude-code-ghcp-sdk"
git pull --ff-only
npm ci
```

A running bridge keeps the code it loaded. The next launch replaces it when fingerprinted files (`src/*.mjs`, `package.json`, `package-lock.json`), the checkout path or relevant bridge settings change. README, test or launcher-only edits do not trigger replacement; a different `--ghcp-model` also reuses the bridge. Existing sessions normally stay on the old bridge; see [Architecture](docs/ARCHITECTURE.md#persistent-bridge-and-retirement) for exceptions, including older bridges and pinned ports.

To move a conversation onto the updated code, exit Claude Code and resume from the **original project directory**, using the same model (replace the example ID as needed):

```bash
cd "/path/to/your-project"
"/absolute/path/to/claude-code-ghcp-sdk/bin/claude-ghcp" --ghcp-model gpt-6-astra --continue
```

Use `--resume` instead of `--continue` to choose a saved conversation. Resuming preserves Claude Code's transcripts and user settings. Restart a session to load a changed `/model` list; this does not refresh the SDK catalogue cached by an already-running bridge.

### Undo the optional command setup

- If you added `bin` to PATH, remove that export from `~/.zshrc` (or your shell's configuration file) and open a new terminal.
- If you used `npm link`, run `npm unlink -g claude-code-ghcp-sdk`.

Neither step stops a running bridge. To stop it too, first finish all jobs and save any needed logs, then use [the stop command above](#the-background-bridge). These steps leave Claude/Copilot user settings and saved conversations alone.

### Long conversations

Claude Code decides when to compact a conversation, as it always does. A Copilot runtime input limit can be lower than the advertised context window, so a long conversation may reach it before Claude Code auto-compacts.

- When Copilot would start compacting or dropping history on its own, the bridge ends the turn with a 400 `invalid_request_error` whose message starts with `prompt is too long`. Claude Code then compacts its own transcript and continues. This hand-off is [not verified](#not-verified).
- If Copilot reports a context-limit error itself, the bridge returns 500 `api_error`, not the `prompt is too long` error that Claude Code compacts on. Run `/compact` if a long conversation keeps failing this way.
- Do not turn off auto-compaction to get a larger window.
- Cached input is counted once, so Claude Code's context meter is not inflated.

How advertised windows and runtime limits differ: [Architecture](docs/ARCHITECTURE.md#model-discovery-and-context).

### Rate limits and timeouts

When Copilot rate-limits a request or its upstream fails, the Copilot runtime retries on its own first and waits out any `retry-after`. Nothing streams during that wait, so a turn can show no output for a minute or longer. If the retries fail, the bridge returns 429 `rate_limit_error` (rate limit or quota) or 529 `overloaded_error` (upstream 5xx), and Claude Code retries with its own backoff.

A turn fails with 500 `api_error` after 5 minutes without model progress (`TURN_IDLE_TIMEOUT_MS`) or after 30 minutes in total (`TURN_MAX_DURATION_MS`). If either limit is reached while Copilot is waiting to retry a 429 or 5xx, the turn fails as 429 or 529 instead, so Claude Code retries it.

The background bridge writes operational summaries to `bridge.log` for failed Messages requests (`bridge.request_failed`) and completed turns (`bridge.turn_completed`, including requested models, SDK-reported models and token counts). These summaries omit conversation contents, but other lines can include upstream error text. Review the combined log before sharing it. See [Upstream Errors](docs/DIAGNOSTICS.md#upstream-errors) for status codes and [Logging](docs/DIAGNOSTICS.md#logging) for events and privacy limits.

## LiteLLM (optional)

Choose this only when you have to reach Copilot models through a LiteLLM gateway, for example for its virtual keys or request logs. LiteLLM sits in front of this same bridge; it does not replace it. Every request through the gateway runs on the bridge operator's one Copilot seat and organization policy, whoever sends it. The client needs this checkout and Node.js, but not dependency installation or `copilot login`. It gets neither the six-model `/model` list nor the 1M windows, and the path is [not verified](#not-verified).

The launcher stores the key in its per-launch settings; read [Your settings are left alone](#your-settings-are-left-alone) for retention and removal before using it.

```bash
export LITELLM_BASE_URL="https://litellm.example.com"
export LITELLM_API_KEY="<scoped-virtual-key>"
export LITELLM_MODEL="claude-sonnet-5"
cd "/path/to/your-project"
"/absolute/path/to/claude-code-ghcp-sdk/bin/claude-litellm"
```

To connect, run a gateway, or look up what differs from Direct SDK, see the [LiteLLM guide](docs/LITELLM.md).

## Commands and configuration

### Commands

These relative commands are for the **checkout root**. In another project, call the checkout's absolute launcher path as in the [quick start](#4-run-claude-code), or use the optional PATH/link setup.

| Purpose | Command |
|---|---|
| Run Claude Code on Copilot models (Direct SDK) | `./bin/claude-ghcp` or `./bin/claude` |
| List the Copilot models your account can use | `./bin/ghcp-models` |
| Check the environment | `./bin/ghcp-doctor` or `npm run doctor` |
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
| `GHCP_DAEMON_DIR` | see [The background bridge](#the-background-bridge) | Directory of the background bridge. A relative path is resolved against the directory you launch from. A value starting with `~` is refused, because it is not expanded |
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

Everything else still loads: theme, permissions, hooks, plugins, skills, MCP servers and project settings. Managed (organization) settings rank above command-line settings in Claude Code, so an enforced provider selector, `availableModels` list or MCP tool search setting still applies. This repository does not test that. The launchers do not change `PATH` either; Claude Code gets the one you launched with.

A print-mode run (`-p` without `--background`) deletes that file when it exits. Every other launch keeps it, because Claude Code restarts a `/background` job from it later: `claude-ghcp` keeps it in the bridge directory, and `claude-litellm` in `${XDG_STATE_HOME:-~/.local/state}/claude-code-ghcp-sdk/litellm-settings`. The `claude-litellm` file contains your LiteLLM key, and `claude-ghcp-stop` does not remove it: delete that directory yourself to remove stored keys (a `/background` job still using a file then cannot restart). When those files are removed: [Files the bridge keeps](docs/ARCHITECTURE.md#files-the-bridge-keeps).

The bridge also keeps the Copilot CLI's own MCP servers (from `~/.copilot/mcp-config.json`, workspace files, installed Copilot plugins, and the built-in `github-mcp-server`) from starting in its sessions, without changing their configuration. Claude Code's MCP servers are unaffected. See [Copilot Runtime MCP Servers](docs/ARCHITECTURE.md#copilot-runtime-mcp-servers).

## What works and what does not

### What the essential suite checks

The essential suite runs six scenarios on all six [primary models](#models): **36 cases**. The list below is what each case must show to pass. It is not a result: whether the latest run passed, and with which versions and code, is in the **[recorded result](docs/VERIFICATION.md)**.

- **V01 — Launch and isolation:** print/TUI startup, exact Unicode reply, six-model picker, and a fresh conversation after `/clear`.
- **V02 — Coding:** complete Read results, real foreground test failures, source-only Edit, a retest in which all three tests pass, and an independent harness rerun.
- **V03 — MCP:** an expected lookup error followed by a successful hidden-value lookup, then tool-free recall in the same process.
- **V04 — Model/effort:** switch models within a conversation and check requested, resolved and SDK-reported model IDs plus the actual SDK effort setting.
- **V05 — Interrupt:** Escape interrupts an active stream and reaches the SDK abort path; the same process then answers a new question.
- **V06 — Compact/resume:** native `/compact`, then exact recall from a new SDK session that was sent the compacted history instead of the original prompt; normal exit; and recall after a new CLI and private bridge resume the exact saved session.
- **Whole run:** all 36 cases, source/settings integrity and owned-process cleanup must pass. Missing evidence is blocked, confirmed violations fail, and focused runs cannot establish a full pass.

The model checks rely on **SDK-reported model IDs**, not on the provider's internal model implementation. [Testing](docs/TESTING.md) explains the checks and evidence. Production offline regressions remain for translation, model mapping, errors, cancellation, session/subagent isolation, runtime MCP blocking and launchers; they are not live results.

**Watch the edited replay (61 s):** [play in the browser](https://cdn.jsdelivr.net/gh/junwoojeong100/claude-code-ghcp-sdk@13fd4ccd1220c365860d42a1bb0147ad1bc36e25/docs/assets/verification/2026-09-25T09-55-54-058Z-9bdbc340/video.mp4) · [download the repository MP4](docs/assets/verification/2026-09-25T09-55-54-058Z-9bdbc340/video.mp4). The playback link is a commit-pinned jsDelivr copy; GitHub offers the repository file as a download.

Stills: [V01](docs/assets/verification/2026-09-25T09-55-54-058Z-9bdbc340/still-02-v01-unicode-answer.png) · [V04](docs/assets/verification/2026-09-25T09-55-54-058Z-9bdbc340/still-03-v04-model-switch.png) · [V05](docs/assets/verification/2026-09-25T09-55-54-058Z-9bdbc340/still-04-v05-interrupt-continue.png) · [V06](docs/assets/verification/2026-09-25T09-55-54-058Z-9bdbc340/still-05-v06-cold-resume.png) · [results card](docs/assets/verification/2026-09-25T09-55-54-058Z-9bdbc340/still-01-results-summary.png).

**Provenance:** the visuals were rendered from run `2026-09-25T09-55-54-058Z-9bdbc340`'s sealed PTY recordings, with paths and tokens masked. They show what the cases look like; **they are not verification evidence**. [manifest.json](docs/assets/verification/2026-09-25T09-55-54-058Z-9bdbc340/manifest.json) lists source recordings, time ranges, edits and hashes. For the outcome, read the [recorded result](docs/VERIFICATION.md).

### Not verified

The essential suite does not cover:

- Long-context retrieval, maximum context capacity, automatic compaction or context-limit recovery.
- Live rate-limit/outage recovery (429/529), `/rewind` or permission prompts.
- Subagents, ToolSearch, arbitrary MCP integrations, WebFetch, skills, hooks, plugins, scheduled jobs, notebook or media workflows.
- Session forks, in-flight recovery across bridge crashes, shared-daemon retirement, background agents or the launcher path itself. The runner owns private bridges directly; V06 checks a clean restart, not crash recovery.
- LiteLLM, models outside the six, or other host/runtime combinations not recorded in the result.

See [Verification results](docs/VERIFICATION.md) for the limits of the recorded run. Implementation support in [Compatibility](docs/COMPATIBILITY.md) does not add live coverage.

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
| Coding in the Claude Code UI with Copilot models | Check the recorded V01–V06 outcomes and your own tool combinations first |
| Long sessions and unattended automation | Not established by this bounded suite; rate-limit recovery, automatic compaction and endurance remain outside its scope |
| A gateway shared by a team | Not suitable. Every request runs on one person's Copilot seat |
| Work that needs official support or an SLA | Not suitable |

## Running the checks

Start with offline checks in the checkout. Neither check calls a model:

```bash
cd "/absolute/path/to/claude-code-ghcp-sdk"
npm test
npm run verify -- --dry-run
```

Tests should finish with no failures. Dry-run prints the expected **36 cases** without launching Claude Code, a bridge or a model. `npm run verify:plan` is the same runner's dry-run.

For live integration evidence, follow [Testing](docs/TESTING.md): run all six models and scenarios with `PENDING_TOOL_WAIT_MS=30000`, `--model-concurrency 1` and `--timeout-scale 2`, then inspect the exact artifact directory printed by the runner. A local mock-API preflight checks the installed CLI first. The subsequent live cases spend GitHub Copilot AI Credits; 36 cases involve more than 36 API requests. `--models` and `--scenarios` subsets are for debugging, not a substitute for the full run.

Plain `npm run verify` selects the full matrix with one model worker, `--timeout-scale 1` and the bridge's default `PENDING_TOOL_WAIT_MS=10000` unless exported. No command promises a pass. The [result](docs/VERIFICATION.md) records the settings actually used.

## Documentation

| To learn | Read |
|---|---|
| How the bridge works and its security boundaries | [Architecture](docs/ARCHITECTURE.md) |
| How to read logs and diagnose errors | [Diagnostics](docs/DIAGNOSTICS.md) |
| How to run checks, inspect failures and generate a report | [Testing](docs/TESTING.md) |
| Whether a specific Claude Code feature works | [Compatibility](docs/COMPATIBILITY.md) |
| Latest recorded core-scenario results by model | [Verification results](docs/VERIFICATION.md) |
| How to use or run a LiteLLM gateway | [LiteLLM guide](docs/LITELLM.md) |
| Every environment variable and its default | [`.env.example`](.env.example) |
