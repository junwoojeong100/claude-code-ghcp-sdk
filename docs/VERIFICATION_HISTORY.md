# Verification History

This is a hand-written record of past verification runs, one-off live checks,
and the harness changes those runs led to. The current result, with what it
covers and what it does not, is in [Verification Results](VERIFICATION.md),
which is generated from the latest full run. How the matrix works and how to run
it is in [Validation Scope](ARCHITECTURE.md#validation-scope).

Paths that start with `.verify-runs/` point to run records on the maintainer's
machine. That directory is gitignored, so the records are not in the repository.

Terms used below:

- A **slot** is one model running one scenario. The six-model matrix has 66.
- A **full run** runs every slot. A **focused run** runs a chosen subset and
  never counts toward a full result.
- The **code fingerprint** is a SHA-256 hash over the implementation files in
  `src/`, `scripts/verify/`, `bin/` and the root package files. Its scope name is
  `verification-code-v1`. Each run records it at the start and at the end.
- A full run **passes** only when every slot passes, `~/.claude/settings.json`
  is unchanged, and both the commit and the code fingerprint are the same at the
  start and the end.
- `blocked` means a slot could not be judged: for example it timed out, the
  bridge died, or a `tool_use` had no matching `tool_result`. It counts as not
  passed.

## Latest full run

Run `2026-09-23T09-11-26-241Z` passed 66 of 66 slots on 2026-09-23 (KST): six
models × 11 scenarios, on commit `bed30ce`, with Claude Code 2.1.280, in 479 s
(7 min 59 s). It ran with `--timeout-scale 2`, 3 model workers × 2 scenario
workers, and `PENDING_TOOL_WAIT_MS=30000`. The bridge default for that wait is
10000; the harness passes its environment to each slot's bridge, so 30000
applied. These are not the defaults: `npm run verify` on its own uses 6 model
workers × 2 scenario workers, timeout scale 1 and a 10000 ms wait. Three model
workers were used because native background workers stalled at startup in
earlier 7 × 2 runs, and fewer workers lower the startup load. The only
six-model full run on the defaults, `2026-09-23T07-29-33-556Z`, did not pass.

What the run's own record adds:

- Commit `bed30cebc49b155b09c2795618b7e28ad044aae5`, clean checkout. The code
  fingerprint covered 41 files and was
  `1fa37d3abcd284e9d1481fafef02c211d976e63fabeaa8d64d4879a159fb5bc7` at both
  start and end.
- No failed, blocked, missing, duplicate or unexpected slots. User settings
  unchanged.
- An audit of the raw record (`audit.json`) found 1,146 recorded checks, none
  failing. The 90 transcripts of headless Claude Code invocations hold 95 final
  `result` messages, all with positive input usage and the expected model in
  `modelUsage`. That is the model Claude Code requested, not a record of which
  Copilot model served the turn. No `tool_use` went unanswered. Command and
  daemon records were kept for all six launcher slots (v11). All twelve
  media-token checks read their token exactly.
- GPT-6 Astra's v01 result also lists `claude-opus-5-5[1m]`. At `bed30ce`,
  Claude Code's built-in Explore subagent ran on the Opus alias, as it did in the
  earlier passing runs. The model check passes when any listed model matches,
  so the slot passed. `f6c1827` has since kept Explore on the launch model; see
  [Subagent model](#subagent-model).
- `npm test` at `bed30ce` passed 394 of 394, with no failures, cancellations or
  skips.

66/66 is the result for these six models and 11 scenarios. It says nothing about
features the scenarios do not exercise; see
[Not verified by this run](VERIFICATION.md#not-verified-by-this-run).

Both generated documents, [VERIFICATION.md](VERIFICATION.md) and
[VERIFICATION_KO.md](VERIFICATION_KO.md), use only this run. Local record:
`.verify-runs/2026-09-23T09-11-26-241Z/` (`summary.json`, `slots.jsonl`,
`console.log`, `audit.json`, phase transcripts and launcher logs).

## Changes since the latest full run

The matrix has not been re-run since `bed30ce`. The ten commits below change
`src/` or `bin/` and have not been through the 66-slot matrix. Each adds unit
tests, listed in the last column; at `cb0c09f`, `npm test` passes 463 of 463.
Four of them were also exercised by a one-off live check, linked in the same
column. The code fingerprint at `cb0c09f` covers 45 files instead of 41 and no
longer matches the recorded one. For what is still not verified end to end, see
[Not verified](../README.md#not-verified).

| Commit | What changed | Covered by |
|---|---|---|
| `909fbc1` | CLI entry points work when the checkout is reached through a symlinked path, such as `/tmp` on macOS. Before, `src/bridge-daemon.mjs ensure` exited with no output there and `bin/claude-ghcp` failed. | `test/entry-point.test.mjs` |
| `279caa6` | The SSE stream keeps one content block open at a time. Each `tool_use` block stops right after its input, and a repeated tool call ID is skipped instead of making the block's JSON invalid. | `test/anthropic.test.mjs` |
| `b53208d` | User text next to tool results (Skill reminders, messages queued in the TUI) now rides in the last tool result. Before, Copilot ran it as a separate turn and the next request read that turn's answer. | `test/session-manager.test.mjs` |
| `7775be6` | `bridge.degraded_controls` also lists accepted fields the bridge ignores, under `ignoredFields`. `GET /health` reports them as `ignoredRequestFields`. | `test/request-policy.test.mjs`, `test/server.test.mjs` |
| `9c68f01` | A Copilot rate-limit or quota error, or an upstream 429, returns 429 `rate_limit_error`. An upstream 5xx returns 529 `overloaded_error`. Claude Code retries both. Before, every session error returned 500 `api_error`. Each failed `/v1/messages` request writes `bridge.request_failed`. | `test/server.test.mjs`, `test/session-manager.test.mjs`, `test/upstream-errors.test.mjs`, and the [upstream 429 and 503 check](#upstream-429-503-and-retry-after) |
| `24989f1` | Each completed turn writes `bridge.turn_completed`: requested model, serving model, `servedModels`, root or subagent, token counts, stop reason and tool-use count. It holds no prompt or output text. The verification harness does not read it. | `test/server.test.mjs`, `test/session-manager.test.mjs`, and the [subagent model check](#subagent-model) |
| `9adbc28` | The bridge compares the presented key in constant time and checks both auth headers every time. | `test/server.test.mjs` |
| `ceecc8e` | Every launch except `-p` uses the persistent bridge, interactive sessions included. A replaced bridge that supports retirement is retired instead of stopped: it keeps serving and exits once no launcher still holds it and it has had no request for `RETIRED_IDLE_MS` (default one hour). `claude-ghcp-stop` also ends retired bridges, and `claude-ghcp-status` counts them. | `test/bridge-daemon.test.mjs`, `test/launcher.test.mjs`, `test/retirement.test.mjs` |
| `f6c1827` | Subagents with no model, and Explore, stay on the launch model. The gateway settings set `CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP=1`, and set `CLAUDE_CODE_SUBAGENT_MODEL` to the launch model when it is not a family model (blank otherwise). | `test/launch-settings.test.mjs`, `test/litellm-settings.test.mjs`, and the [subagent model check](#subagent-model) |
| `9f1649a` | A turn that times out while the Copilot runtime waits out an upstream 429 or 5xx fails as 429 or 529 instead of 500. `bridge.turn_timeout` records it as `upstreamRetryStatus`. A turn that ended without a message now waits for the error, or the idle after it, instead of finishing as an empty success. | `test/session-manager.test.mjs`, `test/server.test.mjs`, `test/upstream-errors.test.mjs`, and the [upstream 429 and 503 check](#upstream-429-503-and-retry-after) |

Other commits in the range: `462011e` adds a real Claude Code TUI driver to the
harness (`scripts/verify/tui.mjs`), but no scenario uses it yet, so interactive
TUI sessions are still not verified. `d6a2de9` and `cb0c09f` change
documentation only.

## One-off live checks

These checks ran outside the matrix. None adds a slot to any matrix result.

### Model picker and 1M windows

- **Checked:** the `/model` rows Claude Code shows, and the context window it
  assumes for each.
- **Ran:** on 2026-09-23 at 09:32 UTC, after the latest full run.
- **Result:** Claude Code's `supportedModels()` returned `Default` plus exactly
  the six rows, in order. Switching to each row with `setModel()` sent no
  request to the bridge. `getContextUsage()` reported 1M (auto-compact at 967K)
  for Opus 5.5, Sonnet 5 and the three GPT-6 rows, and 200K (auto-compact at
  167K) for Haiku 4.5. `Default` and the `opus` and `sonnet` aliases resolved to
  `claude-opus-5-5[1m]` and `claude-sonnet-5[1m]` (1M).
- **Typed model IDs:** an ID typed outside the picker is confirmed with one
  request. Opus 4.8 and 4.7 were confirmed at 1M. For Opus 5, Claude Code gave up
  after 5 seconds, before the model answered; an earlier measurement had
  confirmed it.
- **Record:** `.verify-runs/picker-1m-2026-09-23T09-32-55Z/`

### Runtime MCP servers

- **Checked:** whether the Copilot runtime still starts the MCP servers from the
  user's Copilot configuration, and what that cost.
- **Before and after the change (`1df3aa4`):** a cold bridge served two
  concurrent Claude sessions on Claude Haiku 4.5, in four alternating pairs.
  Before, one open session started azmcp and two Playwright MCP node servers
  (~330 MB RSS) plus the remote `microsoft-learn` and `github-mcp-server`
  connections, and the runtime removed them only when the SDK session closed. A
  bridge serving two sessions ran 6 such children; after the change it ran 0. The
  two cold first requests finished in a median 3.95 s instead of 8.08 s.
  Creating sessions one after another on a warm runtime took the same time within
  noise, because the runtime connects MCP servers after `session.create`
  returns. Record: `.verify-runs/mcp-check-2026-09-23T00-32-13Z/`
- **During full run `2026-09-23T00-38-10-470Z`** (commit `1df3aa4`, Claude Code
  2.1.280): a `ps` sampler took 354 samples over 12 minutes, with up to nine
  runtimes at once, and never saw an MCP server process under them. The only
  children were short-lived `git` calls and exiting processes (`<defunct>`,
  `(copilot-runtime)`). Record:
  `.verify-runs/runtime-sampler-2026-09-23T00-38-10Z/`
- **In the latest full run `2026-09-23T09-11-26-241Z`:** the audit of the raw
  record (`audit.json`) found that all 72 bridge logs the run kept (66 per-slot
  bridges and six v11 daemons) record `bridge.mcp_servers_disabled` for five
  servers. The harness itself does not check this event. The six v11
  foreground launches used short-lived bridges whose logs the launcher deletes
  on exit.

How the bridge disables these servers is in
[Copilot Runtime MCP Servers](ARCHITECTURE.md#copilot-runtime-mcp-servers).

### SDK input budgets

- **Checked:** the input budget the Copilot SDK actually applies to each model,
  as logged by `bridge.context_budget`.
- **Recorded in:** the bridge logs of the latest full run (`bed30ce`).
- **Result:** on the long-context tier, Astra 1,050,000, Sonnet 5 936,000, and
  Opus 5.5, Sol and Luna 872,000. On the default tier, Haiku 4.5 136,000. Before
  `44fb772`, the default tier held Opus 5.5 and Sonnet 5 to 200,000, whatever
  window Claude Code assumed.
- **Earlier probe (2026-09-22):** Astra's default tier allowed 272K input
  tokens. The long-context tier plus the catalogue limits gives 1.05M.
  Record: `.verify-runs/soak-20260922-1403/overnight/context-tier-probe/`

How the tier is chosen is in
[Model Discovery and Context](ARCHITECTURE.md#model-discovery-and-context).

### Long-context prompt

- **Checked:** whether a very large prompt reaches a 1M model intact.
- **Ran on:** the `bed30ce` code.
- **Result:** a 493,805-token prompt to Opus 5.5 through the bridge was answered
  correctly.

### Subagent model

- **Checked:** which model a subagent requests when it has no model of its own,
  and which model Copilot serves it with.
- **Ran on:** Claude Code 2.1.281, with the settings change that is now in
  `f6c1827`, using the launcher's gateway settings on `gpt-6-luna` and
  `gpt-6-astra`.
- **Result:** an Explore subagent and a general-purpose subagent with no model
  both requested the launch model (`github-copilot/claude-gpt-6-<name>`). The
  `servedModels` field of `bridge.turn_completed` showed Copilot serving every
  root and subagent turn with that model. The run had no failures.

### Upstream 429, 503 and retry-after

- **Checked:** what Claude Code sees when Copilot's inference endpoint fails.
  The Copilot runtime's `COPILOT_API_URL` pointed at a local proxy that failed
  inference requests with 429 or 503. Model: Claude Haiku 4.5, in `-p` mode.
- **Ran on:** Claude Code 2.1.281, with the bridge fix that is now in `9f1649a`.
- **Result:** the runtime made 6 attempts (about 50 s for 429, about 17 s for
  503). The bridge then returned 429 `rate_limit_error` and 529
  `overloaded_error`. Claude Code retried once, about 0.5 s later, and succeeded.
  This needed the bridge fix: the runtime ends the turn before it reports
  `session.error`, and the bridge used to finish that turn as an empty success.
- **`retry-after`:** when the proxy sent a 90 s `retry-after`, the runtime
  waited it out by itself, about 95 s with no events.

`npm run verify` never injects upstream errors; `BRIDGE_TEST_FAULTS` is used
only by `npm test`. This check is therefore the only live evidence for the
429/529 mapping. The mapping itself is in
[Upstream Errors](ARCHITECTURE.md#upstream-errors).

## Full-run history

Each row is one full run, judged under the code and model list it ran with.
Commit, Claude Code version, timeout scale and pending-tool wait come from each
run's `summary.json`. "+ uncommitted" means the checkout had uncommitted changes;
such a run can still pass when the code fingerprint is the same at start and end.
`PENDING_TOOL_WAIT_MS` was 30000 in every run except
`2026-09-23T07-29-33-556Z`, which used the default 10000.

### Six models (current lineup)

Claude Opus 5.5, Claude Sonnet 5, Claude Haiku 4.5, GPT-6 Astra, GPT-6 Sol and
GPT-6 Luna, × 11 scenarios = 66 slots. All six runs used Claude Code 2.1.280.

| Run ID (UTC) | What it tested | Commit | Pass / fail / blocked / unknown | Workers (model × scenario) | Timeout scale | Duration | User settings | Result |
|---|---|---|---|---|---|---|---|---|
| `2026-09-22T23-29-13-171Z` | First six-model run | `5f65539` | 64 / 2 / 0 / 0 | 3 × 2 | 2 | 778 s | Changed by an interactive session outside the harness | Did not pass |
| `2026-09-22T23-45-15-077Z` | v02 and v08 prompts name Edit and Write | `6a6691c` | 66 / 0 / 0 / 0 | 3 × 2 | 2 | 624 s | Unchanged | Pass |
| `2026-09-23T00-38-10-470Z` | Runtime MCP servers disabled | `1df3aa4` | 66 / 0 / 0 / 0 | 3 × 2 | 2 | 740 s | Unchanged | Pass |
| `2026-09-23T07-29-33-556Z` | 1M windows, not yet committed, command defaults | `eff2df6` + uncommitted | 64 / 1 / 1 / 0 | 6 × 2 | 1 | 487 s | Unchanged | Did not pass |
| `2026-09-23T08-28-09-543Z` | 1M windows, committed | `44fb772` | 65 / 1 / 0 / 0 | 3 × 2 | 2 | 474 s | Unchanged | Did not pass |
| `2026-09-23T09-11-26-241Z` | 1M windows and harness fixes (latest) | `bed30ce` | **66 / 0 / 0 / 0** | 3 × 2 | 2 | 479 s | Unchanged | **Pass** |

A full run started at `2026-09-23T08-22-51-615Z` was stopped after every slot
blocked; it has no row. The focused runs `2026-09-22T23-44-23-074Z` and
`2026-09-23T07-41-07-507Z` are separate records. None of their slots count
toward the final 66/66.

### Seven models (previous lineup)

Claude Opus 5, Claude Sonnet 5, Claude Haiku 4.5, GPT-5.6 Sol, GPT-5.6 Terra,
GPT-5.6 Luna and GPT-6 Astra, × 11 scenarios = 77 slots. All seven runs used
Claude Code 2.1.278.

| Run ID (UTC) | What it tested | Commit | Pass / fail / blocked / unknown | Workers (model × scenario) | Timeout scale | Duration | User settings | Result |
|---|---|---|---|---|---|---|---|---|
| `2026-09-21T22-54-08-294Z` | Earlier sign-off run, attempt 1 | `3b42a61` + uncommitted | 76 / 1 / 0 / 0 | 7 × 2 | 2 | 456 s | Changed (by what is unknown) | Did not pass |
| `2026-09-21T23-07-19-056Z` | Earlier sign-off run, attempt 2 | `3b42a61` + uncommitted | 74 / 2 / 1 / 0 | 7 × 2 | 2 | 863 s | Unchanged | Did not pass |
| `2026-09-22T00-01-29-757Z` | Fresh baseline | `c599309` | 76 / 1 / 0 / 0 | 7 × 2 | 2 | 943 s | Unchanged | Did not pass |
| `2026-09-22T00-30-59-086Z` | First correction | `c599309` + uncommitted | 75 / 2 / 0 / 0 | 7 × 2 | 2 | 973 s | Unchanged | Did not pass |
| `2026-09-22T00-52-51-013Z` | Before the picker and long-turn follow-up | `c599309` + uncommitted | 77 / 0 / 0 / 0 | 3 × 2 | 2 | 782 s | Unchanged | Pass |
| `2026-09-22T03-37-17-139Z` | Picker and long-turn fixes | `96e5e46` + uncommitted | 77 / 0 / 0 / 0 | 3 × 2 | 2 | 794 s | Unchanged | Pass |
| `2026-09-22T12-29-58-559Z` | Context and streaming recovery (last seven-model run) | `d84bd22` | 77 / 0 / 0 / 0 | 3 × 2 | 2 | 812 s | Unchanged | Pass |

## How the six-model run got to 66 of 66

In order:

1. **First run** (`2026-09-22T23-29-13-171Z`, 64/66). Claude Opus 5.5 did v02
   and v08 correctly, but with shell commands (`sed -i`, a redirect) instead of
   Edit and Write. The Edit exact-match check and the Write|Edit PreToolUse hook
   had nothing to observe, so both slots failed. Separately, an interactive
   Claude Code session outside the harness saved a `/model` choice to
   `~/.claude/settings.json` during the run, and the settings check correctly
   refused a pass.
2. **Prompt fix** (`6a6691c`). The v02 and v08 prompts now name Edit and Write,
   as the v08 cron turn already names CronCreate. Checks and pass criteria did
   not change. A focused rerun of both Opus 5.5 scenarios
   (`2026-09-22T23-44-23-074Z`) passed 2/2, and the next full run
   (`2026-09-22T23-45-15-077Z`) passed 66/66 in 624 s.
3. **Runtime MCP change** (`1df3aa4`). It needed a fresh full run on its own
   commit: `2026-09-23T00-38-10-470Z` passed 66/66 in 740 s. It took longer
   because another repository's Copilot runtime stability jobs were loading the
   same laptop (load average ≈ 8.5).
4. **1M windows, uncommitted** (`2026-09-23T07-29-33-556Z`, 64/66). This run
   used the command defaults: 6 × 2 workers, timeout scale 1 and a 10000 ms
   pending-tool wait. GPT-6 Luna's v02 plan turn was blocked at 90 s, and Claude
   Haiku 4.5 wrote the slashed zero of `IMGTAG84370D` as `Ø`. A focused rerun of
   v02 and v05 on those two models (`2026-09-23T07-41-07-507Z`) passed 3 slots,
   and Luna's v02 plan turn timed out at 90 s again.
5. **Clean worktree, wrong `claude`** (`2026-09-23T08-22-51-615Z`, stopped).
   Every slot blocked. Both launcher resolvers recognised only their own
   checkout's wrappers, so they picked the main checkout's `bin/claude` from
   PATH.
6. **1M windows, committed** (`44fb772`, `2026-09-23T08-28-09-543Z`, 65/66),
   run with the repository removed from PATH. GPT-6 Luna read the F of
   `IMGTAGA3F755` as E. Re-rendered in the same font, E and F are clearly
   distinct.
7. **Harness fixes.** `b8fa57a` makes the resolvers skip every checkout's
   launchers. `bed30ce` makes the v05 attachment checks accept one misread
   glyph, read `Ø` as `0`, and name any tolerated misread in the check detail.
   The check still catches what it is for: v05 exists to catch a bridge that
   drops the PDF or image block, and a model that never received the attachment
   cannot place five of six random hex glyphs (91 of 16^6 suffixes). Replayed
   over every recorded v05 answer, all 292 earlier passes still pass, and the 11
   answers that change to a pass are all single-glyph misreads.
8. **Latest full run** (`bed30ce`, `2026-09-23T09-11-26-241Z`, 66/66 in 479 s).
   It resolved `~/.local/bin/claude` with PATH unchanged.

## Previous seven-model record

The previous primary models were Claude Opus 5, Claude Sonnet 5, Claude Haiku
4.5, GPT-5.6 Sol, GPT-5.6 Terra, GPT-5.6 Luna and GPT-6 Astra. Their last full
run, `2026-09-22T12-29-58-559Z` on commit `d84bd22` with Claude Code 2.1.278,
passed 77/77.

The same work ran these separate probes. None adds a slot to any matrix result.

- A real Astra conversation completed 10 turns and four automatic compactions
  with a test-only 100K compact window (67K trigger), then repeated the marker
  planted in its first turn. Record:
  `.verify-runs/long-conversation-2026-09-22T02-30-14-506Z/`
- Recovery probes: Astra completed 24/24 turns with one native compaction and
  recalled the first marker at up to 809,115 input tokens. Haiku completed 9/9
  turns with two native compactions.
- A focused seven-model run of resume, fork and long context passed 14/14.
  Record: `.verify-runs/picker-longturn-regression/2026-09-22T02-40-55-670Z/`

The failures stay recorded as they happened:

- In the earlier sign-off runs: a Sonnet fork mismatch, an Opus result with zero
  usage, and a Haiku timeout.
- A Luna and a Haiku native background worker stuck at startup, before the
  first model request reached the bridge.
- An Opus refusal of wording that asked it to extract earlier messages broadly.
  That wording was replaced with plain factual questions.

Those runs made the harness stricter, not looser:

- Resume and fork prompts ask for the example deployment's original facts. All
  three phases must use no tools, so a write to persistent memory cannot stand in
  for inherited conversation context. Wrong dates, facts and session IDs still
  fail.
- An explicit zero usage is no longer replaced by an estimate. Zero total input
  usage, cache included, still fails. Neither the finalized assistant usage nor
  the cumulative `modelUsage` is substituted to make it pass.
- Content-free timeout and cancellation diagnostics, plus native daemon
  snapshots taken before cleanup, tell a bridge stall from a native startup
  stall. Command stdout and stderr and the daemon logs survive cleanup.

The cause of those intermittent SDK and native stalls is unknown, and nothing
here claims it is fixed. Earlier offline evidence:
`.verify-runs/soak-20260922-1403/overnight/runtime-fix-offline-v2.log`
