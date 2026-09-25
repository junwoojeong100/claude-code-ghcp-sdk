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

```bash
./bin/ghcp-doctor
./bin/ghcp-models
```

Stay in the repository root for the remaining commands.

- `ghcp-doctor` prints a JSON report. It passes when `node`, `npm`, `claude` and `copilot` each show `"ok": true` and `compatibility.node.supported` is `true`; otherwise it exits with status 1. Install or update whatever shows `false`, then run it again. A version check that does not answer within 10 seconds shows `false` too. Without Claude Code it prints `Claude Code executable not found…` instead of the report. It does not check `curl` or Git. `npm run doctor` runs the same check.
- `ghcp-models` connects to Copilot and prints one line per model; the model you want should be listed. If it prints an error instead, run `copilot login` again and retry. A successful list checks account access, not whether a model can answer a prompt.

### 4. Run Claude Code

Start with the default model, Claude Sonnet 5:

```bash
./bin/claude-ghcp
```

In Claude Code, ask `Reply with OK`. A reply confirms that a request completed through this setup; it does not verify every feature below. Prompts use your Copilot allowance. Use `/exit` to return to the shell. The shared bridge stays running; see [The background bridge](#the-background-bridge) before stopping it.

If startup fails, read the error and run `./bin/ghcp-doctor` again. For an unavailable model, choose an ID from `./bin/ghcp-models`. If Claude Code opens but a request fails, see [Diagnostics](docs/DIAGNOSTICS.md).

**Optional alternatives — choose one, not additional setup steps.** An interactive session with another model:

```bash
./bin/claude-ghcp --ghcp-model gpt-6-sol
```

Print mode (`-p`), which answers one prompt and exits:

```bash
./bin/claude-ghcp --ghcp-model claude-haiku-4.5 -p "Describe the structure of this repository"
```

Inside Claude Code, `/model` switches between the six models listed in [Models](#models).

### 5. Optional: put claude on PATH

To run from any directory, add this repository's `bin` directory to your PATH. For Zsh, from the repository root:

```bash
echo "export PATH=\"$PWD/bin:\$PATH\"" >> ~/.zshrc
exec zsh
command -v claude
```

The last command should print `<clone-path>/claude-code-ghcp-sdk/bin/claude`. For other shells, add the same line to that shell's configuration file. A symlink to a launcher, for example in `~/.local/bin` or from `npm link`, works as well: the launchers follow it back to this checkout.

`claude` then runs the Direct SDK launcher, for example `claude` or `claude --ghcp-model claude-haiku-4.5`. `export GHCP_MODEL=claude-haiku-4.5` changes the default model, and `claude-current` runs Claude Code with its original provider.

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

The window column is the context size Claude Code plans for, not a measured Copilot input limit. The runtime may impose a lower limit; see [Long conversations](#long-conversations).

**Reasoning effort: catalogue snapshot, 2026-09-24.** These per-model lists are observations, not hardcoded capabilities or a test result. The bridge uses the supported levels it reads from the SDK catalogue at startup. `./bin/ghcp-models --json` connects to Copilot to show your account's current catalogue; it does not refresh an already-running bridge. Set a level with `--effort <level>` or `/effort`. If the model does not list that level, the bridge uses the nearest lower level it does list, or the model's lowest level when none is lower: `none` on Claude Opus 5.5 runs as `low`. A model without reasoning effort gets no effort value.

Ultracode (`--effort ultracode`) reaches Copilot as `xhigh`, and a model that does not list `xhigh` gets its nearest lower level instead. It needs Claude Code 2.1.203 or later and can spend more GitHub Copilot AI Credits than a standard call.

Subagents that name no model, including the built-in Explore subagent, run on the launch model when you launch with a model other than Claude Opus 5.5, Sonnet 5 or Haiku 4.5, such as a GPT-6 model. With those three Claude models they inherit the main model, as Claude Code normally does.

How the windows, input limits and effort values are set: [Architecture](docs/ARCHITECTURE.md#model-discovery-and-context).

## Day-to-day use

### The background bridge

Every `claude-ghcp` launch except print mode shares one bridge that runs in the background on loopback. The launcher's help and the architecture guide call it the persistent bridge. Interactive sessions, `--background`, sessions you hand off with `/background` and the `agents` view all use it. It keeps running after Claude Code exits, so background jobs keep working.

- Print mode (`-p`) gets a private bridge that stops when the command exits. `-p` together with `--background` or `agents` uses the shared bridge.
- `./bin/claude-ghcp-status` shows whether the bridge is running, its PID and port, the model it was first started with, and how many replaced bridges are still running (`retired`).
- `./bin/claude-ghcp-stop` stops the bridge and every replaced bridge, and deletes `bridge.log` and the bridge's per-launch settings files (not the `claude-litellm` ones described under [Your settings are left alone](#your-settings-are-left-alone)). Sessions and `/background` jobs that still use them stop working, so run it when you are done. If it cannot stop the current bridge, it still removes those files, then reports the error.
- A different `--ghcp-model` reuses the running bridge. A launch with a different bridge configuration starts a new one: changed bridge code or dependencies, another checkout of this repository, a different `--bridge-port`, or a different bridge environment variable such as `TURN_IDLE_TIMEOUT_MS`. The full list is in [Architecture](docs/ARCHITECTURE.md#persistent-bridge-and-retirement).
- The replaced bridge keeps serving the sessions already open on it. It exits once their launchers have exited and it has had no request for `RETIRED_IDLE_MS` (default 1 hour). It is stopped at once instead when it comes from an older version of this repository that cannot keep serving after being replaced, or when the new launch pins the port it is using.
- The bridge's files (`bridge.log`, its registry and the per-launch settings files) live in `$GHCP_DAEMON_DIR` if set, otherwise in `~/Library/Caches/claude-code-ghcp-sdk` on macOS and `${XDG_CACHE_HOME:-~/.cache}/claude-code-ghcp-sdk` on Linux. The bridge runs in that directory, not in the project that started it.
- If a launch fails with `Persistent bridge PID … did not answer /health, so no second bridge was started beside it`, the registered bridge is still running but not answering. Run `./bin/claude-ghcp-stop`, then launch again. A registry whose PID now belongs to some other program is replaced without touching that program ([details](docs/ARCHITECTURE.md#persistent-bridge-and-retirement)).

### After updating this checkout

A running bridge keeps the code it loaded. After you update this checkout, the next launch starts a new bridge, and the old one keeps serving the sessions already open on it (unless it is too old for that; see [The background bridge](#the-background-bridge)). To move a conversation onto the new code, exit Claude Code and resume the conversation from the same project directory with the same model:

```bash
./bin/claude-ghcp --ghcp-model gpt-6-astra --continue
```

Use `--resume` to choose a different saved conversation. Resuming keeps Claude Code's transcripts and does not touch your user settings. Restart a session to load a changed `/model` list.

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

Media from run `2026-09-25T09-55-54-058Z-9bdbc340`: an edited replay video (61 s: **[play in the browser](https://cdn.jsdelivr.net/gh/junwoojeong100/claude-code-ghcp-sdk@13fd4ccd1220c365860d42a1bb0147ad1bc36e25/docs/assets/verification/2026-09-25T09-55-54-058Z-9bdbc340/video.mp4)** · [repository MP4](docs/assets/verification/2026-09-25T09-55-54-058Z-9bdbc340/video.mp4)) and stills of [V01](docs/assets/verification/2026-09-25T09-55-54-058Z-9bdbc340/still-02-v01-unicode-answer.png), [V04](docs/assets/verification/2026-09-25T09-55-54-058Z-9bdbc340/still-03-v04-model-switch.png), [V05](docs/assets/verification/2026-09-25T09-55-54-058Z-9bdbc340/still-04-v05-interrupt-continue.png), [V06](docs/assets/verification/2026-09-25T09-55-54-058Z-9bdbc340/still-05-v06-cold-resume.png) and the [results card](docs/assets/verification/2026-09-25T09-55-54-058Z-9bdbc340/still-01-results-summary.png). They were rendered from that run’s sealed PTY recordings with paths and tokens masked. They show what the cases look like and are not verification evidence; [manifest.json](docs/assets/verification/2026-09-25T09-55-54-058Z-9bdbc340/manifest.json) lists the source recordings, time ranges, edits and hashes. The play link is a jsDelivr copy pinned to the commit that added the MP4, so it opens in the browser’s video player; GitHub offers the repository file only as a download. That run’s outcome is in the [recorded result](docs/VERIFICATION.md).

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

From the repository root, start offline. Neither command calls a model:

```bash
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
