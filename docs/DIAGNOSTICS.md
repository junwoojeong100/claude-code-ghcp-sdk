# Diagnostics

> **Language / 언어:** English | [한국어](DIAGNOSTICS_KO.md)

Use this guide to locate a bridge failure and read its log. For running checks,
see [Testing](TESTING.md); for request and session design, see
[Architecture](ARCHITECTURE.md).

**On this page:** [Start with the symptom](#start-with-the-symptom) ·
[Find the evidence](#find-the-evidence) · [Logging](#logging) ·
[Upstream errors](#upstream-errors) · [Verification artifacts](#verification-artifacts)

## Start with the symptom

Run this page's `./bin/` and `npm run` commands from the **bridge checkout**, not
from your working project. To launch Claude Code in another project, stay in that
project and call the launcher's absolute path.

| Symptom | First action |
|---|---|
| Executable not found, unsupported Node, or launch fails before connecting | Run `./bin/ghcp-doctor`; see [Environment check](#environment-check). |
| Model lookup reports an authentication failure | Check the account and sign-in directory, then use `copilot login` if needed; see [Catalogue and model problems](#catalogue-and-model-problems). |
| Model lookup reports a missing dependency or connection failure | Fix the installation, PATH, network or proxy named by the error. Re-login is not the default remedy. |
| Requested model is missing, disallowed, or rejected despite appearing in a fresh list | Check the exact model ID, account policy and possible stale bridge catalogue below. |
| A request fails, stops streaming or seems stuck | Keep the [bridge log](#find-the-evidence), then match the request and timeout fields under [Read the key fields](#read-the-key-fields). HTTP 200 alone does not prove an SSE request succeeded. |
| A long conversation fails with `prompt is too long` | Compact the conversation before retrying. Check `bridge.context_budget` and `bridge.context_limit`; the runtime input limit can be lower than the displayed context window. See [Context overflow](ARCHITECTURE.md#context-overflow). |
| A verification run fails | Open that exact run's [verification artifacts](#verification-artifacts), not the shared daemon's log. Do not stop the shared daemon to clean up a verifier-owned bridge. |

### Environment check

```bash
./bin/ghcp-doctor
```

`npm run doctor` runs the same check. The JSON report passes only when `node`,
`npm`, `claude` and `copilot` each have `"ok": true` and
`compatibility.node.supported` is `true`. Otherwise it exits with status 1.
Supported Node versions are `^20.19.0` or `>=22.12.0`.

- Each version probe has a 10-second timeout; a hung probe also reports `false`.
  Fix the failed executable or version, then run the check again.
- If the wrapper cannot find Claude Code, it prints `Claude Code executable not
  found…` before any JSON report. Install Claude Code or set `CLAUDE_CODE_BIN` to
  the real executable, not a launcher from this repository.
- The check does not test `curl`, Git, Copilot sign-in or a model's ability to
  answer. A passing report is an environment check, not an integration result.

`currentProvider` is informational, not a pass condition. It reads only the saved
`~/.claude/settings.json`, including that file's `env` object, not the process
environment. It does not combine shell variables, project or managed settings,
or the per-launch routing settings. It therefore does **not** identify the
effective provider of a running GHCP session.

### Catalogue and model problems

```bash
./bin/ghcp-models --json
```

This queries Copilot for the account's current catalogue. A successful list
confirms catalogue access, not that a model can answer a prompt.

- **Authentication error:** check which account and `COPILOT_HOME` you use for
  login and the bridge. Run `copilot login` when sign-in needs repair.
- **Installation or connectivity error:** fix the missing executable/dependency,
  network or proxy reported by the error. Do not re-login just because a
  catalogue query failed.
- **Missing or policy-restricted model:** choose an exact available ID allowed
  by your account/organization. Re-login does not grant model access.

If this fresh list contains the model but the persistent bridge rejects it, the
bridge may still have the catalogue it read at startup. `ghcp-models` does not
refresh a running bridge. First check that both use the same account and
`COPILOT_HOME`; prefer an absolute path or `~/...` for that variable (see
[`.env.example`](../.env.example)).

To deliberately restart the shared bridge, **finish all affected sessions and
`/background` jobs, and preserve the logs you need first**. The stop command stops
the current and retired bridges in the selected `GHCP_DAEMON_DIR`, deletes
`bridge.log` and their per-launch settings, and breaks any sessions or jobs still
using them. It does not remove `claude-litellm` settings. File retention is
[documented separately](ARCHITECTURE.md#files-the-bridge-keeps).

```bash
./bin/claude-ghcp-stop
```

Then relaunch from your working project with the launcher's absolute path; the
new bridge reads the catalogue again. This is not verifier cleanup. Restarting
Claude Code to load a changed `/model` picker is a separate step: it reloads the
CLI's launch settings, but can reuse a bridge with an older SDK catalogue.

## Find the evidence

| Where the failure happened | Start here | What remains |
|---|---|---|
| Persistent Direct bridge | `<daemon dir>/bridge.log` | Appended across launches and replacements; current and retired bridges can write to the same file. When a launch cannot reach the bridge, the launcher prints the last 120 lines. `claude-ghcp-stop` deletes it. There is no built-in rotation. |
| Direct print mode (`-p` / `--print`) | `$TMPDIR/claude-ghcp.XXXXXX/bridge.log` | The launcher deletes its temporary directory on exit. To keep the log, run `tail -f "${TMPDIR:-/tmp}"/claude-ghcp.*/bridge.log > print-bridge.log` in another shell while the run is live. Startup failures may print an excerpt. |
| Live verification, V01–V06 | `<run dir>/slots/<model>__Vxx/bridge.log`, phase transcripts and native session/terminal logs | The runner starts private direct bridges, not the production launcher or shared daemon. V06's replacement bridge writes `bridge-2.log` in the same slot directory. Run artifacts remain even when a passed workspace is removed. |
| LiteLLM path | LiteLLM output and the bridge's log | Use [LiteLLM troubleshooting](LITELLM.md#troubleshooting) to distinguish the two hops. |

The daemon directory is `GHCP_DAEMON_DIR`, or
`~/Library/Caches/claude-code-ghcp-sdk` on macOS and
`${XDG_CACHE_HOME:-~/.cache}/claude-code-ghcp-sdk` elsewhere. Persistent bridge
logs are created with mode `0600`. Other stored files and their lifetimes are in
[Files the bridge keeps](ARCHITECTURE.md#files-the-bridge-keeps).

## Logging

Bridge events are JSON objects, one per line. `bridge.started`, `bridge.retired`
and `bridge.retired_exit` go to stdout; the other events below go to stderr.
`LOG_LEVEL` changes only the Copilot runtime's log level, not these bridge events.
The launchers and harness combine bridge stdout and stderr in one log.

**Review the combined log before sharing it.** Request/turn summaries contain
operational fields, not request bodies, prompts, tool arguments, tool results,
attachments or credentials. That is not a blanket guarantee about the whole log:

- Failures reaching the server's outer error handler, except client aborts, also
  write `[<requestId>] <ErrorName>: <message>`. The message can include a model or
  tool name, or unsanitized upstream error text. Early 401 and body-validation
  failures do not write this extra line.
- `bridge.mcp_discovery_failed.message` includes up to 200 characters of the
  discovery error. Truncation is not redaction.
- Verification transcripts, configs and settings are separate artifacts. They
  can contain conversation/tool contents and tokens; they are not content-free
  diagnostics. Review all retained files before sharing.

`npm test` checks diagnostic event and field names. Treat them as an interface.

### Read the key fields

- **Failed request:** match `requestId` on `bridge.request_failed` and any plain
  error line. `status` is the mapped failure status; look it up under
  [Upstream errors](#upstream-errors). With `headersSent: true`, an SSE response
  already has HTTP 200; inspect its error frame instead.
- **Stall:** `bridge.turn_timeout` distinguishes idle `timeout` from
  `duration_limit`. Check `stage`, pending RPC/registration counts and
  `upstreamRetryStatus` before deciding whether the wait was local or upstream.
  With `upstreamRetryStatus` 429 or 5xx, the request failed as 429 or 529 and
  Claude Code retries it. If the model legitimately works silently or long at
  stage `model`, raise `TURN_IDLE_TIMEOUT_MS` or `TURN_MAX_DURATION_MS`
  ([`.env.example`](../.env.example)).
- **Tool or session wait:** if `bridge.unregistered_tool_call` for a declared
  tool, or `bridge.session_operation_failed` with `reason` `timeout`, recurs on
  a slow runtime, raise `PENDING_TOOL_WAIT_MS` or `SESSION_OPERATION_TIMEOUT_MS`.
- **Model identity:** `requestedModel` is what Claude Code sent; `model` is the
  resolved target; `servedModels` contains model names reported by SDK usage
  events. An empty list is unknown, not confirmation of the target model.
- **Interrupted turn:** `bridge.turn_abort_completed.acknowledged` says whether
  Copilot acknowledged the abort. It does not mean the original turn succeeded.

### Event reference

| Event | When | Fields |
|---|---|---|
| `bridge.started` | The server starts listening | `address`, `preferredModel`, `models` (count) |
| `bridge.request_failed` | A `/v1/messages` request fails: 401, a 400 body error, or any later failure including 499 | `requestId`, `status`, `errorType`, `retryAfterSeconds`, `streaming` (the validated request asked for SSE; false for early auth/body failures), `headersSent` (a response had already started) |
| `bridge.turn_completed` | A `/v1/messages` response has been sent | `requestId`, `responseId`, `requestedModel`, `model`, `servedModels`, `claudeAgent` (`root` or `subagent`), `inputTokens`, `outputTokens`, `usageReported`, `stopReason`, `toolUses` |
| `bridge.degraded_controls` | A request carries a sampling control the SDK cannot apply, or an accepted field the bridge ignores | `controls`, `ignoredFields` (when any), `semantics` |
| `bridge.mcp_servers_disabled` | Startup, after `mcp.discover` | `count`, including `github-mcp-server` |
| `bridge.mcp_discovery_failed` | MCP discovery failed or took longer than 10 seconds | `error`, `message` (at most 200 characters) |
| `bridge.context_budget` | A session reports a new runtime input limit | `model`, `contextTier`, `tokenLimit`, `currentTokens` (when known) |
| `bridge.context_limit` | Copilot reduced a session's history | `model`, `phase` (`between_requests` or `active_turn`), `tokenLimit` (when known). `active_turn` adds the turn-report fields |
| `bridge.history_reconciled` | The conversation no longer extends the cached state (`history_diverged`), or another state in the family has since continued this conversation, or more than 16 other states of the family ran after this state's last request so the bridge forgot one of their turns (`identity_stale`) | `currentMessages`, `previousMessages`, `reason` (`history_diverged` or `identity_stale`) |
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
| `bridge.retired` | The bridge received `SIGUSR2` and is retired | `retired`, `inFlight`, `idleMs`, `leases` (live count) |
| `bridge.retired_exit` | A retired bridge exits | `retired`, `inFlight`, `idleMs`, `leases` (live count) |
| `bridge.shutdown_forced` | Shutdown (after `SIGTERM` or `SIGINT`, or a retired bridge's own exit after `bridge.retired_exit`) did not finish within its deadline (50 seconds by default; see **Shutdown** under [Session Isolation](ARCHITECTURE.md#session-isolation)). The bridge then exits with status 1 | `deadlineMs` |
| `bridge.diagnostic_error` | Writing a turn diagnostic failed; the request itself is unaffected | `diagnosticEvent`, `requestId`, `responseId` |

The turn-report fields are `timestamp`, `requestId`, `responseId`, `state` (a
hash), `model`, `elapsedMs`, `turnElapsedMs`, `idleMs`, `stage` (`send`,
`tool_result`, `tool_registration`, `trigger` or `model`), `triggerFinished`,
`turnStarted`, `completionStarted`, `deferredCompletion`, `upstreamRetryStatus`,
`messages`, `toolRequests`, `usageEvents`, `pendingToolCalls`,
`pendingRegistrations`, `rpc` (started, acknowledged and failed counts for send
and tool result), `eventCounts` and `recentEvents` (at most eight, each with type,
scope and elapsed time).

**Verification only.** A bridge started with `BRIDGE_VERIFY_OBSERVE=1` also
writes these events to stderr. The launchers never set it, but a bridge they start
inherits it if you export it.

| Event | When | Fields |
|---|---|---|
| `bridge.verify_request` | A `/v1/messages` request passed body validation, before its turn runs | `requestId`, `responseId`, `requestedModel`, `claudeSessionId`, `claudeAgent` (`root` or `subagent`), `streaming`, `compactRequested`, `effort`, `messageCount`, `messagesSha256`, `userTextHashes`, `messageDigests` (per message: `role`, `sha256`, `textHashes`), `toolResultIds`, `toolUseIds` |
| `bridge.verify_model_state` | Before each turn is sent, after the effort level is applied | `requestId`, `responseId`, `sessionId` (the SDK session), `model`, `requestedEffort`, `appliedEffort`, `requestedContextTier`, `ok`, `current` (the `modelId`, `reasoningEffort` and `contextTier` the SDK reported, or null), `error` when `ok` is false (`timeout`, `aborted`, `unavailable`, `invalid_response` or `rpc_error`) |
| `bridge.verify_progress` | The first non-empty root text delta of a streamed response | `requestId`, `responseId`, `kind` |
| `bridge.verify_response` | A `POST /v1/messages` response finished or its connection closed, whatever the outcome | `requestId`, `responseId`, `status` (null when no status was sent), `streaming`, `finished`, `aborted` |

With the same setting, `bridge.turn_completed` adds `compactSummarySha256`, the
SHA-256 of the reply text normalized the way Claude Code stores a `/compact`
summary (null when the reply has no text), and
`GET /health` adds `timeouts`: `turnTimeoutMs`, `maxTurnDurationMs`,
`sessionOperationTimeoutMs`, `pendingToolWaitMs`, `abortTimeoutMs`,
`cleanupTimeoutMs`, `stateIdleTtlMs` and `mcpDiscoveryTimeoutMs`. The runner
compares these with the budgets it recorded.

`GET /health` lists the sampling controls the SDK cannot apply as
`capabilities.unsupportedNativeControls` and the accepted fields the bridge
ignores as `capabilities.ignoredRequestFields`. Both lists come from
`src/request-policy.mjs` and are explained in
[Unsupported Controls](COMPATIBILITY.md#unsupported-controls).

## Upstream Errors

The table maps request failures to HTTP status and error type (`errorResponse`
in `src/server.mjs`, `sessionError` in `src/upstream-errors.mjs`). Before SSE
starts, the bridge returns that status with a JSON error. After SSE starts,
the HTTP status stays 200; see the streaming rules below.

| Condition | Status | Error type |
|---|---|---|
| Missing or wrong token, on any route except `GET /health` and `HEAD /api/hello` | 401 | `authentication_error` |
| Authenticated request to an unknown method or path | 404 | `not_found_error` |
| Body larger than `MAX_BODY_BYTES`, invalid JSON, or a malformed shape. There is no 413 | 400 | `invalid_request_error` |
| `tool_choice` of `any` with no tools, a named tool that is not declared, or an unsupported mode | 400 | `invalid_request_error` |
| A model the account's Copilot catalogue does not have | 400 | `invalid_request_error` |
| An effort value that is not a known level, for a model that lists its levels | 400 | `invalid_request_error` |
| Copilot started reducing the session's history (the `prompt is too long` error in [Context overflow](ARCHITECTURE.md#context-overflow)) | 400 | `invalid_request_error` |
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
`upstreamRetryStatus`. These mappings have production offline regression tests;
the V01–V06 live matrix does not inject upstream failures.

**Test faults.** `BRIDGE_TEST_FAULTS` is a test hook, not a feature. For example
`BRIDGE_TEST_FAULTS="rate_limit:1,overloaded:1"` fails that many requests that
declare tools, in the listed order, before they reach Copilot. The kinds are
`rate_limit` and `overloaded`, which go through the same mapping as real
upstream failures, and `context_limit`, which raises the bridge's own
`prompt is too long` error. Keep it unset for live verification; the V01–V06
matrix does not validate this mapping.

## Verification artifacts

For a verification failure, `<run dir>` is the directory on the runner's
`artifacts:` and `report:` lines (`.verify-runs/<timestamp>/` unless you passed
`--out`). Use that exact directory explicitly when rendering the report; do not
pick the newest run. Start with `summary.json` for preflight, run-level integrity
and cleanup issues. Preflight exercises the installed Claude Code against a
bounded local mock Messages API, without Copilot calls; unavailable capabilities
block affected slots rather than proving a model failure.

The verifier owns its private bridges and cleanup records. Do not use
`claude-ghcp-stop` for them: it targets the shared daemon, not these processes.

Find the model/scenario slot's `reason`, failed `checks` and `evidence.phases` in
`slots.jsonl`, then follow the recorded paths:

- Print phases write `transcript-<phase>.jsonl` in `slots/<model>__Vxx/`.
- Native launches write `terminal-<launchId>.log`, the raw PTY output, and
  `terminal-events-<launchId>.jsonl`, the input and output receipts (kind,
  purpose, sequence and byte counts, never the input bytes). An Escape
  interruption row (V05 and the preflight interruption check) also stores the
  rendered screen text, which shows the typed prompt and any partial reply, and,
  when the native transcript recorded the interruption, that record with its
  `cwd` and session ID, so review this file like the raw log before sharing.
  Answer evidence comes from the native session transcript at the recorded
  `transcriptPath`, not from terminal display text.
- A native launch on a 160×48 terminal, the size the verifier uses, also writes
  `terminal-output-<launchId>.jsonl`, an output-only recording (schema
  `ghcp-terminal-output` v1). Its output frames are byte-identical to the raw log,
  and the driver adds phase markers such as `seed` or `recall`. It records no
  input stream (keystrokes), arguments, settings file or environment, but its
  output frames are whatever the terminal displayed, including the TUI echo of
  every typed prompt and the model's replies, so review it like the raw log
  before sharing. Its footer says whether capture was complete, incomplete or
  truncated (at 8 MiB or 50,000 frames). If a capture error stops the recording
  before the footer is written, the file has no footer and the renderer rejects
  it. The footer describes capture only: the recording is not answer evidence
  and never affects a verdict. A launch on any other terminal size is not
  recorded.
- `cleanup-<pid>.json` records native process cleanup: exit code, signal,
  whether the close was forced or escalated to `SIGKILL`, and the owned PIDs
  still alive (`remainingPids`). The PTY helper tracks descendants by PID and
  `ps` start time and never signals a PID whose start time changed. It finds
  descendants by sampling `ps` about every 0.25 s, so a process that detaches
  into a new session and loses its parent between samples is not observed, and
  `ok` can be true while it is still running. PIDs it was not permitted to
  signal are listed in `signalDeniedPids`; one that is still alive makes `ok`
  false.
- Match phase response IDs to `bridge.log`; V06 also uses `bridge-2.log` after
  normal CLI exit and cleanup of the first private bridge.
- Saved v2 source copies under `sources/files/`, `sources/manifest.json` and
  `artifact-manifest.json` support source/hash validation and raw-evidence
  rechecking. A stored `pass` label alone is not sufficient.

Failure summaries may shorten details; the original slot row and files retain
more. All 36 slots plus integrity, isolation and cleanup gates are required for
a full pass. [Testing](TESTING.md#read-the-result-and-generate-documents)
explains the result gates and workspace retention; the latest recorded outcome
is in [Verification Results](VERIFICATION.md).

### Correlate verification evidence

For V01–V06 completed responses, the verifier correlates root assistant
`message.id` values with `bridge.turn_completed.responseId`. Requested/resolved
models, every SDK-reported `servedModels` entry, reported usage and stop reasons
must agree with that phase and response. V04's source phase intentionally uses a
different model; V05's interrupted phase requires cancellation/abort evidence
instead of successful completion. Unrelated auxiliary requests cannot supply
missing evidence. This confirms SDK-reported model IDs, not the provider's
internal implementation; missing evidence blocks a pass.

The verifier enables **`BRIDGE_VERIFY_OBSERVE=1`**, which is off by default. Its
request/response observations use IDs, counts and content digests rather than raw
prompts, tool contents, headers or credentials; the events are listed under
[Event reference](#event-reference). V06 uses them to check the compaction
handoff: every `bridge.verify_model_state.sessionId` in the post-compact recall
must differ from those of the seed and compact requests, and no recall
`bridge.verify_request` may carry the seed prompt's digest in `userTextHashes`.
Model/effort observations call SDK `session.rpc.model.getCurrent()` with a
5-second bound; `current` is the actual SDK-reported state, not a copy of
requested settings. An unavailable, invalid or timed-out read stays missing
evidence. Observation failures do not turn a model response into a different
response. This narrower logging policy does not redact native transcripts,
settings or other combined log entries; review those before sharing.
