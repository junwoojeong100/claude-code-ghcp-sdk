# Testing

> **Language / 언어:** English | [한국어](TESTING_KO.md)

The required live check is **six scenarios, V01–V06, on all six primary models**:
Claude Opus 5.5, Sonnet 5, Haiku 4.5, GPT-6 Astra, Sol and Luna. That is **36 slots**.
It tests Claude Code → bridge → GitHub Copilot SDK → Copilot models, not every
Claude Code feature. The checks below are a pass contract, not a result. The
latest recorded outcome and its scope are in [Verification Results](VERIFICATION.md);
a focused run, or one recorded under an older scenario revision, cannot establish
this matrix's result.

The live matrix does not cover LiteLLM, production launchers or shared/background
daemons, permission approval dialogs or auto mode, external MCP services or
ToolSearch, subagents, hooks/skills/plugins, media, full-window capacity or
automatic overflow compaction, live 429/529 recovery, forks or crash/in-flight
recovery. Their production code and offline regressions remain. Implementation
support, offline regressions and live evidence are separate; see
[Compatibility](COMPATIBILITY.md).

## Offline checks and dry-run

Run all commands on this page from the repository root, after installing Node.js
`^20.19.0 || >=22.12.0`, npm, git and the repository dependencies, including dev
dependencies and `@xterm/headless`. See the [README](../README.md) for installation.

Both `npm test` and live verification require Python 3.9 or newer, available as
`python3` on PATH, with standard-library PTY support. The native terminal driver uses Python's
PTY and `@xterm/headless`, not a browser. `verify:plan` or `--dry-run` alone does not
require Python.

These commands make no model calls:

```bash
npm test
npm run verify:plan
PENDING_TOOL_WAIT_MS=30000 npm run verify -- \
  --model-concurrency 1 --timeout-scale 2 --dry-run
```

`npm test` retains production regressions for message/SSE conversion, model and
effort mapping, errors, cancellation, session/subagent isolation, runtime MCP
blocking, launchers and daemon lifecycle. Verifier tests exercise synthetic
36-slot coverage, evidence/integrity gates and owned-process cleanup. Passing
these tests is local evidence, not proof of real Copilot model behavior. A skipped
offline test was not exercised: report pass/fail/skip counts separately. It is not
a live **BLOCKED** slot, and neither is a pass.

`verify:plan` is the same runner with `--dry-run`. Dry-run is side-effect-free:
it validates the selection and prints expected slots and execution settings
without resolving or launching Claude Code, running preflight, starting a bridge,
fetching a catalogue or creating run artifacts. It checks neither login nor model
availability. Fix offline failures before spending credits.

## Prerequisites

For a live run, you also need:

- An existing Copilot login and policy access to **all six** primary models.
  An unavailable model stays **BLOCKED**; do not substitute another model or
  remove it from the full-run denominator. The bridge uses existing Copilot CLI
  authentication (`COPILOT_HOME`, normally `~/.copilot`).
- A real installed Claude Code executable supporting the required print and native
  terminal capabilities. By default the runner finds the first non-wrapper
  `claude` on PATH; it does not substitute an Agent SDK CLI.

**Optional CLI override:** set `CLAUDE_CODE_BIN` to the absolute path of the real
installed Claude Code executable only if needed. Never point it at this
repository's bridge wrappers or launchers. The live command below needs no override
when PATH already resolves the real CLI.

The runner starts private direct bridges with separate ports, tokens, settings and
temporary workspaces; it does not change global configuration or stop your shared
bridge. V03 starts a runner-owned local MCP fixture, not an external MCP service.
This isolation is **not a security sandbox**: permitted model-driven tools execute
on the host. Keep implementation, dependencies, the CLI and the default user
`~/.claude/settings.json` unchanged until the run ends; do not save that file from
another session. See [Environment and isolation](#environment-and-isolation) for
the exact inherited settings and integrity checks.

**The live slots spend GitHub Copilot AI Credits.** Thirty-six slots are not
36 API requests: slots contain multiple turns, tool round trips, and, in V06,
a new CLI and bridge. Preserve failed and blocked evidence instead of rerunning
until green. The no-harness-retry policy does not disable the CLI/runtime's own
upstream retry behavior.

Artifacts can contain bridge tokens, conversation/tool content and private paths,
including native transcripts and configuration files. Gitignore is not redaction;
review before sharing.

## Run the required six-model check

```bash
PENDING_TOOL_WAIT_MS=30000 npm run verify -- \
  --model-concurrency 1 --timeout-scale 2
```

A full run first exercises the **actual installed Claude Code** against a bounded
local mock Messages API. This preflight makes no Copilot model calls: it checks
the native/print capabilities and isolation needed by the scenarios. Unavailable
capabilities block the affected slots; they do not become synthetic passes or
silently disappear. The remaining live matrix is attempted once, with **no
harness retries**. A cleanup or isolation breach stops further live work.

`--model-concurrency 1` is the default; scenarios run sequentially within each
model. `--timeout-scale` defaults to 1; the command uses 2. It scales verifier
budgets, not bridge runtime budgets or every CLI wait. `PENDING_TOOL_WAIT_MS`
defaults to 10000; the command explicitly uses 30000. These settings are recorded,
not guarantees of success. See [Time budgets](#time-budgets).

Other options are `--out DIR` (parent for timestamped runs; default `.verify-runs/`
in the repository) and `--keep-workspaces` (also keep passing workspaces).
`--models a,b` and `--scenarios V01,V02` select known, unique subsets **for focused
debugging only**. A subset may pass its own checks but cannot establish the full
36-slot result. There is no `--scenario-concurrency` option.

## Read the result and generate documents

Use the **exact directory** printed on the runner's `artifacts:` line, including
any `--out` location. Do not select a run merely because it is newest. To inspect
that run without replacing the recorded result documents:

```bash
run_dir=".verify-runs/<timestamp-from-artifacts-line>"
npm run verify:report -- "$run_dir"
```

**A report command's exit code 0 means rendering succeeded, not that the matrix
passed.** Read the verdict, scope and counts. A confirmed violation is **FAIL**;
otherwise missing required execution or evidence is **BLOCKED**, including absent
or uninterpretable SDK model evidence. Only all required checks passing is
**PASS**. Missing later evidence cannot hide an already confirmed failure.

A full pass needs **all 36 expected slots** plus the
[integration and whole-run gates](#integration-and-whole-run-gates). Failed and
blocked slots remain in that denominator, and a focused pass is not a full pass.
For a failure, start with the report's run-level problems and the slot's failed
checks, then follow the [evidence reference](#evidence-and-report-reference).

### Optional: replace the recorded result documents

Only when you intend to update the repository's recorded results, use the same
explicit `run_dir`:

```bash
npm run verify:doc -- "$run_dir"
```

This **overwrites both `docs/VERIFICATION.md` and `docs/VERIFICATION_KO.md`** from
the selected run, rendering both before replacing either document. It is not
needed to inspect a result. Both report commands are local file operations, not
model calls or external publication. Keep failures and focused runs labelled as
such, and review the generated diff before committing it. Rendering success does
not turn a failed or blocked run into a pass.

## What a pass means

### Coding and resume

Coding and resume are separate scenarios, not two phases of one scenario:

- **V02:** successful Reads return the complete hidden sample, source and tests
  before the initial foreground test. The initial discount regression fails;
  a successful Edit changes only `discount.mjs`; the identical unmasked test
  command then passes all **three** tests. The harness independently reruns the
  tests and checks the exact correction and unchanged other files, modes and
  links. The final answer must be the hidden sample. Tool IDs, arguments, returned
  contents, ordering and file evidence are required; the model saying “done” is
  not enough. Chaining, redirection or backgrounding cannot mask the test result.
- **V06:** native `/compact` must produce an actual summary request and a native
  compaction boundary, followed by exact recall of a conversation-only random
  value. That recall must come from a new SDK session: every SDK session ID the
  bridge reports for it differs from those of the seed and compact requests. The
  seed request must carry the seed prompt, and no recall request may, so the new
  session was sent the compacted history. Missing session IDs or request digests
  block the slot; a reused session or a resent seed prompt fails it. After a normal
  CLI exit and cleanup of the first private bridge, a new CLI and new private
  bridge resume the **exact saved session ID** and recall the same value.
  Follow-up prompts do not repeat it; tools, files or auxiliary memory cannot
  supply it. This is cold conversation replay after orderly shutdown,
  **not recovery of a turn in flight or shared-daemon restart verification**.

### Other required scenarios

- **V01:** a real print-mode response is exact; the native picker exposes all six
  targets; a fresh Unicode answer is exact; native `/clear` changes the session
  and removes the old conversation from the next request.
- **V03:** the CLI-owned local MCP lookup first returns the expected ENOENT error
  for `missing`, then the hidden `selected` value. Native tool IDs, arguments,
  results and the MCP ledger must agree, without a file/shell bypass. A second
  turn recalls the exact value without tools in the same process and session.
- **V04:** a different source model answers before native `/model` selects the
  target in the same conversation. New responses retain context and match their
  phase's requested, resolved and SDK-reported model. High effort reaches models
  that support it and matches actual SDK model state; Haiku must have **no applied
  effort**. This is not a test of every effort level or Ultracode.
- **V05:** Escape interrupts a request that is actually streaming. The same
  request must have `client_abort` and an acknowledged SDK abort, not normal
  completion. The same native process and session then return the exact recovery
  answer in a complete response.

### Integration and whole-run gates

Successful print phases need valid completed results and clean exits. Native
phases need fresh native records, correlated completed responses and their
scenario-specific lifecycle evidence; they are not judged by fabricated print
result envelopes. V05's interrupted phase instead requires its abort evidence.
Tool calls/results must pair uniquely in order, with no undeclared tools or
unexpected tool errors. Completed responses need finite, nonnegative reported
usage with input/output activity and matching stop reasons.

Root assistant `message.id` values are correlated with slot-local
`bridge.turn_completed.responseId`. Corresponding requested/resolved models and
**every** SDK-reported `servedModels` entry must match the phase's expected model
after known-alias/context-suffix normalization. V04's source phase intentionally
uses a different model. CLI `modelUsage` or catalogue membership cannot replace
this evidence. This confirms **SDK-reported IDs**, not independent proof of the
provider's internal model implementation.

Only the verifier enables default-off `BRIDGE_VERIFY_OBSERVE=1`. Its observations
correlate request/response IDs, session IDs and content digests rather than raw
request contents. Model/effort evidence reads actual SDK model state with a
5-second bound; missing state is not inferred from the requested configuration.
This does not make native artifacts or combined error logs safe to share.

A full pass requires exactly the **36 expected model/scenario slots**, no
missing/duplicate/unexpected/unknown results, intact saved evidence/source hashes,
unchanged code fingerprints and pinned CLI binary, unchanged observed settings,
private-configuration isolation and successful owned-process cleanup.
**All 36 must pass; fail and blocked never count as pass.** The settings check has
the specific scope below; it does not fingerprint all user configuration.

## Environment and isolation

Each private direct bridge has its own loopback port and token. Each slot uses
private settings, a `CLAUDE_CONFIG_DIR` and a temporary workspace outside the
checkout. Print and native launches use isolated settings and capability-checked
CLI options. Automatic memory and external hooks, plugins and MCP must not supply
answers. V02 permits scoped Read/Edit/Bash; V03 permits only its local MCP tools;
recall turns must not use tools.

Claude Code's settings for each slot come from the production writer
(`src/write-launch-settings.mjs`), which the runner hands the bridge token as
`GHCP_BRIDGE_TOKEN`, never on the command line. They use the production credential
path: the token as `ANTHROPIC_AUTH_TOKEN`, which Claude Code sends as
`Authorization: Bearer`, and a blank `ANTHROPIC_API_KEY`. The runner adds only
isolation keys such as `autoMemoryEnabled: false` and `disableAllHooks: true`. If
Claude Code shows the "Do you want to use this API key?" dialog, the harness
refuses it and the launch fails.

The private bridges inherit your Copilot credentials and connectivity settings
(`GH_TOKEN`, `GITHUB_TOKEN`, `COPILOT_*` such as `COPILOT_HOME` and
`COPILOT_CLI_PATH`, proxy variables) and the six runtime budgets
`TURN_IDLE_TIMEOUT_MS`, `TURN_MAX_DURATION_MS`, `SESSION_OPERATION_TIMEOUT_MS`,
`PENDING_TOOL_WAIT_MS`, `CLEANUP_TIMEOUT_MS` and `STATE_IDLE_TTL_MS`, which the
runner records and compares with each bridge's `/health`. `MAX_BODY_BYTES`,
`MAX_REPLAY_BYTES`, `MAX_STATES`, `MAX_TOOL_RESULTS`, `RETIRED_IDLE_MS`,
`ALLOW_NON_LOOPBACK` and `COPILOT_SDK_DEFAULT_CONNECTION` are removed, so every run
uses their shipped defaults. `ANTHROPIC_*`, `CLAUDE*`, `BRIDGE_*`, `GHCP_*`,
`OPENAI_*`, `AZURE_OPENAI_*`, `ENABLE_TOOL_SEARCH` and `NODE_OPTIONS` are removed
as well.

The run-level user-settings check compares the before/after state of the default
**`~/.claude/settings.json`**. Separately, each slot hashes its private launch
`settings.json` after writing it and at cleanup, including `settings-2.json` for
V06's second bridge. These are not fingerprints of the entire `~/.claude`
directory, every configuration source or every file in the slot's config directory.
Code fingerprints cover the selected implementation, verifier, launcher, test and
package files, not documentation, `.env` or all installed dependency contents.
The runner also pins the real CLI's path, version and binary hash and checks that
the binary stays unchanged. It starts bridges directly, so none of these checks
establish production-launcher, shared-daemon, retirement or background-session
lifecycle behavior.

## Time budgets

The scenario limits are **per-slot budgets covering bridge startup and all
phases**, not fresh budgets per phase or a deadline for the entire matrix.

| Scenario | Phases | Slot budget before scaling |
|---|---|---|
| V01 | `print`, `unicode`, `clear` | 240 seconds |
| V02 | `coding` | 300 seconds |
| V03 | `lookup`, `recall` | 240 seconds |
| V04 | `source`, `target` | 240 seconds |
| V05 | `interrupt`, `recovery` | 240 seconds |
| V06 | `seed`, `compact`, `recall`, `resume` | 420 seconds |

`--timeout-scale` multiplies these verifier budgets and nothing else: each slot
budget above, the bridge startup wait (`bridgeHealthMs`, 120 seconds), the cleanup
budget (`cleanupMs`, 10 seconds) and V05's interrupt budgets (progress 90, settle 15
and recovery 60 seconds). Print phases and model turns wait for whatever remains
of the scaled slot budget. The native CLI's own step waits are fixed and do not
scale: prompt readiness at most 30 seconds, declared MCP tools ready at most 15 seconds,
startup-dialog input 3 seconds, input acknowledgment and prompt entry 5 seconds,
graceful `/exit` 2 + 3 seconds and the PTY helper's close 5 seconds. So are V02's
independent test rerun (at most 30 seconds), the bridge's `SIGTERM` grace before
`SIGKILL` (at most 5 seconds) and the local preflight's own budgets.
The bridge's runtime budgets are never scaled.

## Evidence and report reference

### Integrity and metadata

Reports check saved v2 source snapshots, hash manifests and raw evidence rather
than trusting a stored `pass` label or substituting today's catalogue. The report
lists, in order: the result and counts, the model × scenario matrix, failures and
missing evidence, the scenario criteria, phase evidence, run metadata, evidence
and reproduction, and limits.

- It re-evaluates each saved PASS slot's stored raw evidence with the current
  checkout's evaluator and never upgrades a saved failure. The frozen source
  copies under `sources/files/` are reproduction material: their hashes are
  checked, and they are never executed. A run recorded under an older scenario
  revision does not match the current suite and cannot be green.
- The effort column shows requested / applied / observed for each correlated
  model-state record. `not requested` means the request carried no effort,
  `not applied` that the bridge applied none, `not reported by SDK` that the SDK
  model state had no `reasoningEffort`, `observation failed (<reason>)` that the
  model-state read failed, `no model state` that nothing was correlated, and
  `unknown` that the saved record lacks the field. No value is filled in.
- Run metadata shows, per slot, each CLI launch's exit code, signal, forced stop,
  `SIGKILL` escalation and whether its owned processes were reaped, and each
  bridge's stop receipt (group gone, port released, exit code, signal) with a
  short `/health` summary. The full `/health` record stays in `slots.jsonl`. A slot
  that never launched shows `CLI not started` or `bridge not started`.
- The optional new-live-run command repeats every recorded runtime budget that
  differs from its default. The abort and MCP-discovery budgets have no override.
- The generated Markdown names no home directory or macOS per-user temporary
  root: `~` or `$HOME` and `$TMPDIR` stand for them (`-HOME` and `-TMPDIR` inside
  Claude project-directory names), paths inside the run directory are relative to
  it, and commands use `"$HOME/..."` so they can still be pasted. The terminal
  report keeps absolute paths.
- SDK version metadata identifies the installed package, not the runtime binary
  or model. Reports use its saved value only: missing metadata stays **not
  recorded**, never filled from today's installation. A `COPILOT_CLI_PATH`
  override can select another runtime.

### Files and cleanup

- `summary.json`: the saved scenario definitions and expected matrix, execution
  settings, preflight, Claude/Node/host versions, installed `copilotSdk.version`,
  start/end code and default user-settings evidence, and cleanup results.
- `sources/manifest.json` and `sources/files/`: saved v2 source manifest and source
  snapshots. `artifact-manifest.json` records hashes for retained run evidence.
- `slots.jsonl`: each model/scenario's `outcome`, `reason`, `checks`,
  `evidence.phases`, raw evidence, SDK observations, workspace and cleanup receipts.
- `slots/<model>__Vxx/`: print-phase `transcript-<phase>.jsonl`, native terminal
  logs and session transcripts, and `bridge.log`. V06 also has `bridge-2.log`
  from its replacement private bridge. Use the recorded phase/transcript paths
  and response IDs, not unrelated auxiliary traffic. Terminal display text alone
  is not answer evidence. [Diagnostics](DIAGNOSTICS.md) explains the log fields.
- Next to each native launch's raw `terminal-<launchId>.log`:
  `terminal-events-<launchId>.jsonl` (input and output receipts without input
  bytes; each Escape is labelled `test-interrupt`, `cleanup`, `picker-dismiss`
  or `mcp-dismiss` (closing the /mcp readiness panel at launch); an interruption
  row also holds the rendered screen, which shows the typed prompt),
  `cleanup-<pid>.json`, and `terminal-output-<launchId>.jsonl`, an output-only
  recording with the driver's phase markers. The recording's footer describes
  capture, not the verdict, and it is not answer evidence
  ([details](DIAGNOSTICS.md#find-the-evidence)).
- The recorded workspace: retained for failed/blocked slots; passing workspaces
  are removed unless `--keep-workspaces` is set. Run artifacts remain separately.

An interrupted run lacks required completion evidence and cannot pass. Inspect
only processes and files owned by that run; do not use `claude-ghcp-stop` to clean
it up, since the verifier does not use the shared daemon. Old run directories and
retained workspaces are not automatically deleted.

### Recordings and redaction

`node scripts/verify/render-recording.mjs --spec <spec.json> --out <new dir>`
renders stills and an MP4 offline from the terminal recordings of a finished run,
with no model calls. The spec names the run and the segments or stills to render
(`parseSpec` in that file defines it). It needs system Google Chrome and
`ffmpeg`/`ffprobe` on PATH. It accepts only recordings sealed in the run's
artifact manifest, and it refuses an output directory that is not new or empty or
that lies inside `.verify-runs/` or the run. Before rendering it replaces home and
temporary paths, `sk-` keys (including masked `sk-...` displays), `gh*_` and
`github_pat_` keys, hex or base64url runs of 32 or more characters that contain
both letters and digits, and the username with same-width placeholders. That
redaction is pattern-based: prompts and replies shown on screen are not redacted,
so inspect the output before publishing it. The result is labelled an edited
replay of real PTY recordings and is not verification evidence.
