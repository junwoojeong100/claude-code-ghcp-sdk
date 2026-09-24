# Architecture

> **Language / 언어:** English | [한국어](ARCHITECTURE_KO.md)

This bridge lets Claude Code use GitHub Copilot models. It is a local HTTP
server that speaks the Anthropic Messages API to Claude Code and drives the
public `@github/copilot-sdk` on the other side. It calls no undocumented Copilot
endpoint. It is an unofficial integration.

This is the maintainer reference: how requests flow, what the bridge exposes
and stores, how errors and logs look, and how it is tested. To install and run
it, see the [README](../README.md). For LiteLLM, see the
[LiteLLM Guide](LITELLM.md). For what works feature by feature, see
[Compatibility](COMPATIBILITY.md#feature-lookup).

## System Overview

```text
Direct path                               LiteLLM path
Claude Code                               Claude Code
  -> loopback bridge (src/server.mjs)       -> LiteLLM /v1/messages
  -> @github/copilot-sdk, mode "empty"      -> the same loopback bridge
  -> GitHub Copilot model                   -> @github/copilot-sdk
                                            -> GitHub Copilot model
```

`claude` and `claude-ghcp` use the Direct path. Requests run under the
`copilot login` account and its organization's model policy.

`claude-litellm` uses the LiteLLM path. LiteLLM reaches the bridge through its
`anthropic/*` provider, not its own `github_copilot/` provider. What changes is
in [What Differs from the Direct Path](LITELLM.md#what-differs-from-the-direct-path).

### Endpoints

| Method and path | Token | What it does |
|---|---|---|
| `POST /v1/messages` | Required | Runs one turn. Returns JSON, or SSE when `stream` is `true`. |
| `POST /v1/messages/count_tokens` | Required | Returns an estimate, `ceil(JSON length / 4)` and at least 1, with the header `x-ghcp-token-count-method: estimated`. It never reaches Copilot. |
| `GET /v1/models` | Required | Discovery rows for Claude Code: the primary models Claude Code does not already know, which are the three GPT-6 models. |
| `GET /v1/models?all=true` | Required | Every model in the account's Copilot catalogue. The launchers use it to check that a model is available. |
| `GET /health` | Not required | `ok`, `instanceId`, `preferredModel`, `modelCount` and `capabilities`. |
| `HEAD /api/hello` | Not required | 200 with an empty body. |
| Any other method or path | Required | 404 `not_found_error`. Without a token the answer is 401 first. |

## Integration Rationale and Boundaries

Claude Code connects to other backends through a gateway: it sends Anthropic
Messages API requests to `ANTHROPIC_BASE_URL`. The Copilot SDK offers no such
HTTP API. It talks JSON-RPC to the Copilot runtime. The bridge is the adapter
between the two.

| Side | Who handles what |
|---|---|
| Claude Code | Terminal UI, conversation and transcripts, permissions, hooks, plugins, skills, MCP servers, and every tool execution. |
| Claude Code → bridge | The bridge implements the part of `/v1/messages`, SSE, token counting and model discovery that Claude Code uses. |
| Bridge → Copilot | The bridge drives SDK sessions, their streaming events and the pending external-tool RPC. |
| Tools | The bridge registers Claude Code's tools with Copilot as declarations only. When the model calls one, the bridge hands the call back to Claude Code, which runs it. |

Anthropic does not support routing non-Claude models through a gateway, and
the Copilot SDK does not provide a Claude Code integration. The support
boundary and the pinned SDK version are in the
[README](../README.md#not-supported).

SDK 1.0.14 ships Copilot runtime 1.0.85 in a platform package
(`@github/copilot-sdk-*`), and `CopilotClient` uses it unless `COPILOT_CLI_PATH`
names another runtime. A globally installed Copilot CLI is therefore not
necessarily the version serving bridge requests.

## Request Flow

1. Claude Code sends `POST /v1/messages` with the system prompt, the
   conversation, the tool schemas, and the `x-claude-code-session-id` and
   `x-claude-code-agent-id` headers.
2. The server checks the token ([Security Boundaries](#security-boundaries))
   and validates the body. Failures return 401 or 400.
3. The request policy logs sampling controls the SDK cannot apply and accepted
   fields the bridge ignores (`bridge.degraded_controls`). It emulates
   `tool_choice` by removing tools or adding an instruction; the rules are in
   [Unsupported Controls](COMPATIBILITY.md#unsupported-controls).
4. The model ID is resolved against the Copilot catalogue
   ([Model Discovery and Context](#model-discovery-and-context)), then the effort
   level ([Reasoning Effort](#reasoning-effort)).
5. The session manager reuses, resumes or creates an SDK session
   ([Session Isolation](#session-isolation)) on its one `CopilotClient`, which
   runs in mode `"empty"`. Every session gets Claude Code's system prompt as
   `systemMessage` with mode `replace`, each declared tool as a declaration
   with no handler (`defer: "never"`), `availableTools` limited to
   `custom:<name>` for those tools, SDK tool search and infinite sessions
   turned off, the resolved `reasoningEffort`, and the runtime MCP servers in
   `disabledMcpServers`.
6. The bridge sends the turn. A tool call from the model is returned to Claude
   Code as an Anthropic `tool_use` block.
7. Claude Code runs the tool and sends the `tool_result` in its next request.
   The bridge passes it to the waiting SDK turn with `handlePendingToolCall`.
8. When the turn ends, the bridge returns an Anthropic Messages response with
   the usage the SDK reported, and logs `bridge.turn_completed`. The stop reason
   is `tool_use` when the turn calls a tool, `refusal` after a content filter,
   `max_tokens` after a length finish, `stop_sequence`, or else `end_turn`.

Streaming details:

- Text streams as it arrives. Each tool call is written as one complete
  `tool_use` block at the end of the turn.
- At most one content block is open at a time, so each `content_block_stop`
  comes before the next `content_block_start`.
- The SSE response starts on the first root message, reasoning or tool-call
  delta, even an empty one. A failure before that returns a normal JSON error
  with its HTTP status. A failure after that is sent as an `event: error`
  frame. Reasoning text is never sent.
- While a stream is open, a `: ping` comment goes out every 15 seconds.
- User text that Claude Code sends next to tool results (skill reminders,
  messages queued in the TUI) is appended to the last tool result, so the
  model reads it in the same turn.

## Security Boundaries

The bridge is built for one person on one machine. These are the boundaries it
enforces and the data it keeps.

- **Network.** The bridge listens on `HOST`, default `127.0.0.1`. It refuses to
  start on any host other than `127.0.0.1`, `::1` or `localhost` unless
  `ALLOW_NON_LOOPBACK=1`. Every bridge `claude-ghcp` starts, in print mode or
  through `bridge-daemon.mjs ensure`, gets `HOST=127.0.0.1`. There is no TLS.
- **Token.** Every route except `GET /health` and `HEAD /api/hello` requires
  `BRIDGE_API_KEY`, sent as `Authorization: Bearer` or `x-api-key`. The bridge
  compares SHA-256 digests with `timingSafeEqual` and checks both headers on
  every request, so timing reveals neither where a guess differs nor which
  header held the key. The check runs before routing, so an unknown path
  without a token also gets 401. Without `BRIDGE_API_KEY` the bridge refuses to
  start unless `BRIDGE_ALLOW_UNAUTHENTICATED=1`. `claude-ghcp` and
  `bridge-daemon.mjs ensure` generate a random 24-byte token for each bridge.
- **Unauthenticated routes.** Any local process can call `GET /health` and read
  the bridge's `instanceId`, default model, model count and capabilities.
- **What reaches the model.** Claude Code's system prompt replaces Copilot's
  own. Sessions expose only Claude Code's declared tools (`custom:<name>`), so
  the runtime's built-in tools are unavailable, and the runtime's own MCP
  servers are disabled ([Copilot Runtime MCP Servers](#copilot-runtime-mcp-servers)).
  The bridge never runs a tool. A tool call that Copilot never registered, or
  whose name was not declared, is dropped and logged as
  `bridge.unregistered_tool_call`.
- **Credentials.** The bridge uses the Copilot CLI login in `COPILOT_HOME`.
  The Copilot runtime inherits the bridge's environment, so a `GH_TOKEN` or
  `GITHUB_TOKEN` set there reaches it. The bridge does not read or copy
  Anthropic credentials, and the launch settings blank `ANTHROPIC_API_KEY`.
- **Logs.** Diagnostics never contain request bodies, prompts, tool arguments,
  tool results or credentials; see [Logging](#logging).
- **Data sent to Copilot.** Everything Claude Code puts in a request, including
  the system prompt, the conversation, source code, tool results and
  attachments, goes to the GitHub Copilot service. It is handled under the
  signed-in account's plan, the organization's policy and GitHub's data terms.
  Review content exclusion and retention settings before use. Model use
  consumes GitHub Copilot AI Credits.
- **Not for shared hosts.** The bridge has no per-user authentication or
  authorization, and every caller uses one Copilot login and one
  `COPILOT_HOME`. Do not expose it on a network or share one bridge between
  people. A remote or shared deployment would need TLS, user authentication,
  authorization, and a separate Copilot identity and session store per tenant.

### Files the bridge keeps

The daemon directory is `GHCP_DAEMON_DIR`, or
`~/Library/Caches/claude-code-ghcp-sdk` on macOS and
`${XDG_CACHE_HOME:-~/.cache}/claude-code-ghcp-sdk` elsewhere. It and its
subdirectories are mode `0700`.

| File | Holds | Mode | Removed |
|---|---|---|---|
| `<daemon dir>/bridge.json` | The persistent bridge's port, token, PID, `instanceId`, start model and configuration fingerprint | `0600` | When the bridge is retired or stopped |
| `<daemon dir>/retired/<instanceId>.json` | The same record for a retired bridge, token included | `0600` | By a later launch that starts a new bridge, once that retired bridge has exited, or by `claude-ghcp-stop` |
| `<daemon dir>/settings/<random>.json` | One launch's Claude Code settings, bridge token included | `0600` | Kept after the launcher exits. Each later launch deletes files older than 24 hours. The whole directory is deleted when a launch stops the bridge instead of retiring it, and by `claude-ghcp-stop` |
| `<daemon dir>/leases/<instanceId>.<random>.pid` | The launcher shell's PID | `0600` | When the launcher exits. A launch that starts a new bridge deletes leases whose PID is dead. `claude-ghcp-stop` deletes them all |
| `<daemon dir>/bridge.log` | The persistent bridge's output and diagnostics | `0600` | By `claude-ghcp-stop` |
| `$TMPDIR/claude-ghcp.XXXXXX/` | A print-mode launch's settings file (`0600`) and bridge log | `0700` directory | When that launcher exits |
| `$TMPDIR/claude-litellm.XXXXXX/settings.json` | `claude-litellm` settings, LiteLLM key included | `0600` | When that launcher exits |
| `COPILOT_HOME` (default `~/.copilot`) | The Copilot CLI login, and the SDK session history of every bridge session: the conversation the bridge sent, including prompts, file contents and tool results | Copilot runtime's own | Kept, except the sessions the bridge discards ([Session Isolation](#session-isolation)) |

## Session Isolation

**Families.** A request belongs to the family named by its
`x-claude-code-session-id` and `x-claude-code-agent-id` headers; a missing agent
ID means the root agent. Requests without a session ID all share one anonymous
family for the life of the bridge process. Requests in one family run one at a
time, in order. Cancelling a queued request does not let the next one overtake
a turn that is already running.

**States.** Within a family, the bridge keys a cached SDK session (a state) by
the resolved model, the tool schemas and the system prompt. A request that
changes one of these gets a new state beside the old one
(`bridge.state_split`).

**Reuse.** The bridge reuses a state only while the incoming conversation
extends the one it holds. If the history no longer matches (for example after
Claude Code rewinds or compacts), or a sibling state has since advanced the
family, the bridge discards the state (`bridge.history_reconciled`) and starts
a fresh session. The comparison ignores `cache_control` markers and inline
`system` entries. Inline system text, such as custom agent definitions and
output styles, is merged into the SDK system message, with recognised
per-request token-budget notes removed. Any change to real user or assistant
content, tool inputs or system instructions counts as a different history.

**Resume and replay.** The SDK session ID is derived from a random value
chosen when the bridge process starts, the state key and a generation number.
Within one bridge process, an evicted state can be resumed from its SDK
session. After the process restarts the IDs differ, so earlier provider state
is never reused. A fresh session instead receives the earlier conversation as
text, up to `MAX_REPLAY_BYTES`, keeping the newest messages. This is called
cold replay. It keeps tool-use IDs, tool-result error flags and
`tool_reference` names.

**Eviction and discarding.** Normal eviction (the `MAX_STATES` and
`STATE_IDLE_TTL_MS` limits below) keeps the SDK session on disk, so it can be
resumed in the same process. Discarding a state deletes its SDK session from
`COPILOT_HOME`. The bridge discards a state after a history change or a context
limit, and when the state is invalidated by a failed effort change or by an
abort Copilot did not acknowledge within 5 seconds.

**Tool handoff.** The map from a Claude Code `toolCallId` to the SDK's pending
request lives in bridge memory. At the end of a turn the bridge waits for
Copilot to register each tool call before returning it.

**Limits.** These variables bound sessions and turns. Their defaults are in
[`.env.example`](../.env.example), and all of them are in the persistent
bridge's [configuration fingerprint](#persistent-bridge-and-retirement).

| Variable | What it bounds | When it is reached |
|---|---|---|
| `MAX_STATES` | Cached states | The least recently used idle states are evicted. |
| `STATE_IDLE_TTL_MS` | Idle time of a state with no active turn and no pending tool call | The state is evicted at the start of the next request. |
| `MAX_REPLAY_BYTES` | History replayed into a fresh session | Older messages are dropped and `bridge.history_replay_truncated` is logged. |
| `MAX_TOOL_RESULTS` | Tool results in one request | The request fails with 500. |
| `PENDING_TOOL_WAIT_MS` | Wait for Copilot to register a tool call | The call is dropped from the turn (`bridge.unregistered_tool_call`). |
| `SESSION_OPERATION_TIMEOUT_MS` | Each SDK `session.create`, `session.resume` and `session.set_model` call | The request fails with 500 (`bridge.session_operation_failed`). A late reply is discarded (`bridge.session_creation_abandoned`). |
| `TURN_IDLE_TIMEOUT_MS` | Time without progress in a turn. Root turn start, message and turn end events, and non-empty text, reasoning and tool-input deltas count as progress. Empty deltas and subagent events do not. | The turn is aborted and fails with 500 (`bridge.turn_timeout`, reason `timeout`). |
| `TURN_MAX_DURATION_MS` | Total length of one turn, even one that keeps streaming | The same, with reason `duration_limit`. |
| `CLEANUP_TIMEOUT_MS` | Each best-effort abort, disconnect or delete during cleanup | Cleanup moves on. |

A turn that times out while the runtime waits to retry an upstream failure
fails with 429 or 529 instead of 500; see [Upstream Errors](#upstream-errors).
Caller cancellation and shutdown also end session operations and turns.

## Copilot Runtime MCP Servers

The Copilot runtime loads the user's Copilot CLI configuration for every SDK
session, even in mode `"empty"`: the user `mcp-config.json`, workspace files,
installed Copilot plugins and the built-in `github-mcp-server`. None of these
servers can reach the model, because sessions expose only `custom:*` tools, but
the runtime would still start them for each session and stop them only when the
session closes. The bridge therefore disables them.

- At startup the bridge calls `mcp.discover` with its working directory to
  learn the registered server names. For the persistent bridge that is the
  daemon directory. A plugin server is named by its configuration key (for
  example `azure` for azmcp), not by its executable.
- It adds `github-mcp-server`, which discovery does not report, and passes the
  list as `disabledMcpServers` on every session create and resume. An empty
  `mcpServers` map does not replace the discovered servers, so it is not used.
- It logs the count as `bridge.mcp_servers_disabled`. If discovery fails or
  takes longer than 10 seconds, it logs `bridge.mcp_discovery_failed` and
  disables only the built-in server. If the SDK has no `mcp.discover`, it logs
  nothing and disables only the built-in server.
- It changes no Copilot configuration. Servers added while a bridge runs are
  picked up when the next bridge starts.

Claude Code's MCP servers are separate: Claude Code starts them, and the bridge
forwards their tools like any other declared tool. What disabling the runtime
servers saved is recorded in [Verification History](VERIFICATION_HISTORY.md).

## Model Discovery and Context

The six models in `/model`, their context windows and their effort levels are
listed under [Models](../README.md#models). This section explains how the
bridge produces that behaviour.

### Model IDs and the picker

The bridge strips a `github-copilot/claude-` prefix and a `[1m]` or `[Nk]`
suffix, then maps a Claude Code ID `claude-<family>-X-Y` to the Copilot ID
`claude-<family>-X.Y` for Opus, Sonnet and Haiku. So `claude-opus-5-5` becomes
`claude-opus-5.5`, `claude-sonnet-5` stays as it is, and the GPT-6 picker ID
`github-copilot/claude-gpt-6-sol[1m]` becomes `gpt-6-sol`. Plain Copilot IDs are
accepted too. The aliases `opus`, `sonnet` and `haiku` resolve to the first
family model the account can use: `opus` tries Opus 5.5, then Opus 5, then 4.8
down to 4.5, and `sonnet` tries Sonnet 5, then 4.6 and 4.5. An empty model or
`default` uses the bridge's start model (`GHCP_MODEL`). A model the account
cannot use fails with 400.

The six primary models are `PRIMARY_MODELS` in `src/model-map.mjs`, which the
verification catalogue also uses. The Direct launch settings list them, in
order, as `modelPicker` options with `replaceBuiltInOptions: true`; Claude Code
always adds its `Default` row. The `opus`, `sonnet` and `haiku` family settings
use the same IDs as their picker rows (`claude-opus-5-5[1m]`,
`claude-sonnet-5[1m]`, `claude-haiku-4-5`), so a family launch matches its row.
Claude Code accepts a listed row without asking the bridge, and sends a
one-token validation request for an ID outside the picker. `GET /v1/models`
lists only the primary models Claude Code does not already know: the three
GPT-6 models, each with `[1m]` when its catalogue window is at least 1,000,000
tokens. `?all=true` and `ghcp-models` list the whole catalogue.

### Context windows

Claude Code sizes its window from the model ID, and behind a gateway it gives a
bare Claude ID 200K. The launcher therefore adds `[1m]` to every model the
bridge knows to have a window of at least 1M: Opus 5.5, Sonnet 5 and the three
GPT-6 models, and, when selected explicitly, GPT-5.6 Sol, Terra and Luna and
Claude Opus 5, 4.8 and 4.7. Haiku 4.5 gets no hint and keeps Claude Code's own
200K window. The launch settings clear `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, so the
window follows the selected model: switching from a 1M row back to Haiku
restores 200K. Claude Code's auto-compaction and any smaller window a user sets
still apply.

The Copilot runtime has its own input limit per session, and that limit depends
on the context tier. The bridge asks for `contextTier: "long_context"` only for
a model on the list above whose catalogue entry reports a window of at least
1,000,000 tokens. For those it also passes the catalogue's context, prompt and
output limits, on create, resume and effort changes. Every other model stays on
the default tier.

`bridge.context_budget` logs the limit the runtime applies. These are the
limits logged at commit `bed30ce`:

| Model | SDK tier | Runtime input limit | Reached before Claude Code's auto-compact? |
|---|---|---|---|
| GPT-6 Astra | long context | 1,050,000 | No |
| Claude Sonnet 5 | long context | 936,000 | Yes |
| Claude Opus 5.5 | long context | 872,000 | Yes |
| GPT-6 Sol | long context | 872,000 | Yes |
| GPT-6 Luna | long context | 872,000 | Yes |
| Claude Haiku 4.5 | default | 136,000 | Yes |

Claude Code auto-compacts at about 967K of a 1M window and about 167K of Haiku's
200K window. Every model except Astra therefore reaches the runtime limit first
and depends on the overflow handling below. The limits come from the Copilot
catalogue and runtime and can change without a bridge change.

### Context overflow

The runtime can compact or truncate a session's history even though the bridge
turns infinite sessions off. The bridge never keeps serving from a silently
reduced history:

- If the reduction happened between requests, the next request discards the
  state and fails before any output with 400 `invalid_request_error`:
  `prompt is too long: GitHub Copilot would reduce conversation history at N
  input tokens. Compact the conversation before retrying.` That wording makes
  Claude Code compact its conversation and retry.
- If it happens during a turn, the bridge aborts the turn
  (`bridge.turn_aborted`, reason `context_limit`) and returns the same error, as
  an HTTP 400 if nothing has been streamed yet and as an `event: error` frame
  otherwise.
- `bridge.context_limit` records which of the two happened.

A `session.error` whose `errorType` is `context_limit` is a different case. It
becomes 500 `api_error`; see [Upstream Errors](#upstream-errors).

### Usage accounting

Copilot reports input tokens including cached tokens; Anthropic reports three
separate counts. The bridge returns uncached input as
`max(0, inputTokens - cacheReadTokens - cacheWriteTokens)`, with Copilot's cache
counts as `cache_read_input_tokens` and `cache_creation_input_tokens`, so a
cached 230K-token request is not shown as about 460K. Explicit zeros stay zero.
Only missing usage is replaced by an estimate, and a counter missing from any
SDK usage event leaves that total unknown rather than zero. This fixes the
counts only: `cache_control` markers have no effect; see
[Structural Limits](COMPATIBILITY.md#structural-limits).

## Reasoning Effort

`/effort` and `--effort` reach the bridge as `output_config.effort`. The value
`ultracode` becomes `xhigh`. The bridge then checks the level against the
model's catalogue entry:

- A model without effort support gets no effort; the value is dropped.
- A level the model lists is passed as is. A level it does not list becomes the
  highest listed level below it, or the lowest listed level if none is below.
- A value that is not one of `none`, `minimal`, `low`, `medium`, `high`,
  `xhigh` or `max` fails with 400 when the model lists its levels. A model that
  supports effort without listing levels gets the value unchanged.

Sessions are created and resumed with the resolved `reasoningEffort`. When the
effort changes within a Claude Code session, including a reset to the default,
the bridge calls `session.setModel()` so the next turn uses it and the
conversation is kept. Workflow orchestration and tool execution stay with
Claude Code.

## Launch Settings

The launchers pass their settings to Claude Code only through the command-line
`--settings` file, and Claude Code's own precedence still applies; see
[Your settings are left alone](../README.md#your-settings-are-left-alone). The
file contains these keys.

| Key | Direct (`claude-ghcp`) | LiteLLM (`claude-litellm`) |
|---|---|---|
| `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` | The bridge URL and token | `LITELLM_BASE_URL` and `LITELLM_API_KEY` |
| `ANTHROPIC_MODEL` | The launch model, with `[1m]` where it applies | `LITELLM_MODEL` |
| `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`, with `_NAME` and `_DESCRIPTION` | `claude-opus-5-5[1m]`, `claude-sonnet-5[1m]`, `claude-haiku-4-5` | `LITELLM_{OPUS,SONNET,HAIKU}_MODEL`, default `LITELLM_MODEL` |
| `ANTHROPIC_SMALL_FAST_MODEL` | The haiku family model | The haiku family model |
| `ANTHROPIC_CUSTOM_MODEL_OPTION`, with `_NAME` and `_DESCRIPTION` | The launch model, blank when it is a family model | The same rule |
| `CLAUDE_CODE_SUBAGENT_MODEL` | The launch model, blank when it is a family model | The same rule |
| `CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP` | `1` | `1` |
| `ANTHROPIC_API_KEY`, `CLAUDE_CODE_USE_{AWS,BEDROCK,FOUNDRY,MANTLE,VERTEX}`, `ANTHROPIC_DEFAULT_MODEL`, `ANTHROPIC_DEFAULT_FABLE_MODEL` with `_NAME` and `_DESCRIPTION` | Blank | Blank |
| `ENABLE_TOOL_SEARCH` | Blank. `true` when `GHCP_NATIVE_TOOL_SEARCH=1` | Blank |
| `modelPicker` | The six primary rows, replacing the built-in ones | Not set |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | `1` | Not set |
| `CLAUDE_CODE_ATTRIBUTION_HEADER` | `0` | Not set |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | Blank | Not set |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | Not set | `1` |

- A family model is one of the three `ANTHROPIC_DEFAULT_*_MODEL` values. The
  LiteLLM family aliases default to `LITELLM_MODEL`, so by default a LiteLLM
  launch model is a family model and both of its rows are blank.
- `CLAUDE_CODE_SUBAGENT_MODEL` makes subagents that name no model use the launch
  model. Its blank value also keeps a value from the shell out.
- `CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP=1` is needed because Claude Code
  otherwise caps the Explore subagent at the `opus` alias whenever the main
  model is not named haiku, sonnet or opus. That sent a GPT session's Explore
  work to Opus.
- The blanked provider selectors and inherited model options keep shell or user
  values from sending requests somewhere other than the gateway.
- With `ENABLE_TOOL_SEARCH` blank, Claude Code's native tool search and
  `tool_reference` are off and the model gets the full declared tool set.
  `GHCP_NATIVE_TOOL_SEARCH=1`, read on each Direct launch, turns Claude Code's
  tool search on. The SDK's own tool search is always off, because
  declaration-only tools can stall under it.

## Persistent Bridge and Retirement

Print mode starts a private bridge with a random token and stops it on exit.
Every other launch shares one persistent bridge, started by
`src/bridge-daemon.mjs ensure`. Which launches use which, and how to check and
stop the bridge, are in [The background bridge](../README.md#the-background-bridge).
The persistent bridge exists because `/background` hands an interactive
session to Claude Code's own daemon: that job keeps calling the bridge, and
Claude Code respawns it from its `--settings` file, after the launcher has
exited.

**Configuration fingerprint.** The registry `bridge.json` stores a SHA-256 over
everything that decides how a bridge behaves. A launch reuses the registered
bridge only when the fingerprint matches, the PID is alive and `/health`
reports the registered `instanceId`. The fingerprint covers:

- the value of every environment variable whose name starts with `COPILOT_` or
  `MAX_`, and of `CLEANUP_TIMEOUT_MS`, `PENDING_TOOL_WAIT_MS`,
  `SESSION_OPERATION_TIMEOUT_MS`, `STATE_IDLE_TTL_MS`, `TURN_IDLE_TIMEOUT_MS`,
  `TURN_MAX_DURATION_MS`, `RETIRED_IDLE_MS`, `LOG_LEVEL`, `GH_CONFIG_DIR`,
  `GH_TOKEN`, `GITHUB_TOKEN`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and
  `HOME`;
- the checkout's absolute path, `package.json`, `package-lock.json` and the
  contents of every `src/*.mjs` file;
- the requested port (`GHCP_BRIDGE_PORT` or `--bridge-port`).

The names are case-sensitive, so lowercase `http_proxy`, `https_proxy` and
`no_proxy` do not count. A variable set to an empty value differs from one that
is unset. Unrelated variables with those prefixes, such as
`MAX_THINKING_TOKENS`, count too. Not included: the model (a reused bridge
serves any launch model after checking that it is available), `GHCP_MODEL`,
`GHCP_NATIVE_TOOL_SEARCH`, `GHCP_DAEMON_DIR` and `BRIDGE_TEST_FAULTS`. The
bridge inherits the whole environment of the launch that started it, so
variables outside the fingerprint keep that launch's values.

**Per launch.** Concurrent launches take turns through `bridge.lock`. A new
bridge must answer `/health` within 60 seconds and list the launch model in
`/v1/models?all=true`, or the launch fails. `ensure` returns the registry, a new
settings file path under `settings/` (allocating it deletes settings files
older than 24 hours) and a lease path `leases/<instanceId>.<random>.pid`. A
lease is a file holding the launcher shell's PID. The launcher writes it and
removes it on exit.

**Retirement.** A retired bridge has been replaced but keeps serving the
sessions that already use it. When the fingerprint differs, the old bridge is
retired if its PID is alive, `/health` confirms its `instanceId`, it reports
`capabilities.retirement`, and the new launch is not pinned to its port.
Retiring moves its record to `retired/`, sends it `SIGUSR2` and starts a new
bridge. The retired bridge logs `bridge.retired` and checks every 30 seconds
whether it can exit. It exits (`bridge.retired_exit`) when it has no request in
flight, has had no `/v1/messages` or `count_tokens` request for
`RETIRED_IDLE_MS`, and no lease naming it holds a live PID. The idle window
covers sessions that hold no lease, such as a `/background` job whose launcher
has exited, or LiteLLM.

**Stopping instead.** If any retirement condition fails (no registered bridge,
a dead PID, a failed `/health` check, no retirement capability, or a new launch
pinned to the old bridge's port), `ensure` stops the old bridge (`SIGTERM`, then
`SIGKILL`) and deletes the whole `settings/` directory, even settings files
that sessions on still-running retired bridges need. A launch pinned to a
port also stops any retired bridge still holding that port. If a live PID
cannot be confirmed as the registered bridge, `ensure` fails and keeps the
registry. For LiteLLM, which reaches the bridge on a pinned port, the
consequences are in [When the Bridge Is Replaced](LITELLM.md#when-the-bridge-is-replaced).

**Status and stop.** `claude-ghcp-status` reports the model the bridge started
with and never prints the token. `claude-ghcp-stop` stops the current bridge and
every retired one and deletes the files listed under
[Security Boundaries](#security-boundaries).

**Working directory.** The persistent bridge runs in the daemon directory, not
in the project that started it. That project could be deleted while the bridge
runs, and runtime MCP discovery would otherwise read its workspace
configuration for every other project's sessions.

## Logging

The bridge writes content-free diagnostics: one JSON object per line, with no
request bodies, prompts, tool arguments, tool results, attachments or
credentials. `bridge.started`, `bridge.retired` and `bridge.retired_exit` go to
stdout and every other event to stderr, whatever `LOG_LEVEL` says; `LOG_LEVEL`
sets only the Copilot runtime's own log level. Both streams go to one file:
`$TMPDIR/claude-ghcp.XXXXXX/bridge.log` in print mode, deleted when the
launcher exits, and `bridge.log` in the daemon directory for the persistent
bridge, kept until `claude-ghcp-stop` deletes it. A failure other than a client
abort also writes a plain line `[<requestId>] <ErrorName>: <message>`. That
message can name a model or tool, or carry upstream error text.

`npm test` asserts these event and field names, so treat them as a stable
interface. `npm run verify` copies the logs into each slot's directory but does
not parse them.

| Event | When | Fields |
|---|---|---|
| `bridge.started` | The server starts listening | `address`, `preferredModel`, `models` |
| `bridge.request_failed` | A `/v1/messages` request fails: 401, a 400 body error, or any later failure including 499 | `requestId`, `status`, `errorType`, `retryAfterSeconds`, `streaming` (the request asked for SSE), `headersSent` (a response had already started) |
| `bridge.turn_completed` | A `/v1/messages` response has been sent | `requestId`, `responseId`, `requestedModel`, `model`, `servedModels`, `claudeAgent` (`root` or `subagent`), `inputTokens`, `outputTokens`, `usageReported`, `stopReason`, `toolUses` |
| `bridge.degraded_controls` | A request carries a sampling control the SDK cannot apply, or an accepted field the bridge ignores | `controls`, `ignoredFields` (when any), `semantics` |
| `bridge.mcp_servers_disabled` | Startup, after `mcp.discover` | `count`, including `github-mcp-server` |
| `bridge.mcp_discovery_failed` | MCP discovery failed or took longer than 10 seconds | `error`, `message` (at most 200 characters) |
| `bridge.context_budget` | A session reports a new runtime input limit | `model`, `contextTier`, `tokenLimit`, `currentTokens` |
| `bridge.context_limit` | Copilot reduced a session's history | `model`, `phase` (`between_requests` or `active_turn`), `tokenLimit`. `active_turn` adds the turn-report fields |
| `bridge.history_reconciled` | The conversation no longer extends the cached state, or the state is stale | `currentMessages`, `previousMessages`, `reason` (`history_diverged` or `identity_stale`) |
| `bridge.state_split` | A new state starts beside an existing one in the same family | `family` (a hash), `changes` (any of `model`, `toolSignature`, `systemHash`) |
| `bridge.history_replay_truncated` | Replay into a fresh session exceeded `MAX_REPLAY_BYTES` | `maxBytes`, `messages` |
| `bridge.session_operation_failed` | `session.create`, `session.resume` or `session.set_model` failed or timed out | `operation`, `requestId`, `responseId`, `reason` (`aborted`, `timeout` or `error`), `elapsedMs`, `timeoutMs` |
| `bridge.session_creation_abandoned` | A create or resume finished after its wait had been given up; the late session is removed | None |
| `bridge.session_cleanup_failed` | Removing that late session failed | `operation` |
| `bridge.turn_timeout` | The idle timeout (`reason` `timeout`) or the hard cap (`reason` `duration_limit`) fired | Turn-report fields, `reason` |
| `bridge.turn_aborted` | The client cancelled (`reason` `client_abort`) or a context limit hit the turn (`reason` `context_limit`) | Turn-report fields, `reason` |
| `bridge.turn_abort_completed` | After either of the two above | Turn-report fields, `reason`, `acknowledged`, `abortElapsedMs` |
| `bridge.unregistered_tool_call` | A tool call Copilot never registered, or with an undeclared name, was dropped | `tool`, `toolCallId` |
| `bridge.test_fault_injected` | `BRIDGE_TEST_FAULTS` used up one fault (tests only) | `requestId`, `kind`, `remaining` |
| `bridge.retired` | The bridge received `SIGUSR2` and is retired | `retired`, `inFlight`, `idleMs`, `leases` |
| `bridge.retired_exit` | A retired bridge exits | `retired`, `inFlight`, `idleMs`, `leases` |
| `bridge.diagnostic_error` | Writing a turn diagnostic failed; the request itself is unaffected | `diagnosticEvent`, `requestId`, `responseId` |

The turn-report fields are `timestamp`, `requestId`, `responseId`, `state` (a
hash), `model`, `elapsedMs`, `turnElapsedMs`, `idleMs`, `stage` (`send`,
`tool_result`, `tool_registration`, `trigger` or `model`), `triggerFinished`,
`turnStarted`, `completionStarted`, `deferredCompletion`, `upstreamRetryStatus`,
`messages`, `toolRequests`, `usageEvents`, `pendingToolCalls`,
`pendingRegistrations`, `rpc` (started, acknowledged and failed counts for send
and tool result), `eventCounts` and `recentEvents` (at most eight, each with type,
scope and elapsed time).

`GET /health` lists the sampling controls the SDK cannot apply as
`capabilities.unsupportedNativeControls` and the accepted fields the bridge
ignores as `capabilities.ignoredRequestFields`. Both lists come from
`src/request-policy.mjs` and are explained in
[Unsupported Controls](COMPATIBILITY.md#unsupported-controls).

## Upstream Errors

This is how every failure leaves the bridge (`errorResponse` in
`src/server.mjs`, `sessionError` in `src/upstream-errors.mjs`).

| Condition | Status | Error type |
|---|---|---|
| Missing or wrong token, on any route except `GET /health` and `HEAD /api/hello` | 401 | `authentication_error` |
| Authenticated request to an unknown method or path | 404 | `not_found_error` |
| Body larger than `MAX_BODY_BYTES`, invalid JSON, or a malformed shape. There is no 413 | 400 | `invalid_request_error` |
| `tool_choice` of `any` with no tools, a named tool that is not declared, or an unsupported mode | 400 | `invalid_request_error` |
| A model the account's Copilot catalogue does not have | 400 | `invalid_request_error` |
| An effort value that is not a known level, for a model that lists its levels | 400 | `invalid_request_error` |
| Copilot started reducing the session's history (the `prompt is too long` error in [Context overflow](#context-overflow)) | 400 | `invalid_request_error` |
| SDK `session.error` with `errorType` `rate_limit` or `quota`, or `statusCode` 429 | 429 | `rate_limit_error` |
| SDK `session.error` with a `statusCode` from 500 to 599 | 529 | `overloaded_error` |
| A turn times out while the runtime waits to retry an upstream 429 or 5xx (below) | 429 or 529 | `rate_limit_error` or `overloaded_error` |
| The client disconnected or cancelled, also while queued. A JSON body is written only if no response has started | 499 | `client_closed_request` |
| A turn times out with no upstream retry pending | 500 | `api_error` |
| Anything else: a session operation timeout, any other `session.error` (other upstream 4xx, `errorType` `context_limit`), more than `MAX_TOOL_RESULTS` tool results, a tool result Copilot rejects, an internal error | 500 | `api_error` |

- Once an SSE response has started, a failure is sent as an `event: error`
  frame with the error type above; the HTTP status is already 200.
- Claude Code retries 429 and 529 by itself.
- SDK error events carry no retry time, so a real upstream failure gets no
  `retry-after` header.

**Upstream retry wait.** The Copilot runtime retries an upstream 429 or 5xx by
itself first. It waits out any upstream `retry-after` and sends no events while
it waits. When its retries run out it ends the turn and only then reports
`session.error`. A root turn that ended without a message therefore waits for
that error, or for the idle event that follows, instead of finishing as an
empty success. If the idle timeout or the hard cap fires while the last root
`model.call_failure` had status 429 or 5xx, and neither progress nor a new
`model.call_start` has followed, the request fails with that status mapped to
429 or 529, not 500. `bridge.turn_timeout` records the status as
`upstreamRetryStatus`. How long these waits took in one live check is in
[Verification History](VERIFICATION_HISTORY.md).

**Test faults.** `BRIDGE_TEST_FAULTS` is a test hook, not a feature. For example
`BRIDGE_TEST_FAULTS="rate_limit:1,overloaded:1"` fails that many requests that
declare tools, in the listed order, before they reach Copilot. The kinds are
`rate_limit` and `overloaded`, which go through the same mapping as real
upstream failures, and `context_limit`, which raises the bridge's own
`prompt is too long` error. Only `npm test` sets it, so the live matrix does not
exercise this mapping.

## Known Constraints

These are limits of the implementation. Feature-level limits are in
[Compatibility](COMPATIBILITY.md). A turn in flight when the bridge exits, and
repeated requests other than tool-result retries, are gaps listed in
[Not Yet Implemented](COMPATIBILITY.md#not-yet-implemented).

- **Each Claude Code release needs a compatibility review.** The bridge
  translates to the Copilot SDK instead of forwarding to Anthropic, so a header
  or body field that a new Claude Code release adds is not supported
  automatically.
- **SDK and runtime upgrades need testing.** The bridge depends on the SDK's
  pending external-tool RPC.
- **Binary tool results depend on the provider.** Image and document blocks in
  a request are translated. Binary images or documents returned by a local tool
  may need a text fallback or an initial attachment.
- **One user, one machine.** See [Security Boundaries](#security-boundaries).

## Validation Scope

Two commands test the bridge. `npm test` is offline and free. `npm run verify`
drives real Claude Code against real Copilot models and spends GitHub Copilot
AI Credits. The last full run passed 66 of 66 slots on commit `bed30ce`, and
the matrix has not been re-run since. What that run covers, and the code
changes after it, are under [Verified](../README.md#verified) and
[Not verified](../README.md#not-verified). The run itself is in
[Verification Results](VERIFICATION.md); earlier runs and one-off live checks
are in [Verification History](VERIFICATION_HISTORY.md).

### What `npm test` covers

`npm test` runs the bridge, the settings writers, the daemon and the
verification harness against a fake Copilot SDK client. It proves translation,
session bookkeeping, error mapping and settings generation, not how a real
model or a real Claude Code build behaves.

| Area | What the tests check |
|---|---|
| Translation | Messages text, attachments, tool results and SSE conversion, one open content block at a time, sibling user text folded into the last tool result, explicit zero usage kept and only missing usage estimated |
| Models and effort | Model ID and family alias translation, the six-row picker, per-model `[1m]` hints, discovery rows, `ultracode` → `xhigh`, per-model effort adjustment, `session.setModel()` on effort changes |
| Sessions | Root and subagent isolation, interleaved root and worker tool results across six models, siblings surviving a cancellation, forked-subagent history, tool-call handoff with `agentId`, cancellation, eviction, bounded replay, tool-result idempotency, runtime MCP discovery and `disabledMcpServers` with the failure and timeout fallback |
| Errors | 429 and 529 mapping through `BRIDGE_TEST_FAULTS`, the retry-wait timeout variant, the request policy, strict model selection |
| Launch and daemon | Direct and LiteLLM settings values, including the subagent model on both paths and the Explore setting on the Direct path only, mode `0600` files, LiteLLM base-URL checks, the daemon registry, retirement and leases, entry points reached through a symlink, detection of the user's current Claude provider (used by `ghcp-doctor`) |
| Diagnostics | Event and field names |
| Harness | The strict pass policy, report generation, drivers, timeouts and media fixtures |

### What `npm run verify` runs

- **Slots.** Six models × 11 scenarios = 66 slots. A slot is one model running
  one scenario. Each scenario's purpose and pass criteria are in
  [Scenarios](VERIFICATION.md#scenarios).
- **v01 to v10.** Each slot starts its own bridge, with its own port, token,
  `CLAUDE_CONFIG_DIR`, a `settings.json` from the Direct settings writer, and a
  workspace in a temporary directory outside the checkout. It runs the real
  `claude` binary against that bridge with `-p --output-format stream-json`.
- **v11.** The slot runs `bin/claude-ghcp` itself (`--background`, then `-p`,
  then `agents --json --all`) and the daemon it starts, with a slot-local
  `GHCP_DAEMON_DIR`. The harness's own bridge for that slot is unused. The slot
  keeps each command's output and copies the daemon's `bridge.log` and Claude
  Code's daemon log before stopping. From the background job's state it keeps
  only state and timing fields, never its environment or socket keys.
- **Not run.** No slot uses LiteLLM. No scenario drives the interactive TUI,
  although `scripts/verify/tui.mjs` can.
- **Judging.** Each slot is judged from files on disk, git history, hook logs
  and the stream's own record of which tools ran. Every phase must also report
  a stop reason, positive input usage and no error in the result envelope.
  Model text is checked for a token the scenario planted, with two exceptions:
  v05 compares a claim that every step is done with the files, and v08
  requires the answer to say the command was blocked.
- **Outcomes.** A slot is `pass`, `fail` or `blocked`. `blocked` means the slot
  could not be judged: the run did not complete (a timeout, a launch failure,
  no result event), `tool_use` and `tool_result` did not pair up, `modelUsage`
  did not name the expected model, a phase did not run, or the harness itself
  failed. v11 reports only pass or fail except for a harness failure. A blocked
  slot is never a pass and stays in the count.

**Strict pass policy** (`strict-all-pass-v1` in `summary.json`). A run passes
only if every expected slot passes: all 66 in a full run, or every selected slot
in a focused run (`--models` or `--scenarios`). A focused pass is not a full
pass. The run also fails if a slot is missing, duplicated or unexpected, if
`~/.claude/settings.json` changed (the runner compares SHA-256 digests and never
stores the contents), or if the code changed during the run. For the code it
records the git commit and a SHA-256 over `src/`, `scripts/verify/`, `bin/` and
the root package files at the start and the end, so a checkout with uncommitted
changes can pass if nothing changes in between. The weighted feature coverage
the runner prints describes the scenario catalogue, not a pass rate.

**What the model check proves.** The harness accepts a slot when a key of
Claude Code's `result.modelUsage` contains the expected Copilot or Claude Code
model ID. Those keys are the model IDs Claude Code requested, so the check
proves Claude Code asked for the right model, not which model Copilot served.
The bridge records the served model in `bridge.turn_completed` `servedModels`,
which the harness keeps in the slot's bridge log but does not check. v11 has no
model check.

### Commands and flags

```bash
npm test                 # offline tests, no model calls, no credits
npm run verify           # the full matrix with default settings
npm run verify:plan      # check the catalogue and print coverage; starts nothing
npm run verify:report    # print the newest run from its own record

# One slot, while working on a driver
npm run verify -- --models claude-opus-5.5 --scenarios v04-shell-ops

# The settings the last passing full run used
PENDING_TOOL_WAIT_MS=30000 npm run verify -- \
  --timeout-scale 2 --model-concurrency 3 --scenario-concurrency 2
```

| Flag | Default | Effect |
|---|---|---|
| `--models a,b` | All six | Run only these Copilot model IDs. |
| `--scenarios id,id` | All 11 | Run only these scenario IDs. |
| `--model-concurrency N` | 6 | How many models run at once. |
| `--scenario-concurrency N` | 2 | How many scenarios run at once for each model. |
| `--timeout-scale X` | 1 | Multiplies the harness's waits (below). |
| `--out DIR` | `.verify-runs/` | Where run directories are written. |
| `--dry-run` | Off | Prints the plan, coverage and a single-turn schedule estimate, then exits. Starts nothing. |
| `--keep-workspaces` | Off | Keeps the workspace of every slot. Workspaces of slots that did not pass are always kept. |

- **`--timeout-scale`** multiplies each headless Claude Code run's budget (per
  run, not per slot), plan turns, v11's launcher and output waits, and the
  bridge-health wait. v11's catalogue budget feeds only the schedule estimate.
  Status, list, stop and cleanup commands, polling, the kill grace period and
  the launcher's and daemon's own startup limits are not scaled.
- **`PENDING_TOOL_WAIT_MS`** is a bridge setting, not a harness flag. Set in the
  shell, it reaches every harness bridge and the v11 launcher, unscaled, and is
  recorded in `summary.json` under `execution`.

Each run is written to `.verify-runs/<timestamp>/`: `summary.json`,
`slots.jsonl` and one directory per slot with its bridge log, settings and
transcripts. `.verify-runs/` is gitignored and stays on the local machine.

**Publishing a result.** `npm run verify:doc` regenerates
[Verification Results](VERIFICATION.md) and its Korean twin from the newest run,
which may be a focused or incomplete one. To publish a specific completed full
run, name its directory and use it for both languages:

```bash
run_dir=".verify-runs/<completed-run-id>"
node scripts/verify/report.mjs "$run_dir"
node scripts/verify/report.mjs "$run_dir" --markdown > docs/VERIFICATION.md
node scripts/verify/report.mjs "$run_dir" --markdown=ko > docs/VERIFICATION_KO.md
```

## Key Files

| File | Role |
|---|---|
| `bin/claude`, `bin/claude-ghcp` | Direct launcher (`bin/claude` runs `claude-ghcp`): chooses the persistent or print-mode bridge, writes the launch settings, starts Claude Code |
| `bin/claude-ghcp-status`, `bin/claude-ghcp-stop` | Persistent bridge status and stop |
| `bin/claude-litellm` | LiteLLM launcher with temporary settings |
| `bin/claude-current` | Runs Claude Code with its original provider |
| `bin/ghcp-doctor`, `bin/ghcp-models` | Environment check and model list |
| `bin/resolve-claude.sh` | Finds the real Claude Code binary |
| `src/server.mjs` | HTTP and SSE server, authentication, body validation, error mapping, diagnostics |
| `src/session-manager.mjs` | SDK sessions, families, reuse, replay, timeouts, tool handoff, runtime MCP discovery |
| `src/anthropic.mjs` | Anthropic Messages request and response translation, SSE, usage, effort extraction |
| `src/request-policy.mjs` | `tool_choice` emulation, unsupported controls and ignored fields |
| `src/model-map.mjs` | Model IDs, aliases, picker, context hints and tiers, effort resolution |
| `src/upstream-errors.mjs` | Copilot rate limits and upstream 5xx mapped to 429 and 529, test faults |
| `src/bridge-daemon.mjs`, `src/retirement.mjs` | Persistent bridge: registry, fingerprint, leases, retirement, status and stop; when a retired bridge may exit |
| `src/claude-gateway-env.mjs`, `src/write-launch-settings.mjs`, `src/write-litellm-settings.mjs` | Settings shared by both paths, and the Direct and LiteLLM settings files (mode `0600`) |
| `src/copilot-home.mjs`, `src/copilot-session-rpc.mjs`, `src/entry-point.mjs` | `COPILOT_HOME` resolution, SDK session RPC helpers, entry-point detection through symlinks |
| `src/doctor.mjs`, `src/list-models.mjs`, `src/model-cli.mjs`, `src/provider-detection.mjs`, `src/settings-file-state.mjs`, `src/version.mjs` | Command-line helpers |
| `scripts/verify/`, `test/` | The live verification harness, and `npm test` |

## References

- [GitHub Copilot SDK](https://github.com/github/copilot-sdk)
- [Copilot SDK multi-tenancy and `mode: empty`](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/multi-tenancy)
- [Copilot SDK Node.js API](https://github.com/github/copilot-sdk/blob/main/nodejs/README.md)
- [Copilot SDK manual external-tool handoff](https://github.com/github/copilot-sdk/blob/main/nodejs/samples/manual-tool-resume.ts)
- [Copilot SDK streaming events](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events)
- [Copilot SDK authentication](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate)
- [GitHub Copilot supported models](https://docs.github.com/en/copilot/reference/ai-models/supported-models)
- [Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol)
- [Claude Code third-party gateway support boundary](https://code.claude.com/docs/en/llm-gateway)
- [Claude Code gateway configuration](https://code.claude.com/docs/en/llm-gateway-connect)
- [Claude Code model and effort configuration](https://code.claude.com/docs/en/model-config)
- [Claude Code dynamic workflows](https://code.claude.com/docs/en/workflows)
- [Claude Code settings](https://code.claude.com/docs/en/settings)
