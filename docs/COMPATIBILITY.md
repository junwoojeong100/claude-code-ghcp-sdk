# Claude Code Compatibility

> **Language / 언어:** English | [한국어](COMPATIBILITY_KO.md)

Claude Code still runs on your machine, so its UI, tools, permissions, hooks,
MCP servers and skills behave as usual. The bridge replaces only the model call,
which goes to GitHub Copilot instead of Anthropic. Features that run on
Anthropic's servers do not work, and some request controls are accepted but not
applied.

## Feature Lookup

Statuses describe implementation support, not a live pass. **Supported** means the
bridge supports it or Claude Code handles it locally; **differs** points to the
row's limitations. **Expected** is client behavior expected to keep working that
the live matrix does not check; its last column is always `no`. **Not supported**
and **Not possible** are explained in the row and under
[Structural Limits](#structural-limits).

"Live matrix check" identifies the enforced V01–V06 scope, not recorded passes.
`no` means outside that scope. A full pass requires **6 models × 6 scenarios = 36
passing slots**, plus integrity, isolation and cleanup gates. For recorded outcomes and their scope, see
[Verification Results](VERIFICATION.md); for the pass contract, see
[Testing](TESTING.md#what-a-pass-means). Production offline regressions remain
separate evidence. The runner starts private direct bridges itself; none of the
rows below claims live verification of the production launchers or shared daemon.

### Tools

| Feature | Status | What differs | Live matrix check |
|---|---|---|---|
| Read, Edit, Write | Supported | | V02: hidden sample/source/test Reads and exact discount Edit; no Write |
| Bash, including long-running commands | Supported | | V02: specified foreground tests, a retest in which all three tests pass, and an independent rerun; no long/background commands |
| NotebookEdit | Expected | | no |
| Git and git worktrees | Supported | | no |
| Failed tool calls and recovery | Supported | | V02: discount regression → Edit → retest; V03: expected MCP ENOENT → hidden lookup → same-process recall |
| Several tool calls in one turn | Supported, differs | One request can send back at most `MAX_TOOL_RESULTS` (default 32) tool results. A request with more fails with 500 `api_error`. | no |
| MCP servers and their tools | Supported, differs | Every MCP tool's full schema is sent with every request. The Copilot CLI's own MCP servers are kept from starting in the bridge's sessions ([details](ARCHITECTURE.md#copilot-runtime-mcp-servers)). | V03: CLI-owned local MCP fixture, matching tool IDs/arguments/results and ledger; no external MCP service |
| MCP tool search (`ToolSearch`) | Supported, differs | Off by default. `GHCP_NATIVE_TOOL_SEARCH=1` turns on Claude Code's ToolSearch. The bridge still sends every tool to Copilot, and a tool reference reaches the model as the text `[tool_reference "name"]`. | no |
| In-session scheduled tasks (`CronCreate`, `CronList`) | Supported | | no |
| WebFetch | Expected | Claude Code fetches the page on your machine. | no |
| WebSearch | Not possible | Anthropic runs it on its servers. | — |

### Agents and project configuration

| Feature | Status | What differs | Live matrix check |
|---|---|---|---|
| Subagents and project agents (`.claude/agents`) | Supported | | no |
| Explore and subagents that name no model | Supported, differs | They run on the model you launched with. Without the launcher's settings, Claude Code sends Explore to the Opus model when you launch on a GPT model ([Models](../README.md#models)). | no |
| CLAUDE.md instructions | Supported | | no |
| Hooks, including a hook that denies a tool | Supported | | no |
| Custom slash commands, skills, plugins | Expected | | no |
| Output styles and custom system prompts | Expected | Their text reaches the model as system instructions. | no |
| Permission modes | Supported | Claude Code enforces them on your machine. | Scoped tool isolation in V02/V03 and tool-free turns; not all modes or approval dialogs |
| Permission prompts | Expected | | no |
| `--settings` on the command line | Not supported | The launcher refuses it, because it could turn off the routing to the bridge. Your own settings files still load ([details](../README.md#your-settings-are-left-alone)). | — |

### Models

| Feature | Status | What differs | Live matrix check |
|---|---|---|---|
| `/model` list | Supported, differs | Shows the six GitHub Copilot models ([Models](../README.md#models)). | V01: six-model native picker; V04: same-session switch from a different source model to the target |
| `--ghcp-model` and `GHCP_MODEL` | Supported, differs | They replace Claude Code's `--model`, which the launcher refuses. | no: production launcher is not exercised |
| `/effort`, `--effort`, Ultracode | Supported, differs | Forwarded to Copilot. A level the model does not list is replaced by one it does, and Ultracode is sent as `xhigh` ([Models](../README.md#models)). | V04: High effort and actual SDK state on supported targets, no applied effort on Haiku; not every level, flag or Ultracode |
| Which model answered | Supported, differs | Claude Code shows the model it asked for. The `servedModels` field of the `bridge.turn_completed` log line lists the models that SDK usage reported; an empty list means unknown. This checks SDK-reported IDs, not the provider's internal implementation ([reading the log](DIAGNOSTICS.md#read-the-key-fields)). | V01–V06 completed responses: every SDK-reported ID correlated by response ID and expected phase model |
| Models outside the six | Expected | Pass any ID that `./bin/ghcp-models` lists to `--ghcp-model`. | no |

### Sessions and context

| Feature | Status | What differs | Live matrix check |
|---|---|---|---|
| Interactive sessions | Supported, differs | Production launches use the shared [background bridge](../README.md#the-background-bridge). | V01, V03–V06: native PTY interaction through private direct bridges, not the shared daemon |
| Print mode (`-p`) and `stream-json` | Supported, differs | `-p` gets a private bridge that stops when the launcher exits. With `--background` or `agents` it uses the background bridge instead. | V01: exact print response; V02: coding/tool results; not launcher lifecycle |
| `--resume`, `--continue`, `--fork-session` | Supported, differs | When the running bridge has no Copilot session for the conversation (for example after a restart), it replays the saved history, keeping the newest messages up to `MAX_REPLAY_BYTES`. | V06: exact-session --resume in a new CLI and private bridge after normal exit/cleanup; no --continue, fork, crash or in-flight recovery |
| `/clear` | Supported | Claude Code starts a fresh conversation. | V01: new session ID and old conversation absent from the next request |
| `/rewind` and edited history | Expected | When the history no longer matches, the bridge drops its Copilot session and starts a new one from the history Claude Code sends. | no |
| `--background` and the `agents` view | Supported, differs | Every launch except `-p` shares one background bridge, which keeps running after Claude Code exits ([details](../README.md#the-background-bridge)). | no |
| `/background` from an interactive session | Expected | Uses the same background bridge. | no |
| Large context | Supported, differs | The Copilot runtime input limit can be lower than the window Claude Code plans for ([Models](../README.md#models)). | no |
| Compaction (`/compact` and automatic) | Supported, differs | Claude Code still compacts. When Copilot would start dropping history on its own, the bridge fails the turn with a 400 `prompt is too long` error so that Claude Code compacts ([Long conversations](../README.md#long-conversations)). | V06: manual /compact summary request and native boundary, recall from a new SDK session sent the compacted history without the seed prompt, and exact recall again after cold resume; no automatic overflow compaction |
| Token counts | Supported, differs | After a reply they use SDK-reported usage, estimating only missing values and splitting cached input into Anthropic's cache fields. Counting before a reply (`/v1/messages/count_tokens`) is an estimate, request JSON length ÷ 4, labeled by the header `x-ghcp-token-count-method: estimated`. | V01–V06 completed responses: valid usage and input/output activity, not token-count accuracy |
| Prompt caching | Not possible | `cache_control` markers have no effect. The cache fields report Copilot's own cache. | — |

### Input and output

| Feature | Status | What differs | Live matrix check |
|---|---|---|---|
| Streaming | Supported | | V01/V02: completed print streams and tool round trips; V05: actual streaming interrupted by Escape with same-process recovery; not every SSE frame boundary |
| Unicode text | Supported | | V01: exact fresh Unicode response in the native terminal |
| `--json-schema` | Supported, differs | Claude Code checks the result against the schema and retries on its own. The bridge does not apply `output_config.format`. | no |
| Images and PDFs that a tool reads | Supported | Sent to Copilot as attachments. Whether a model accepts them depends on the model. | no |
| Images and PDFs in the prompt | Expected | Sent to Copilot as attachments. | no |
| Extended thinking | Not possible | The `thinking` field is ignored and replies carry no thinking blocks. Reasoning effort is forwarded instead. | — |
| Interrupting a reply (Esc) | Supported | A queued request is dropped, and a running Copilot turn is stopped. | V05: Escape during active streaming, correlated client_abort and acknowledged SDK abort, exact recovery in the same native process/session |

### Errors and request controls

| Feature | Status | What differs | Live matrix check |
|---|---|---|---|
| Copilot rate limits and outages | Supported, differs | Copilot retries first, and nothing streams while it waits. What still fails reaches Claude Code as 429 or 529, which it retries ([status table](DIAGNOSTICS.md#upstream-errors)). | no |
| Long or stalled turns | Supported, differs | By default a turn fails after 5 minutes without model progress or 30 minutes in total ([timeouts](../README.md#rate-limits-and-timeouts)). | no |
| `tool_choice` | Supported, differs | Emulated by filtering tools and adding an instruction ([Unsupported Controls](#unsupported-controls)). | no |
| `temperature`, `top_p`, `max_tokens`, `stop_sequences` | Not possible | Accepted but not applied ([Unsupported Controls](#unsupported-controls)). | — |

### Where Claude Code runs

| Feature | Status | What differs | Live matrix check |
|---|---|---|---|
| `claude-ghcp` in an IDE's integrated terminal (VS Code, JetBrains) | Expected | Same as any other terminal. | no |
| Claude Code started by an IDE extension or Claude Desktop | Not supported | It does not use this repository's launcher, so its requests do not go through the bridge. | — |
| The Windows default shell | Not supported | The launchers are bash scripts. | — |
| Remote Control | Not possible | Claude Code turns it off when `ANTHROPIC_BASE_URL` is not Anthropic's. | — |
| Claude Code on the web, `--cloud`, `--teleport`, mobile sessions, cloud ultrareview | Not possible | They run on Anthropic's machines and never reach the bridge. | — |
| Artifacts, routines, Desktop scheduled tasks, Anthropic Analytics, billing, SSO/SCIM | Not possible | Anthropic account services ([Structural Limits](#structural-limits)). | — |


## Structural Limits

These features depend on Anthropic's servers or on model-service capabilities
that no Messages-compatible bridge can recreate.

| Feature | Why the bridge cannot provide it | Workaround |
|---|---|---|
| Remote Control | Claude Code turns Remote Control off when `ANTHROPIC_BASE_URL` points to a host other than Anthropic's. It connects through Anthropic's servers. | Use the local terminal or an IDE's integrated terminal. |
| Claude Code on the web, `--cloud`, `--teleport`, mobile sessions, cloud ultrareview | They run on Anthropic-managed machines and need a claude.ai account session. | Run locally, or use an officially supported Claude provider. |
| Artifacts, routines, Desktop scheduled tasks | Publishing and scheduling are claude.ai services, not model API calls. | Use local files, local agents and an external scheduler. |
| Anthropic Analytics, billing, subscription usage, SSO/SCIM | These are Anthropic account and organization APIs. GitHub accounts for Copilot usage instead. | Use GitHub Copilot usage and organization reports. |
| WebSearch, auto mode's classifier, Channels, claude.ai MCP connectors | They run on Anthropic's servers, not through the model API. | Use WebFetch (not verified live), MCP servers you configure yourself, and local permission modes. |
| Prompt caching | `cache_control` breakpoints and the cache they control belong to Anthropic's model service. The Copilot SDK has no cache-breakpoint control. | None. |
| Thinking blocks and their signatures | The Copilot SDK cannot create the cryptographic signatures that Anthropic thinking blocks carry. | Use `/effort`. Reasoning effort is forwarded. |
| Exact `temperature`, `top_p`, `max_tokens`, `stop_sequences` and native `tool_choice` | The Copilot SDK has no setting for them, and prompting the model is not equivalent. | None. See [Unsupported Controls](#unsupported-controls). |
| Anthropic's model-access checks, safety fallback and the consent step for Claude Fable | They are tied to Anthropic organization policy and billing. | Copilot's model catalog and your organization's Copilot policy decide which models you get. List them with `./bin/ghcp-models`. |

## Not Yet Implemented

These gaps are not structural. This repository could close them, unless the row
says the Copilot SDK blocks it.

| Gap | What happens today |
|---|---|
| Recovering a turn that was in flight when the bridge process exited | The link between Claude Code's pending tool calls and Copilot's requests lives only in bridge memory. Claude Code can resume the conversation, but the interrupted turn is not guaranteed to finish. |
| Recognizing a retried message | A message that Claude Code sends again is handled as a new one, because requests carry no stable identifier to match it against. Retried tool results are recognized. |
| Copilot's deferred tool loading | Off. The bridge declares every tool with `defer: "never"`, so every tool's full schema goes to Copilot with every request. In deferred mode, tools that the bridge declares but Claude Code runs can stall. That Copilot SDK behaviour blocks this. |
| Citations | Citations are not returned to Claude Code. |
| Request fields added by later Claude Code releases | A field on neither list in `src/request-policy.mjs` is not read and not reported. Each Claude Code release needs a review. |

## Unsupported Controls

The bridge handles a request field it cannot apply in one of three ways: it
rejects the request, emulates the field, or accepts the field without applying
it. It never presents an approximation as Anthropic's behaviour. The lists below
match `DEGRADED_CONTROLS` and `IGNORED_FIELDS` in `src/request-policy.mjs`.

### `tool_choice`

| Request | What the bridge does |
|---|---|
| `auto`, or no `tool_choice` | Nothing changes. |
| `none` | Removes the tools from the request. |
| `any` | Keeps every tool and adds the instruction "You must call at least one available tool before answering." Rejected with 400 `invalid_request_error` if no tools are declared. |
| `tool` with a `name` | Keeps only the named tool and adds the instruction to call it. Rejected with 400 `invalid_request_error` if that tool is not declared. |
| Any other mode, including `tool` without a `name` | Rejected with 400 `invalid_request_error`. |

The model can still answer without calling a tool.

### Accepted but not applied

The Copilot SDK does not expose these sampling controls. Rejecting them would
break ordinary Claude Code requests, which always set `max_tokens`.

| Field | Effect |
|---|---|
| `temperature` | Not applied. |
| `top_p` | Not applied. |
| `max_tokens` | Not applied. Copilot decides the reply length. |
| `stop_sequences` | Not applied. The reply does not stop at them. |

### Accepted and ignored

Nothing in the bridge reads these fields.

| Field | Note |
|---|---|
| `thinking` | No thinking blocks are returned. `output_config.effort` is still applied. |
| `top_k` | |
| `metadata` | |
| `service_tier` | |
| `speed` | |
| `container` | |
| `mcp_servers` | MCP servers configured in Claude Code are not affected. |
| `context_management` | |
| `output_config.format` | `--json-schema` still works, because Claude Code validates the result itself. |
| `output_config.task_budget` | |
| `tool_choice.disable_parallel_tool_use` | Parallel tool calls stay allowed. |

Two things are dropped without a report: `cache_control` breakpoints, and any
field that is on neither list.

### Where these are reported

- **Bridge log.** Each `/v1/messages` request that sets one of these fields
  writes one `bridge.degraded_controls` line, with `controls` and, when present,
  `ignoredFields`. Claude Code always sends `max_tokens`, so in practice every
  request writes one. The background bridge logs to `bridge.log` in its
  [directory](../README.md#the-background-bridge), and `claude-ghcp-stop`
  deletes that log. A print-mode (`-p`) bridge's log is deleted when the
  launcher exits.
- **`GET /health`.** `capabilities.unsupportedNativeControls` and
  `capabilities.ignoredRequestFields` list the field names above. They are fixed
  lists, not a report on any request. The route needs no token.
- **Not in the response.** The reply to Claude Code carries no marker. A caller
  that needs these guarantees has to check the bridge, not the response.

## References

- [Claude Code feature availability](https://code.claude.com/docs/en/feature-availability)
- [Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol)
- [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control)
- [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web)
- [Claude Code model configuration](https://code.claude.com/docs/en/model-config)
