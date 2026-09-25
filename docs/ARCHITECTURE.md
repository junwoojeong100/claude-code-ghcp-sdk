# Architecture

> **Language / 언어:** English | [한국어](ARCHITECTURE_KO.md)

This bridge lets Claude Code use GitHub Copilot models. It is a local HTTP
server that speaks the Anthropic Messages API to Claude Code and drives the
public `@github/copilot-sdk` on the other side. It calls no undocumented Copilot
endpoint. It is an unofficial integration.

This is the maintainer reference for request flow, sessions and storage. To
install and run it, see the [README](../README.md). For the other gateway path,
see [LiteLLM](LITELLM.md); for feature-level support, see
[Compatibility](COMPATIBILITY.md#feature-lookup).

**On this page:** [Requests](#request-flow) · [Security](#security-boundaries) ·
[Sessions](#session-isolation) · [Models](#model-discovery-and-context) ·
[Launch settings](#launch-settings) · [Daemon](#persistent-bridge-and-retirement)

**Other maintainer guides:** [Diagnostics](DIAGNOSTICS.md) · [Testing](TESTING.md)

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
| `GET /health` | Not required | `ok`, `instanceId`, `preferredModel`, `modelCount` and `capabilities`, plus the bridge's runtime `timeouts` when `BRIDGE_VERIFY_OBSERVE=1`. |
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
   `max_tokens` after a length finish, `stop_sequence` when Copilot reports a
   stop-sequence finish, or else `end_turn`.

Streaming details:

- Text streams as it arrives. Each tool call is written as one complete
  `tool_use` block at the end of the turn. A tool call ID that Copilot repeats
  within one turn is returned once, in JSON and SSE alike, and counted once in
  `bridge.turn_completed.toolUses`.
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
  The token never appears on a command line, where any local user could read
  it: the bridge gets it as `BRIDGE_API_KEY`, and `claude-ghcp` hands it to its
  model check and to `write-launch-settings.mjs` as `GHCP_BRIDGE_TOKEN`. Claude
  Code reads it from the settings file as `ANTHROPIC_AUTH_TOKEN` and sends it as
  `Authorization: Bearer`.
- **Unauthenticated routes.** Any local process can call `GET /health` and read
  the bridge's `instanceId`, default model, model count and capabilities, and,
  on a bridge started with `BRIDGE_VERIFY_OBSERVE=1`, its timeout budgets.
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
- **Logs.** Request/turn summaries omit prompts, tool contents and credentials.
  The combined log can also contain unsanitized error text; review it before
  sharing. See [Logging](DIAGNOSTICS.md#logging).
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
subdirectories are mode `0700`. A relative `GHCP_DAEMON_DIR` is resolved against
the directory the launch runs from. A value starting with `~` is refused,
because it is not expanded.

| File | Holds | Mode | Removed |
|---|---|---|---|
| `<daemon dir>/bridge.json` | The persistent bridge's port, token, PID, `instanceId`, start model and configuration fingerprint | `0600` | When the bridge is retired or stopped |
| `<daemon dir>/retired/<instanceId>.json` | The same record for a retired bridge, token included | `0600` | By a later launch that starts a new bridge, once that retired bridge has exited, or by `claude-ghcp-stop` |
| `<daemon dir>/settings/<random>.json` | One launch's Claude Code settings, bridge token included | `0600` | Kept after the launcher exits. Each later `bridge-daemon.mjs ensure` (which every `claude-ghcp` launch other than print mode runs) deletes files older than 24 hours. The whole directory is deleted when a launch stops the bridge instead of retiring it, and by `claude-ghcp-stop` |
| `<daemon dir>/leases/<instanceId>.<random>.pid` | The launcher shell's PID | `0600` | When the launcher exits. A launch that starts a new bridge deletes leases whose PID is dead. `claude-ghcp-stop` deletes them all |
| `<daemon dir>/bridge.log` | The persistent bridge's output and diagnostics | `0600` | By `claude-ghcp-stop` |
| `$TMPDIR/claude-ghcp.XXXXXX/` | A print-mode launch's settings file (`0600`) and bridge log | `0700` directory | When that launcher exits |
| `$TMPDIR/claude-litellm.XXXXXX/settings.json` | A print-mode `claude-litellm` run's settings (`-p` without `--background` or `--bg`), LiteLLM key included | `0600` | When that launcher exits |
| `${XDG_STATE_HOME:-~/.local/state}/claude-code-ghcp-sdk/litellm-settings/<random>.json` | Every other `claude-litellm` launch's settings, including the LiteLLM key and gateway URL. A relative `XDG_STATE_HOME` is ignored in favour of `~/.local/state` | `0600`, in `0700` directories | Kept after the launcher exits, because Claude Code restarts a `/background` job from it. Each later `claude-litellm` launch other than print mode deletes files there older than 7 days. Nothing else removes them, `claude-ghcp-stop` included. Deleting the directory yourself is safe except for a `/background` job still using a file, which then cannot restart |
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
Claude Code rewinds or compacts), or a sibling state in the family has since
continued this conversation, the bridge discards the state
(`bridge.history_reconciled`) and starts a fresh session. A sibling counts as
having continued it when the sibling's last request that Copilot accepted, even
one later interrupted or failed, came after this state's own last request and
either its history is a prefix of the incoming one and at least as long as what
this state has seen, or the incoming history
keeps more of the sibling's history than this state has seen. The bridge
remembers the last request Copilot accepted from each state in a family; past 16, it
forgets the oldest, and any state whose own last request came before the
forgotten one replays. A side call on an unrelated history, such as title
generation or WebFetch processing, leaves the state alone. The comparison
ignores `cache_control` markers and inline `system` entries. Inline system text, such as custom agent definitions and
output styles, is merged into the SDK system message, with recognised
per-request token-budget notes removed. Any change to real user or assistant
content, tool inputs or system instructions counts as a different history.

**Resume and replay.** Every SDK session the bridge creates gets a new random
ID, `claude-ghcp-<32 hex digits>`, that is never reused. Within one bridge
process, a state the bridge evicted normally is remembered with its session ID
and the transcript it holds, and the next request for it resumes that SDK
session. The request is still checked against the remembered transcript, so a
rewind or edit still discards and replays. If resuming fails for a reason other
than a timeout or cancellation, the bridge creates a fresh session instead.
Nothing else is resumed: a state that is no longer remembered, and every state
after the bridge process restarts, gets a fresh session. A fresh session
receives the earlier conversation as text, up to `MAX_REPLAY_BYTES`, keeping the
newest messages. This is called cold replay. It keeps tool-use IDs, tool-result
error flags and `tool_reference` names.

**Eviction and discarding.** Normal eviction (the `MAX_STATES` and
`STATE_IDLE_TTL_MS` limits below) keeps the SDK session on disk and remembers
up to 4 × `MAX_STATES` evicted states for resume, dropping the oldest first. A
forgotten session is no longer resumable, so a later request cold-replays, but
the session stays on disk. A state whose history Copilot reduced is deleted on
eviction, and the next request for it still fails with the 400
`prompt is too long` error (`bridge.context_limit`, phase `between_requests`),
as if it had not been evicted. Discarding a state deletes its SDK session from
`COPILOT_HOME`. The bridge discards a state after a history change or a context
limit, and when the state is invalidated by a failed effort change, by an abort
Copilot did not acknowledge within 5 seconds, or by a cold-replay send Copilot
never acknowledged (it failed, was cancelled or timed out), so that the retry
replays again.

**Tool handoff.** The map from a Claude Code `toolCallId` to the SDK's pending
request lives in bridge memory. At the end of a turn the bridge waits for
Copilot to register each tool call before returning it.

**Limits.** These variables bound sessions and turns. Their defaults are in
[`.env.example`](../.env.example), and all of them are in the persistent
bridge's [configuration fingerprint](#persistent-bridge-and-retirement).

| Variable | What it bounds | When it is reached |
|---|---|---|
| `MAX_STATES` | Cached states | The least recently used idle states are evicted first. If there are still too many, the least recently used states whose only activity is unanswered tool calls are discarded; a late tool result then cold-replays. A state with an active turn, and the state that just served the request, are never evicted. |
| `STATE_IDLE_TTL_MS` | Idle time of a state with no active turn and no pending tool call | The state is evicted at the start of the next request. |
| `MAX_REPLAY_BYTES` | History replayed into a fresh session | Older messages are dropped and `bridge.history_replay_truncated` is logged. |
| `MAX_TOOL_RESULTS` | Tool results in one request | The request fails with 500. |
| `PENDING_TOOL_WAIT_MS` | Wait for Copilot to register a tool call | The call is dropped from the turn (`bridge.unregistered_tool_call`). |
| `SESSION_OPERATION_TIMEOUT_MS` | Each SDK `session.create`, `session.resume` and `session.set_model` call | The request fails with 500 (`bridge.session_operation_failed`). A late reply is discarded (`bridge.session_creation_abandoned`). |
| `TURN_IDLE_TIMEOUT_MS` | Time without progress in a turn. Root turn start, message and turn end events, and non-empty text, reasoning and tool-input deltas count as progress. Empty deltas and subagent events do not. | The turn is aborted and fails with 500 (`bridge.turn_timeout`, reason `timeout`). |
| `TURN_MAX_DURATION_MS` | Total length of one turn, even one that keeps streaming | The same, with reason `duration_limit`. |
| `CLEANUP_TIMEOUT_MS` | Each best-effort abort, disconnect or delete during cleanup | Cleanup moves on. |

A turn that times out while the runtime waits to retry an upstream failure
fails with 429 or 529 instead of 500; see
[Upstream Errors](DIAGNOSTICS.md#upstream-errors). Caller cancellation and
shutdown also end session operations and turns.

**Shutdown.** On `SIGTERM` or `SIGINT` the bridge stops accepting connections,
stops its sessions and exits with status 0. A retired bridge does the same when
it exits by itself after `bridge.retired_exit`. Stopping does not delete their SDK
sessions from `COPILOT_HOME`. If shutdown has not finished after 5 seconds
(the abort budget) + 5 × `CLEANUP_TIMEOUT_MS` + 20 seconds, 50 seconds by
default, the bridge logs `bridge.shutdown_forced` and exits with status 1. This
bounds a wait on a Copilot runtime that stops answering.

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
forwards their tools like any other declared tool. V03 checks that route with a
CLI-owned local MCP fixture, an expected tool error and same-session recall.
Runtime MCP blocking has production offline regression tests; the live matrix
does not test the user's external MCP services or runtime discovery failures.

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

`bridge.context_budget` logs the input limit reported by the runtime. It is
separate from the window advertised to Claude Code and can be lower, so a
conversation may reach it before Claude Code auto-compacts. Limits come from the
Copilot catalogue and runtime and can change without a bridge change. V06 checks
manual `/compact`, recall and cold resume after orderly shutdown. It does not
measure full-window capacity or automatic recovery from an overflow.

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
becomes 500 `api_error`; see
[Upstream Errors](DIAGNOSTICS.md#upstream-errors).

### Usage accounting

Copilot reports input tokens including cached tokens; Anthropic reports three
separate counts. The bridge returns uncached input as
`max(0, inputTokens - cacheReadTokens - cacheWriteTokens)`, with Copilot's cache
counts as `cache_read_input_tokens` and `cache_creation_input_tokens`, so a
cached 230K-token request is not shown as about 460K. In a streamed reply,
`message_start` carries the request estimate, which a reply interrupted before
it ends keeps, and the final `message_delta` carries the count. Because Claude
Code keeps the `message_start` value unless the later one is above zero, a
fully cached turn reports `input_tokens: 1` with one token fewer in
`cache_read_input_tokens` (or `cache_creation_input_tokens`), so the total
matches the JSON response. JSON keeps explicit zeros; in a stream, an
SDK-measured zero with no cache leaves Claude Code with the estimate.
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
  model is not named haiku, sonnet or opus.
- The blanked provider selectors and inherited model options keep shell or user
  values from sending requests somewhere other than the gateway.
- With `ENABLE_TOOL_SEARCH` blank, Claude Code's native tool search and
  `tool_reference` are off and the model gets the full declared tool set.
  `GHCP_NATIVE_TOOL_SEARCH=1`, read on each Direct launch, turns Claude Code's
  tool search on. The SDK's own tool search is always off, because
  declaration-only tools can stall under it.

## Persistent Bridge and Retirement

Print mode starts a private bridge with a random token and stops it on exit:
`SIGTERM`, then `SIGKILL` if it is still running 30 seconds later.
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
`GHCP_NATIVE_TOOL_SEARCH`, `GHCP_DAEMON_DIR`, `BRIDGE_TEST_FAULTS` and
`BRIDGE_VERIFY_OBSERVE`. The
bridge inherits the whole environment of the launch that started it, so
variables outside the fingerprint keep that launch's values.

**Per launch.** Concurrent launches take turns through `bridge.lock`. A new
bridge must answer `/health` with its own `instanceId` within 60 seconds and
list the launch model in `/v1/models?all=true`, or the launch fails. Another
listener on a pinned port does not count: the launch fails with
`Persistent bridge exited; inspect <log>.` once the new bridge exits. If the
launcher's own `/health` check then fails, it prints
`Timed out waiting for the GHCP bridge.` and the last 120 lines of
`bridge.log`. `ensure` returns the registry, a new
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

**Stopping instead.** If any other retirement condition fails (no registered
bridge, a dead PID, no retirement capability, or a new launch pinned to the old
bridge's port), `ensure` stops the old bridge (`SIGTERM`, then `SIGKILL` after 5
seconds) and deletes the whole `settings/` directory, even settings files that
sessions on still-running retired bridges need. A launch pinned to a port also
stops any retired bridge still holding that port. For LiteLLM, which reaches the
bridge on a pinned port, the consequences are in
[When the Bridge Is Replaced](LITELLM.md#when-the-bridge-is-replaced).

**Unconfirmed PID.** When `bridge.json` names a live PID whose `/health` does
not report the registered `instanceId`, the launcher reads that PID's command
line with `ps`. If it is not `node` running a checkout's `src/server.mjs` (a
directory that also holds `bin/resolve-claude.sh`), for example because the PID
was reused after a reboot, the registry is stale: a launch or
`claude-ghcp-stop` removes it without signalling that process. On macOS the
same happens when it is such a bridge but `ps -o lstart=` shows it started more
than 5 seconds after the registry's `createdAt` (a later bridge, such as a `-p`
private bridge, reused the PID); this applies to the records in `retired/` as
well. Linux skips this start-time check, because procps derives `lstart` from
the boot time, which moves whenever the wall clock is stepped. If it is a bridge
that started no later than that, or any such bridge on Linux, a launch does not
start a second one beside it and fails with
`Persistent bridge PID <pid> (port <port>) runs <checkout>/src/server.mjs but did not answer /health, so no second bridge was started beside it; kept <daemon dir>/bridge.json. Run claude-ghcp-stop, then launch again.`
`claude-ghcp-stop` then stops it (`SIGTERM`, then `SIGKILL` after 5 seconds). If
`ps` cannot identify the PID, the error names the manual step: check
`ps -p <pid> -o command=`, kill the PID if it shows a checkout's
`src/server.mjs`, otherwise delete `bridge.json`, then launch again.

**Status and stop.** `claude-ghcp-status` reports the model the bridge started
with and never prints the token. `claude-ghcp-stop` stops the current bridge and
every retired one, and deletes `bridge.json`, the records in `retired/`,
`settings/`, `leases/` and `bridge.log` from the daemon directory
([Files the bridge keeps](#files-the-bridge-keeps)). When it cannot stop the
current bridge, it keeps `bridge.json` but still stops the retired bridges and
removes `settings/`, `leases/` and `bridge.log` before it reports the error. A
retired bridge whose PID cannot be identified keeps its record. The SDK session
history in `COPILOT_HOME` and the `claude-litellm` settings files are kept.

**Working directory.** The persistent bridge runs in the daemon directory, not
in the project that started it. That project could be deleted while the bridge
runs, and runtime MCP discovery would otherwise read its workspace
configuration for every other project's sessions.

## Logging

Bridge events describe request outcomes, session changes and timeouts. Log paths,
retention, privacy limits and the event/field reference are in
[Diagnostics → Logging](DIAGNOSTICS.md#logging).

The verifier alone enables default-off `BRIDGE_VERIFY_OBSERVE=1`
(`src/verification-observer.mjs`). Its observations link request/response and
session IDs to content digests without copying raw request contents into
diagnostic events; the `bridge.verify_*` events and the extra `/health`
`timeouts` field are listed under
[Event reference](DIAGNOSTICS.md#event-reference). Model/effort checks read actual SDK
model state with a 5-second bound, rather than treating requested settings as
proof of applied settings. Missing observation data stays missing. Native
transcripts, settings and combined error logs can still contain sensitive
content or credentials.

## Upstream Errors

Before SSE starts, failures return their HTTP status and a JSON error. After it
starts, HTTP stays 200 and an `event: error` frame carries the failure. For all
status mappings and retry-wait timeouts, see
[Diagnostics → Upstream Errors](DIAGNOSTICS.md#upstream-errors).

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

The required live matrix runs V01–V06 on each of the six primary models:
**6 models × 6 scenarios = 36 slots**. For the latest recorded outcome, its
versions, code and scope, see [Verification Results](VERIFICATION.md). This architecture reference describes
implementation behavior and required checks, not recorded passes.

### What `npm test` covers

Production offline regressions cover translation, model mapping, errors,
cancellation, session/subagent isolation, runtime MCP blocking and launchers.
Synthetic verifier tests cover all 36 slots, evidence/source integrity and
owned-process cleanup. They do not prove real-model behavior. See
[offline checks](TESTING.md#offline-checks-and-dry-run).

### What `npm run verify` runs

The runner first uses the actual installed Claude Code against a bounded local
mock Messages API, without Copilot calls, to check required CLI capabilities and
isolation. Unavailable capabilities block affected slots. It then attempts the
remaining live matrix once, without harness retries:

- **V01:** print completion, native six-model picker, exact Unicode answer and
  `/clear` isolation.
- **V02:** Read the hidden sample/source/tests, observe the discount regression,
  Edit only `discount.mjs`, and pass all three tests with an independent rerun.
- **V03:** local CLI-owned MCP error, hidden lookup and tool-free recall in the
  same process and session.
- **V04:** same-session model switch with context retained, High effort confirmed
  by actual SDK state on supported models, and no applied effort on Haiku.
- **V05:** Escape during real streaming, correlated client cancellation and SDK
  abort acknowledgment, followed by recovery in the same process and session.
- **V06:** manual `/compact`, then exact recall from a new SDK session that was
  sent the compacted history without the seed prompt; normal exit and private
  bridge cleanup; then a new CLI and new private bridge resuming the exact saved
  session ID.

Native interaction uses Python 3.9 or newer (as `python3` on PATH) standard-library PTY support and installed
`@xterm/headless`, not a browser. Slot-local phase/native transcripts and bridge
observations are the evidence; terminal display text alone cannot prove an answer.
The runner directly starts isolated private bridges. Their Claude Code settings
come from the production writer and use the production credential path (the
token as `ANTHROPIC_AUTH_TOKEN`, a blank `ANTHROPIC_API_KEY`). The runner does
not exercise the production launchers or shared/background daemon lifecycle. V06 checks cold
conversation replay after orderly shutdown, not in-flight crash recovery.

All 36 slots, code/user-settings invariants, isolation, saved-source/evidence
integrity and owned-process cleanup must pass. Saved v2 source snapshots and hash
manifests let reports recheck raw evidence instead of trusting a stored verdict.
Failed, blocked or missing slots never count as passes. See
[pass meaning](TESTING.md#what-a-pass-means).

### Commands and flags

Follow [Testing](TESTING.md) for prerequisites, side-effect-free dry-run, the full
36-slot live command, per-slot budgets, artifacts and generating both result
documents from one explicit run directory. Model concurrency defaults to 1;
`--models` and `--scenarios` are focused-debug selectors. There is no
`--scenario-concurrency` option.

## Key Files

| File | Role |
|---|---|
| `bin/claude`, `bin/claude-ghcp` | Direct launcher (`bin/claude` runs `claude-ghcp`): chooses the persistent or print-mode bridge, writes the launch settings, starts Claude Code |
| `bin/claude-ghcp-status`, `bin/claude-ghcp-stop` | Persistent bridge status and stop |
| `bin/claude-litellm` | LiteLLM launcher; writes its settings file ([Files the bridge keeps](#files-the-bridge-keeps)) |
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
| `src/copilot-home.mjs`, `src/copilot-session-rpc.mjs`, `src/entry-point.mjs` | `COPILOT_HOME` resolution, SDK tool-result, abort, disconnect and delete calls, entry-point detection through symlinks |
| `src/verification-observer.mjs` | Verifier-only observations when `BRIDGE_VERIFY_OBSERVE=1`: request and response IDs, counts and content digests, and the SDK model state read with a 5-second bound |
| `src/doctor.mjs`, `src/list-models.mjs`, `src/model-cli.mjs`, `src/provider-detection.mjs`, `src/settings-file-state.mjs`, `src/version.mjs` | Command-line helpers |
| `scripts/verify/`, `test/` | The live verification harness, and `npm test` |

Every `bin/` launcher follows symlinks to find its checkout, so a link in
`~/.local/bin` or from `npm link` works. The launchers do not add
`node_modules/.bin` to `PATH`.

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
