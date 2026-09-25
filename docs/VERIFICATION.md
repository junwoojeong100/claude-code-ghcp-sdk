# Essential integration verification

> English | [한국어](VERIFICATION_KO.md)

result: NOT PASSED
pass 35 / fail 1 / blocked 0 / unknown 0
expected: 36 / actual: 36 / gate: 36
scope: full (36 full-matrix cases)
policy: strict-all-pass-v2; suite: claude-ghcp-essential-v1; schema: 2
Full PASS requires all 36 canonical slots, required phase checks, replayed raw evidence, cleanup, unchanged settings/code/binary and verified source/artifact hashes. BLOCKED is not a pass.

## Model × scenario results

| Selected model | V01 | V02 | V03 | V04 | V05 | V06 |
| --- | --- | --- | --- | --- | --- | --- |
| claude-opus-5.5 | PASS | PASS | PASS | PASS | PASS | PASS |
| claude-sonnet-5 | PASS | PASS | PASS | PASS | PASS | PASS |
| claude-haiku-4.5 | PASS | FAIL | PASS | PASS | PASS | PASS |
| gpt-6-astra | PASS | PASS | PASS | PASS | PASS | PASS |
| gpt-6-sol | PASS | PASS | PASS | PASS | PASS | PASS |
| gpt-6-luna | PASS | PASS | PASS | PASS | PASS | PASS |

## Failures and missing evidence

- Every expected slot must pass; fail, blocked and unknown outcomes are not passes.
- FAIL claude-haiku-4.5 × V02: coding: exact answer: entire fresh answer must match
  - coding: exact answer: entire fresh answer must match
  - coding: exact answer: entire fresh answer must match
    - exact answer: entire fresh answer must match

## Scenario criteria

Required criteria are not claims that failed or blocked cases met them.
- V01 r2 — Launch, Unicode and fresh conversation
  - A real print-mode response completes with exactly the requested answer.
  - The native picker exposes all six target models; a new Unicode answer is exact.
  - Native /clear changes the session and removes the previous conversation from the next request.
- V02 r1 — Read, edit and regression tests
  - Read returns the complete hidden sample, source and tests before the failing foreground test.
  - A successful Edit fixes only discount.mjs, followed by the identical unmasked test command and three passes.
  - An independent test run passes; other files, modes and links are unchanged; the final answer is the hidden sample.
- V03 r1 — MCP error and tool-result recovery
  - The CLI-owned MCP lookup returns ENOENT for missing before returning the hidden selected value.
  - Native tool IDs, arguments, results and MCP ledger agree; no file/shell bypass is used.
  - A second turn recalls the exact value without tools in the same process and session.
- V04 r1 — Model and reasoning-level switch
  - A different source model answers before native /model selects the target in the same conversation.
  - Each new response's requested, resolved and SDK-reported model matches its phase, retaining conversation context.
  - High effort reaches supported models and matches authoritative SDK state; Haiku has no applied effort.
- V05 r2 — Interrupt and continue
  - Escape interrupts an actively streaming request, with correlated client_abort and acknowledged SDK abort, not normal completion.
  - The same native process and session answer the follow-up exactly with a complete response.
- V06 r2 — Compact, quit and cold resume
  - Native /compact records an actual summary request and compaction boundary; a fresh SDK session, sent the compacted history without the seed prompt, recalls a conversation-only value exactly.
  - Normal exit and owned bridge cleanup precede a new CLI and bridge resuming the exact saved session ID.
  - The resumed session recalls the same value without tools or auxiliary memory; no prompt repeats the value.

## Phase evidence

Bridge requested labels and SDK-reported IDs are separate. Only correlated SDK records count as served-model evidence; missing evidence stays unknown. Model catalogue exposure is not execution proof.
Effort shows requested / applied / observed for each correlated model-state record: "not requested" means the request carried no effort, "not applied" means the bridge applied none, "not reported by SDK" means the SDK model state omitted reasoningEffort, "observation failed (reason)" means the model-state read failed for the recorded reason, "no model state" means no record was correlated and "unknown" means the saved record lacks the field. No value is filled in.
| Model / case | Phase | Result | Bridge requested labels | SDK-reported IDs | Effort requested / applied / observed |
| --- | --- | --- | --- | --- | --- |
| claude-opus-5.5 / V01 | print | PASS | claude-opus-5-5 | claude-opus-5.5 | medium / medium / medium |
| claude-opus-5.5 / V01 | unicode | PASS | claude-opus-5-5 | claude-opus-5.5 | medium / medium / medium |
| claude-opus-5.5 / V01 | clear | PASS | claude-opus-5-5 | claude-opus-5.5 | medium / medium / medium |
| claude-opus-5.5 / V02 | coding | PASS | claude-opus-5-5 | claude-opus-5.5 | medium / medium / medium; medium / medium / medium; medium / medium / medium; medium / medium / medium; medium / medium / medium |
| claude-opus-5.5 / V03 | lookup | PASS | claude-opus-5-5 | claude-opus-5.5 | medium / medium / medium; medium / medium / medium; medium / medium / medium |
| claude-opus-5.5 / V03 | recall | PASS | claude-opus-5-5 | claude-opus-5.5 | medium / medium / medium |
| claude-opus-5.5 / V04 | source | PASS | github-copilot/claude-gpt-6-astra | gpt-6-astra | high / high / high |
| claude-opus-5.5 / V04 | target | PASS | claude-opus-5-5 | claude-opus-5.5 | high / high / high |
| claude-opus-5.5 / V05 | interrupt | PASS | claude-opus-5-5 | unknown | no model state |
| claude-opus-5.5 / V05 | recovery | PASS | claude-opus-5-5 | claude-opus-5.5 | medium / medium / medium |
| claude-opus-5.5 / V06 | seed | PASS | claude-opus-5-5 | claude-opus-5.5 | medium / medium / medium |
| claude-opus-5.5 / V06 | compact | PASS | claude-opus-5-5 | claude-opus-5.5 | no model state |
| claude-opus-5.5 / V06 | recall | PASS | claude-opus-5-5 | claude-opus-5.5 | medium / medium / medium |
| claude-opus-5.5 / V06 | resume | PASS | claude-opus-5-5 | claude-opus-5.5 | medium / medium / medium |
| claude-sonnet-5 / V01 | print | PASS | claude-sonnet-5 | claude-sonnet-5 | high / high / high |
| claude-sonnet-5 / V01 | unicode | PASS | claude-sonnet-5 | claude-sonnet-5 | high / high / high |
| claude-sonnet-5 / V01 | clear | PASS | claude-sonnet-5 | claude-sonnet-5 | high / high / high |
| claude-sonnet-5 / V02 | coding | PASS | claude-sonnet-5 | claude-sonnet-5 | high / high / high; high / high / high; high / high / high; high / high / high; high / high / high |
| claude-sonnet-5 / V03 | lookup | PASS | claude-sonnet-5 | claude-sonnet-5 | high / high / high; high / high / high; high / high / high |
| claude-sonnet-5 / V03 | recall | PASS | claude-sonnet-5 | claude-sonnet-5 | high / high / high |
| claude-sonnet-5 / V04 | source | PASS | github-copilot/claude-gpt-6-astra | gpt-6-astra | high / high / high |
| claude-sonnet-5 / V04 | target | PASS | claude-sonnet-5 | claude-sonnet-5 | high / high / high |
| claude-sonnet-5 / V05 | interrupt | PASS | claude-sonnet-5 | unknown | no model state |
| claude-sonnet-5 / V05 | recovery | PASS | claude-sonnet-5 | claude-sonnet-5 | high / high / high |
| claude-sonnet-5 / V06 | seed | PASS | claude-sonnet-5 | claude-sonnet-5 | high / high / high |
| claude-sonnet-5 / V06 | compact | PASS | claude-sonnet-5 | claude-sonnet-5 | no model state |
| claude-sonnet-5 / V06 | recall | PASS | claude-sonnet-5 | claude-sonnet-5 | high / high / high |
| claude-sonnet-5 / V06 | resume | PASS | claude-sonnet-5 | claude-sonnet-5 | high / high / high |
| claude-haiku-4.5 / V01 | print | PASS | claude-haiku-4-5 | claude-haiku-4.5 | not requested / not applied / not reported by SDK |
| claude-haiku-4.5 / V01 | unicode | PASS | claude-haiku-4-5 | claude-haiku-4.5 | not requested / not applied / not reported by SDK |
| claude-haiku-4.5 / V01 | clear | PASS | claude-haiku-4-5 | claude-haiku-4.5 | not requested / not applied / not reported by SDK |
| claude-haiku-4.5 / V02 | coding | FAIL | claude-haiku-4-5 | claude-haiku-4.5 | not requested / not applied / not reported by SDK; not requested / not applied / not reported by SDK; not requested / not applied / not reported by SDK; not requested / not applied / not reported by SDK; not requested / not applied / not reported by SDK |
| claude-haiku-4.5 / V03 | lookup | PASS | claude-haiku-4-5 | claude-haiku-4.5 | not requested / not applied / not reported by SDK; not requested / not applied / not reported by SDK; not requested / not applied / not reported by SDK |
| claude-haiku-4.5 / V03 | recall | PASS | claude-haiku-4-5 | claude-haiku-4.5 | not requested / not applied / not reported by SDK |
| claude-haiku-4.5 / V04 | source | PASS | github-copilot/claude-gpt-6-astra | gpt-6-astra | high / high / high |
| claude-haiku-4.5 / V04 | target | PASS | claude-haiku-4-5 | claude-haiku-4.5 | not requested / not applied / not reported by SDK |
| claude-haiku-4.5 / V05 | interrupt | PASS | claude-haiku-4-5 | unknown | no model state |
| claude-haiku-4.5 / V05 | recovery | PASS | claude-haiku-4-5 | claude-haiku-4.5 | not requested / not applied / not reported by SDK |
| claude-haiku-4.5 / V06 | seed | PASS | claude-haiku-4-5 | claude-haiku-4.5 | not requested / not applied / not reported by SDK |
| claude-haiku-4.5 / V06 | compact | PASS | claude-haiku-4-5 | claude-haiku-4.5 | no model state |
| claude-haiku-4.5 / V06 | recall | PASS | claude-haiku-4-5 | claude-haiku-4.5 | not requested / not applied / not reported by SDK |
| claude-haiku-4.5 / V06 | resume | PASS | claude-haiku-4-5 | claude-haiku-4.5 | not requested / not applied / not reported by SDK |
| gpt-6-astra / V01 | print | PASS | github-copilot/claude-gpt-6-astra | gpt-6-astra | high / high / high |
| gpt-6-astra / V01 | unicode | PASS | github-copilot/claude-gpt-6-astra | gpt-6-astra | high / high / high |
| gpt-6-astra / V01 | clear | PASS | github-copilot/claude-gpt-6-astra | gpt-6-astra | high / high / high |
| gpt-6-astra / V02 | coding | PASS | github-copilot/claude-gpt-6-astra | gpt-6-astra | high / high / high; high / high / high; high / high / high; high / high / high; high / high / high; high / high / high; high / high / high |
| gpt-6-astra / V03 | lookup | PASS | github-copilot/claude-gpt-6-astra | gpt-6-astra | high / high / high; high / high / high; high / high / high |
| gpt-6-astra / V03 | recall | PASS | github-copilot/claude-gpt-6-astra | gpt-6-astra | high / high / high |
| gpt-6-astra / V04 | source | PASS | github-copilot/claude-gpt-6-luna | gpt-6-luna | high / high / high |
| gpt-6-astra / V04 | target | PASS | github-copilot/claude-gpt-6-astra | gpt-6-astra | high / high / high |
| gpt-6-astra / V05 | interrupt | PASS | github-copilot/claude-gpt-6-astra | unknown | no model state |
| gpt-6-astra / V05 | recovery | PASS | github-copilot/claude-gpt-6-astra | gpt-6-astra | high / high / high |
| gpt-6-astra / V06 | seed | PASS | github-copilot/claude-gpt-6-astra | gpt-6-astra | high / high / high |
| gpt-6-astra / V06 | compact | PASS | github-copilot/claude-gpt-6-astra | gpt-6-astra | no model state |
| gpt-6-astra / V06 | recall | PASS | github-copilot/claude-gpt-6-astra | gpt-6-astra | high / high / high |
| gpt-6-astra / V06 | resume | PASS | github-copilot/claude-gpt-6-astra | gpt-6-astra | high / high / high |
| gpt-6-sol / V01 | print | PASS | github-copilot/claude-gpt-6-sol | gpt-6-sol | high / high / high |
| gpt-6-sol / V01 | unicode | PASS | github-copilot/claude-gpt-6-sol | gpt-6-sol | high / high / high |
| gpt-6-sol / V01 | clear | PASS | github-copilot/claude-gpt-6-sol | gpt-6-sol | high / high / high |
| gpt-6-sol / V02 | coding | PASS | github-copilot/claude-gpt-6-sol | gpt-6-sol | high / high / high; high / high / high; high / high / high; high / high / high; high / high / high; high / high / high; high / high / high |
| gpt-6-sol / V03 | lookup | PASS | github-copilot/claude-gpt-6-sol | gpt-6-sol | high / high / high; high / high / high; high / high / high |
| gpt-6-sol / V03 | recall | PASS | github-copilot/claude-gpt-6-sol | gpt-6-sol | high / high / high |
| gpt-6-sol / V04 | source | PASS | github-copilot/claude-gpt-6-astra | gpt-6-astra | high / high / high |
| gpt-6-sol / V04 | target | PASS | github-copilot/claude-gpt-6-sol | gpt-6-sol | high / high / high |
| gpt-6-sol / V05 | interrupt | PASS | github-copilot/claude-gpt-6-sol | unknown | no model state |
| gpt-6-sol / V05 | recovery | PASS | github-copilot/claude-gpt-6-sol | gpt-6-sol | high / high / high |
| gpt-6-sol / V06 | seed | PASS | github-copilot/claude-gpt-6-sol | gpt-6-sol | high / high / high |
| gpt-6-sol / V06 | compact | PASS | github-copilot/claude-gpt-6-sol | gpt-6-sol | no model state |
| gpt-6-sol / V06 | recall | PASS | github-copilot/claude-gpt-6-sol | gpt-6-sol | high / high / high |
| gpt-6-sol / V06 | resume | PASS | github-copilot/claude-gpt-6-sol | gpt-6-sol | high / high / high |
| gpt-6-luna / V01 | print | PASS | github-copilot/claude-gpt-6-luna | gpt-6-luna | high / high / high |
| gpt-6-luna / V01 | unicode | PASS | github-copilot/claude-gpt-6-luna | gpt-6-luna | high / high / high |
| gpt-6-luna / V01 | clear | PASS | github-copilot/claude-gpt-6-luna | gpt-6-luna | high / high / high |
| gpt-6-luna / V02 | coding | PASS | github-copilot/claude-gpt-6-luna | gpt-6-luna | high / high / high; high / high / high; high / high / high; high / high / high; high / high / high; high / high / high; high / high / high |
| gpt-6-luna / V03 | lookup | PASS | github-copilot/claude-gpt-6-luna | gpt-6-luna | high / high / high; high / high / high; high / high / high |
| gpt-6-luna / V03 | recall | PASS | github-copilot/claude-gpt-6-luna | gpt-6-luna | high / high / high |
| gpt-6-luna / V04 | source | PASS | github-copilot/claude-gpt-6-astra | gpt-6-astra | high / high / high |
| gpt-6-luna / V04 | target | PASS | github-copilot/claude-gpt-6-luna | gpt-6-luna | high / high / high |
| gpt-6-luna / V05 | interrupt | PASS | github-copilot/claude-gpt-6-luna | unknown | no model state |
| gpt-6-luna / V05 | recovery | PASS | github-copilot/claude-gpt-6-luna | gpt-6-luna | high / high / high |
| gpt-6-luna / V06 | seed | PASS | github-copilot/claude-gpt-6-luna | gpt-6-luna | high / high / high |
| gpt-6-luna / V06 | compact | PASS | github-copilot/claude-gpt-6-luna | gpt-6-luna | no model state |
| gpt-6-luna / V06 | recall | PASS | github-copilot/claude-gpt-6-luna | gpt-6-luna | high / high / high |
| gpt-6-luna / V06 | resume | PASS | github-copilot/claude-gpt-6-luna | gpt-6-luna | high / high / high |

## Run metadata

run: .verify-runs/2026-09-25T09-55-54-058Z-9bdbc340
Claude Code: 2.1.282 (~/.local/share/claude/versions/2.1.282); SHA256 fcfd837103965c64de34a6b9b94370d77a347ea71819715a27d5f0ef01775ea4; end SHA256 fcfd837103965c64de34a6b9b94370d77a347ea71819715a27d5f0ef01775ea4
Copilot SDK (@github/copilot-sdk) package version: 1.0.14; npm package version recorded when the run started, not the Copilot runtime binary identity
Node: v22.16.0; host: darwin arm64 25.6.0
start: 2026-09-25T09:55:54.058Z; end: 2026-09-25T10:12:54.177Z; seconds: 1020
code start: commit 580b7c50df917d0841e821d4bd34c7e937e54caf; dirty: true; fingerprint: sha256 verification-code-v2 9596932c38c894528649b42ad70e918df24b09ed8ec3f6c2280607676ac3e600; files: 102
code end: commit 580b7c50df917d0841e821d4bd34c7e937e54caf; dirty: true; fingerprint: sha256 verification-code-v2 9596932c38c894528649b42ad70e918df24b09ed8ec3f6c2280607676ac3e600; files: 102
sources: sources/manifest.json; SHA256 3911b2b5a0771722770cbe66964e7591be37e6710dab328a3fbc5f92ebfa8811
reference commit: 647a5285e8c6ddba638db0aa406b48f15ba64327
reference scripts/verification/catalog.mjs: e64fa93b44769dd36417be157f37c7e756d8d44bc7c9e1ed6108ae5b6294701d
reference scripts/verification/scenarios.mjs: 45852c4770b5f1fb78ed033b7d6075b4251b4862446b8b1971ea45b9288ae548
user settings: ~/.claude/settings.json; intact: true; before: present:cc7894c5e801f76809be171ef481142a05a419dcb0b01c8a606b68edd828b887; after: present:cc7894c5e801f76809be171ef481142a05a419dcb0b01c8a606b68edd828b887
--model-concurrency: 1
--timeout-scale: 2
PENDING_TOOL_WAIT_MS: 30000
bridgeHealthMs: 240000
cleanupMs: 20000
scenarioMs.V01: 480000
scenarioMs.V02: 600000
scenarioMs.V03: 480000
scenarioMs.V04: 480000
scenarioMs.V05: 480000
scenarioMs.V06: 840000
runtime.turnTimeoutMs: 300000
runtime.maxTurnDurationMs: 1800000
runtime.sessionOperationTimeoutMs: 60000
runtime.pendingToolWaitMs: 30000
runtime.abortTimeoutMs: 5000
runtime.cleanupTimeoutMs: 5000
runtime.stateIdleTtlMs: 1800000
runtime.mcpDiscoveryTimeoutMs: 10000
Per slot: each CLI launch's exit code, signal, forced stop and SIGKILL escalation, then whether its owned processes were reaped; each owned bridge's stop receipt and a /health summary. The full /health record stays in slots.jsonl.
claude-opus-5.5 V01: seconds 25.7
  CLI 1: PID 21809; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; remaining PIDs unknown)
  CLI 2: PID 21910; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; helper gone yes; remaining PIDs none)
  bridge 1 /health: ok yes; instance verify-claude-opus-5.5-57446-10328302e4f3; models 23; timeouts match recorded runtime yes; PID 21804; port 57446; full record slots.jsonl bridges[0].health; log slots/claude-opus-5.5__V01/bridge.log
  bridge stop 1: PID 21804; group gone yes; port released yes; exit code 0; signal none
claude-opus-5.5 V02: seconds 24.8
  CLI 1: PID 22140; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; remaining PIDs unknown)
  bridge 1 /health: ok yes; instance verify-claude-opus-5.5-57481-21c8645a6251; models 23; timeouts match recorded runtime yes; PID 22137; port 57481; full record slots.jsonl bridges[0].health; log slots/claude-opus-5.5__V02/bridge.log
  bridge stop 1: PID 22137; group gone yes; port released yes; exit code 0; signal none
claude-opus-5.5 V03: seconds 24.5
  CLI 1: PID 22296; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; helper gone yes; remaining PIDs none)
  bridge 1 /health: ok yes; instance verify-claude-opus-5.5-57540-7aa10ea60457; models 23; timeouts match recorded runtime yes; PID 22281; port 57540; full record slots.jsonl bridges[0].health; log slots/claude-opus-5.5__V03/bridge.log
  bridge stop 1: PID 22281; group gone yes; port released yes; exit code 0; signal none
claude-opus-5.5 V04: seconds 20.7
  CLI 1: PID 22523; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; helper gone yes; remaining PIDs none)
  bridge 1 /health: ok yes; instance verify-gpt-6-astra-57571-fc957546c704; models 23; timeouts match recorded runtime yes; PID 22508; port 57571; full record slots.jsonl bridges[0].health; log slots/claude-opus-5.5__V04/bridge.log
  bridge stop 1: PID 22508; group gone yes; port released yes; exit code 0; signal none
claude-opus-5.5 V05: seconds 18.9
  CLI 1: PID 22767; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; helper gone yes; remaining PIDs none)
  bridge 1 /health: ok yes; instance verify-claude-opus-5.5-57596-9e997bd3075f; models 23; timeouts match recorded runtime yes; PID 22752; port 57596; full record slots.jsonl bridges[0].health; log slots/claude-opus-5.5__V05/bridge.log
  bridge stop 1: PID 22752; group gone yes; port released yes; exit code 0; signal none
claude-opus-5.5 V06: seconds 43.2
  CLI 1: PID 22968; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; helper gone yes; remaining PIDs none)
  CLI 2: PID 23275; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; helper gone yes; remaining PIDs none)
  bridge 1 /health: ok yes; instance verify-claude-opus-5.5-57620-978813c701d0; models 23; timeouts match recorded runtime yes; PID 22953; port 57620; full record slots.jsonl bridges[0].health; log slots/claude-opus-5.5__V06/bridge.log
  bridge 2 /health: ok yes; instance verify-claude-opus-5.5-57650-2cdb7dccfb28; models 23; timeouts match recorded runtime yes; PID 23260; port 57650; full record slots.jsonl bridges[1].health; log slots/claude-opus-5.5__V06/bridge-2.log
  bridge stop 1: PID 22953; group gone yes; port released yes; exit code 0; signal none
  bridge stop 2: PID 23260; group gone yes; port released yes; exit code 0; signal none
claude-sonnet-5 V01: seconds 23.7
  CLI 1: PID 23403; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; remaining PIDs unknown)
  CLI 2: PID 23505; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; helper gone yes; remaining PIDs none)
  bridge 1 /health: ok yes; instance verify-claude-sonnet-5-57671-8c1fd3783ddb; models 23; timeouts match recorded runtime yes; PID 23400; port 57671; full record slots.jsonl bridges[0].health; log slots/claude-sonnet-5__V01/bridge.log
  bridge stop 1: PID 23400; group gone yes; port released yes; exit code 0; signal none
claude-sonnet-5 V02: seconds 19.7
  CLI 1: PID 23735; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; remaining PIDs unknown)
  bridge 1 /health: ok yes; instance verify-claude-sonnet-5-57697-cdc7c6d71397; models 23; timeouts match recorded runtime yes; PID 23732; port 57697; full record slots.jsonl bridges[0].health; log slots/claude-sonnet-5__V02/bridge.log
  bridge stop 1: PID 23732; group gone yes; port released yes; exit code 0; signal none
claude-sonnet-5 V03: seconds 20.9
  CLI 1: PID 23879; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; helper gone yes; remaining PIDs none)
  bridge 1 /health: ok yes; instance verify-claude-sonnet-5-57722-b95773a85751; models 23; timeouts match recorded runtime yes; PID 23864; port 57722; full record slots.jsonl bridges[0].health; log slots/claude-sonnet-5__V03/bridge.log
  bridge stop 1: PID 23864; group gone yes; port released yes; exit code none; signal SIGKILL
claude-sonnet-5 V04: seconds 20.8
  CLI 1: PID 24072; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; helper gone yes; remaining PIDs none)
  bridge 1 /health: ok yes; instance verify-gpt-6-astra-57751-b429e4c35289; models 23; timeouts match recorded runtime yes; PID 24057; port 57751; full record slots.jsonl bridges[0].health; log slots/claude-sonnet-5__V04/bridge.log
  bridge stop 1: PID 24057; group gone yes; port released yes; exit code none; signal SIGKILL
claude-sonnet-5 V05: seconds 19.8
  CLI 1: PID 24339; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; helper gone yes; remaining PIDs none)
  bridge 1 /health: ok yes; instance verify-claude-sonnet-5-57774-a135e23db32b; models 23; timeouts match recorded runtime yes; PID 24324; port 57774; full record slots.jsonl bridges[0].health; log slots/claude-sonnet-5__V05/bridge.log
  bridge stop 1: PID 24324; group gone yes; port released yes; exit code 0; signal none
claude-sonnet-5 V06: seconds 44.7
  CLI 1: PID 24544; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; helper gone yes; remaining PIDs none)
  CLI 2: PID 24902; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; helper gone yes; remaining PIDs none)
  bridge 1 /health: ok yes; instance verify-claude-sonnet-5-57803-292c4d7b7f50; models 23; timeouts match recorded runtime yes; PID 24512; port 57803; full record slots.jsonl bridges[0].health; log slots/claude-sonnet-5__V06/bridge.log
  bridge 2 /health: ok yes; instance verify-claude-sonnet-5-57847-7f0f6cb59ef4; models 23; timeouts match recorded runtime yes; PID 24886; port 57847; full record slots.jsonl bridges[1].health; log slots/claude-sonnet-5__V06/bridge-2.log
  bridge stop 1: PID 24512; group gone yes; port released yes; exit code 0; signal none
  bridge stop 2: PID 24886; group gone yes; port released yes; exit code 0; signal none
claude-haiku-4.5 V01: seconds 25.4
  CLI 1: PID 25040; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; remaining PIDs unknown)
  CLI 2: PID 25142; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; helper gone yes; remaining PIDs none)
  bridge 1 /health: ok yes; instance verify-claude-haiku-4.5-57870-1133d86f756e; models 23; timeouts match recorded runtime yes; PID 25035; port 57870; full record slots.jsonl bridges[0].health; log slots/claude-haiku-4.5__V01/bridge.log
  bridge stop 1: PID 25035; group gone yes; port released yes; exit code 0; signal none
claude-haiku-4.5 V02: seconds 19.8
  CLI 1: PID 25374; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; remaining PIDs unknown)
  bridge 1 /health: ok yes; instance verify-claude-haiku-4.5-57898-b8769dbf56e2; models 23; timeouts match recorded runtime yes; PID 25370; port 57898; full record slots.jsonl bridges[0].health; log slots/claude-haiku-4.5__V02/bridge.log
  bridge stop 1: PID 25370; group gone yes; port released yes; exit code 0; signal none
claude-haiku-4.5 V03: seconds 21.3
  CLI 1: PID 25521; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; helper gone yes; remaining PIDs none)
  bridge 1 /health: ok yes; instance verify-claude-haiku-4.5-57922-2281da602616; models 23; timeouts match recorded runtime yes; PID 25503; port 57922; full record slots.jsonl bridges[0].health; log slots/claude-haiku-4.5__V03/bridge.log
  bridge stop 1: PID 25503; group gone yes; port released yes; exit code 0; signal none
claude-haiku-4.5 V04: seconds 23.6
  CLI 1: PID 25748; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; helper gone yes; remaining PIDs none)
  bridge 1 /health: ok yes; instance verify-gpt-6-astra-57947-7bdba49069f4; models 23; timeouts match recorded runtime yes; PID 25716; port 57947; full record slots.jsonl bridges[0].health; log slots/claude-haiku-4.5__V04/bridge.log
  bridge stop 1: PID 25716; group gone yes; port released yes; exit code 0; signal none
claude-haiku-4.5 V05: seconds 18.9
  CLI 1: PID 25998; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; helper gone yes; remaining PIDs none)
  bridge 1 /health: ok yes; instance verify-claude-haiku-4.5-57971-55fd5b6375be; models 23; timeouts match recorded runtime yes; PID 25982; port 57971; full record slots.jsonl bridges[0].health; log slots/claude-haiku-4.5__V05/bridge.log
  bridge stop 1: PID 25982; group gone yes; port released yes; exit code 0; signal none
claude-haiku-4.5 V06: seconds 44.2
  CLI 1: PID 26210; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; helper gone yes; remaining PIDs none)
  CLI 2: PID 26523; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; helper gone yes; remaining PIDs none)
  bridge 1 /health: ok yes; instance verify-claude-haiku-4.5-57995-ea9c3d902c69; models 23; timeouts match recorded runtime yes; PID 26195; port 57995; full record slots.jsonl bridges[0].health; log slots/claude-haiku-4.5__V06/bridge.log
  bridge 2 /health: ok yes; instance verify-claude-haiku-4.5-58018-7e24adfe0ff7; models 23; timeouts match recorded runtime yes; PID 26508; port 58018; full record slots.jsonl bridges[1].health; log slots/claude-haiku-4.5__V06/bridge-2.log
  bridge stop 1: PID 26195; group gone yes; port released yes; exit code 0; signal none
  bridge stop 2: PID 26508; group gone yes; port released yes; exit code 0; signal none
gpt-6-astra V01: seconds 28.6
  CLI 1: PID 26651; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; remaining PIDs unknown)
  CLI 2: PID 26753; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; helper gone yes; remaining PIDs none)
  bridge 1 /health: ok yes; instance verify-gpt-6-astra-58039-62908fd6fd05; models 23; timeouts match recorded runtime yes; PID 26648; port 58039; full record slots.jsonl bridges[0].health; log slots/gpt-6-astra__V01/bridge.log
  bridge stop 1: PID 26648; group gone yes; port released yes; exit code none; signal SIGKILL
gpt-6-astra V02: seconds 28.3
  CLI 1: PID 27007; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; remaining PIDs unknown)
  bridge 1 /health: ok yes; instance verify-gpt-6-astra-58068-89ee1a53a9c7; models 23; timeouts match recorded runtime yes; PID 26993; port 58068; full record slots.jsonl bridges[0].health; log slots/gpt-6-astra__V02/bridge.log
  bridge stop 1: PID 26993; group gone yes; port released yes; exit code 0; signal none
gpt-6-astra V03: seconds 23.8
  CLI 1: PID 27145; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; helper gone yes; remaining PIDs none)
  bridge 1 /health: ok yes; instance verify-gpt-6-astra-58094-00da2c34004a; models 23; timeouts match recorded runtime yes; PID 27129; port 58094; full record slots.jsonl bridges[0].health; log slots/gpt-6-astra__V03/bridge.log
  bridge stop 1: PID 27129; group gone yes; port released yes; exit code 0; signal none
gpt-6-astra V04: seconds 20.6
  CLI 1: PID 27364; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; helper gone yes; remaining PIDs none)
  bridge 1 /health: ok yes; instance verify-gpt-6-luna-58125-d8c0bb814136; models 23; timeouts match recorded runtime yes; PID 27349; port 58125; full record slots.jsonl bridges[0].health; log slots/gpt-6-astra__V04/bridge.log
  bridge stop 1: PID 27349; group gone yes; port released yes; exit code 0; signal none
gpt-6-astra V05: seconds 20.4
  CLI 1: PID 27620; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; helper gone yes; remaining PIDs none)
  bridge 1 /health: ok yes; instance verify-gpt-6-astra-58146-377cd32d3100; models 23; timeouts match recorded runtime yes; PID 27605; port 58146; full record slots.jsonl bridges[0].health; log slots/gpt-6-astra__V05/bridge.log
  bridge stop 1: PID 27605; group gone yes; port released yes; exit code 0; signal none
gpt-6-astra V06: seconds 73.6
  CLI 1: PID 27847; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; helper gone yes; remaining PIDs none)
  CLI 2: PID 28312; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; helper gone yes; remaining PIDs none)
  bridge 1 /health: ok yes; instance verify-gpt-6-astra-58172-78d57236da04; models 23; timeouts match recorded runtime yes; PID 27831; port 58172; full record slots.jsonl bridges[0].health; log slots/gpt-6-astra__V06/bridge.log
  bridge 2 /health: ok yes; instance verify-gpt-6-astra-58208-b25533d4f3b1; models 23; timeouts match recorded runtime yes; PID 28297; port 58208; full record slots.jsonl bridges[1].health; log slots/gpt-6-astra__V06/bridge-2.log
  bridge stop 1: PID 27831; group gone yes; port released yes; exit code 0; signal none
  bridge stop 2: PID 28297; group gone yes; port released yes; exit code 0; signal none
gpt-6-sol V01: seconds 26.0
  CLI 1: PID 28446; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; remaining PIDs unknown)
  CLI 2: PID 28551; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; helper gone yes; remaining PIDs none)
  bridge 1 /health: ok yes; instance verify-gpt-6-sol-58230-73a8d548d566; models 23; timeouts match recorded runtime yes; PID 28441; port 58230; full record slots.jsonl bridges[0].health; log slots/gpt-6-sol__V01/bridge.log
  bridge stop 1: PID 28441; group gone yes; port released yes; exit code none; signal SIGKILL
gpt-6-sol V02: seconds 25.6
  CLI 1: PID 28783; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; remaining PIDs unknown)
  bridge 1 /health: ok yes; instance verify-gpt-6-sol-58259-259feef9b440; models 23; timeouts match recorded runtime yes; PID 28780; port 58259; full record slots.jsonl bridges[0].health; log slots/gpt-6-sol__V02/bridge.log
  bridge stop 1: PID 28780; group gone yes; port released yes; exit code 0; signal none
gpt-6-sol V03: seconds 20.6
  CLI 1: PID 28935; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; helper gone yes; remaining PIDs none)
  bridge 1 /health: ok yes; instance verify-gpt-6-sol-58282-844fdfc100c8; models 23; timeouts match recorded runtime yes; PID 28907; port 58282; full record slots.jsonl bridges[0].health; log slots/gpt-6-sol__V03/bridge.log
  bridge stop 1: PID 28907; group gone yes; port released yes; exit code 0; signal none
gpt-6-sol V04: seconds 21.9
  CLI 1: PID 29129; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; helper gone yes; remaining PIDs none)
  bridge 1 /health: ok yes; instance verify-gpt-6-astra-58303-ef64a367b038; models 23; timeouts match recorded runtime yes; PID 29114; port 58303; full record slots.jsonl bridges[0].health; log slots/gpt-6-sol__V04/bridge.log
  bridge stop 1: PID 29114; group gone yes; port released yes; exit code 0; signal none
gpt-6-sol V05: seconds 19.6
  CLI 1: PID 29387; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; helper gone yes; remaining PIDs none)
  bridge 1 /health: ok yes; instance verify-gpt-6-sol-58325-68410b6565d2; models 23; timeouts match recorded runtime yes; PID 29372; port 58325; full record slots.jsonl bridges[0].health; log slots/gpt-6-sol__V05/bridge.log
  bridge stop 1: PID 29372; group gone yes; port released yes; exit code 0; signal none
gpt-6-sol V06: seconds 55.7
  CLI 1: PID 29583; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; helper gone yes; remaining PIDs none)
  CLI 2: PID 29952; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; helper gone yes; remaining PIDs none)
  bridge 1 /health: ok yes; instance verify-gpt-6-sol-58353-1232909abca9; models 23; timeouts match recorded runtime yes; PID 29568; port 58353; full record slots.jsonl bridges[0].health; log slots/gpt-6-sol__V06/bridge.log
  bridge 2 /health: ok yes; instance verify-gpt-6-sol-58383-b0c303447bdd; models 23; timeouts match recorded runtime yes; PID 29937; port 58383; full record slots.jsonl bridges[1].health; log slots/gpt-6-sol__V06/bridge-2.log
  bridge stop 1: PID 29568; group gone yes; port released yes; exit code 0; signal none
  bridge stop 2: PID 29937; group gone yes; port released yes; exit code none; signal SIGKILL
gpt-6-luna V01: seconds 23.6
  CLI 1: PID 30094; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; remaining PIDs unknown)
  CLI 2: PID 30204; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; helper gone yes; remaining PIDs none)
  bridge 1 /health: ok yes; instance verify-gpt-6-luna-58401-b3dce0988bf0; models 23; timeouts match recorded runtime yes; PID 30091; port 58401; full record slots.jsonl bridges[0].health; log slots/gpt-6-luna__V01/bridge.log
  bridge stop 1: PID 30091; group gone yes; port released yes; exit code 0; signal none
gpt-6-luna V02: seconds 19.6
  CLI 1: PID 30430; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; remaining PIDs unknown)
  bridge 1 /health: ok yes; instance verify-gpt-6-luna-58435-982aa7375607; models 23; timeouts match recorded runtime yes; PID 30427; port 58435; full record slots.jsonl bridges[0].health; log slots/gpt-6-luna__V02/bridge.log
  bridge stop 1: PID 30427; group gone yes; port released yes; exit code 0; signal none
gpt-6-luna V03: seconds 20.5
  CLI 1: PID 30552; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; helper gone yes; remaining PIDs none)
  bridge 1 /health: ok yes; instance verify-gpt-6-luna-58460-3c127a774746; models 23; timeouts match recorded runtime yes; PID 30537; port 58460; full record slots.jsonl bridges[0].health; log slots/gpt-6-luna__V03/bridge.log
  bridge stop 1: PID 30537; group gone yes; port released yes; exit code 0; signal none
gpt-6-luna V04: seconds 22.2
  CLI 1: PID 30758; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; helper gone yes; remaining PIDs none)
  bridge 1 /health: ok yes; instance verify-gpt-6-astra-58484-3657cb3a638e; models 23; timeouts match recorded runtime yes; PID 30742; port 58484; full record slots.jsonl bridges[0].health; log slots/gpt-6-luna__V04/bridge.log
  bridge stop 1: PID 30742; group gone yes; port released yes; exit code 0; signal none
gpt-6-luna V05: seconds 20.9
  CLI 1: PID 31050; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; helper gone yes; remaining PIDs none)
  bridge 1 /health: ok yes; instance verify-gpt-6-luna-58562-cb16ab2850e8; models 23; timeouts match recorded runtime yes; PID 31035; port 58562; full record slots.jsonl bridges[0].health; log slots/gpt-6-luna__V05/bridge.log
  bridge stop 1: PID 31035; group gone yes; port released yes; exit code none; signal SIGKILL
gpt-6-luna V06: seconds 44.3
  CLI 1: PID 31252; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; helper gone yes; remaining PIDs none)
  CLI 2: PID 31567; exit code 0; signal none; forced no; escalated to SIGKILL no; reaped yes (group gone yes; helper gone yes; remaining PIDs none)
  bridge 1 /health: ok yes; instance verify-gpt-6-luna-58600-06407f29d94e; models 23; timeouts match recorded runtime yes; PID 31237; port 58600; full record slots.jsonl bridges[0].health; log slots/gpt-6-luna__V06/bridge.log
  bridge 2 /health: ok yes; instance verify-gpt-6-luna-58629-3b9c24c16ff0; models 23; timeouts match recorded runtime yes; PID 31552; port 58629; full record slots.jsonl bridges[1].health; log slots/gpt-6-luna__V06/bridge-2.log
  bridge stop 1: PID 31237; group gone yes; port released yes; exit code 0; signal none
  bridge stop 2: PID 31552; group gone yes; port released yes; exit code 0; signal none
Slot budgets are total deadlines, not renewed for each phase. Runtime budgets are recorded without scaling. No metadata is filled from current dependencies, environment or installed binary.

## Evidence and reproduction

Run from the repository root. Reading this explicit saved run makes no model calls. The reporter re-evaluates each saved PASS slot's stored raw evidence with the current checkout's evaluator and never upgrades a saved failure. Frozen source copies (sources/files/) are reproduction material: the reporter checks their hashes and never executes them.
```bash
node scripts/verify/report.mjs '.verify-runs/2026-09-25T09-55-54-058Z-9bdbc340'
```
```bash
npm run verify:doc -- '.verify-runs/2026-09-25T09-55-54-058Z-9bdbc340'
```
Source copies exclude credentials/config and old run evidence. Private settings contain ephemeral bridge keys; raw transcripts may be sensitive. Inspect before sharing raw artifacts.
Paths inside the run directory are shown relative to it. In this document ~ and $HOME are the home directory, $TMPDIR is the per-user temporary directory, and -HOME / -TMPDIR stand for them inside Claude project-directory names.
- claude-opus-5.5 V01 print: transcript slots/claude-opus-5.5__V01/transcript-print.jsonl; response IDs msg_d10c0c10616a4dc5a203769781481d24; log range slots/claude-opus-5.5__V01/bridge.log bytes 159-2586
- claude-opus-5.5 V01 unicode: transcript slots/claude-opus-5.5__V01/home/.claude/projects/-TMPDIR-verify-essential-r54TVL-workspace/82d07bf1-7bea-4b24-8dc8-1000fdf12b67.jsonl; response IDs msg_e430d28d5ee445e383e737ec6b3fbd25; log range slots/claude-opus-5.5__V01/bridge.log bytes 2586-5283
- claude-opus-5.5 V01 clear: transcript slots/claude-opus-5.5__V01/home/.claude/projects/-TMPDIR-verify-essential-r54TVL-workspace/e1bafa46-6c23-42fc-b4a3-52daea54ef72.jsonl; response IDs msg_b90a648a40824acf84ca4ffc86bb3fc3; log range slots/claude-opus-5.5__V01/bridge.log bytes 5283-8114
- claude-opus-5.5 V02 coding: transcript slots/claude-opus-5.5__V02/transcript-coding.jsonl; response IDs msg_2f4f4c4743264e4f8e4b3e5a91fa0133, msg_96bb2bb16fa24104b6722acbed9c7650, msg_d5592624186d4be69644b5b1e6f33e2a, msg_bd0018af38204b038a4b10a9fbf1a79f, msg_e74b4887b9b64af285a523f847e0bdb1; log range slots/claude-opus-5.5__V02/bridge.log bytes 159-16107
- claude-opus-5.5 V03 lookup: transcript slots/claude-opus-5.5__V03/home/.claude/projects/-TMPDIR-verify-essential-AefuDm-workspace/6b8b4656-72c9-495b-8b63-f8d3b4c09765.jsonl; response IDs msg_4e5074af6c894d9dbe75a2219852aace, msg_9dd81fc87d694b5b8ec583cf6bcb50cb, msg_ee767bcf95da4b61ad34e8d2d37437d5; log range slots/claude-opus-5.5__V03/bridge.log bytes 159-8301
- claude-opus-5.5 V03 recall: transcript slots/claude-opus-5.5__V03/home/.claude/projects/-TMPDIR-verify-essential-AefuDm-workspace/6b8b4656-72c9-495b-8b63-f8d3b4c09765.jsonl; response IDs msg_08ff956ed98943f88b5a9312063dc1d4; log range slots/claude-opus-5.5__V03/bridge.log bytes 8301-12252
- claude-opus-5.5 V04 source: transcript slots/claude-opus-5.5__V04/home/.claude/projects/-TMPDIR-verify-essential-k8C50K-workspace/dd81ba5a-c1f7-4adc-b321-07fcdbf79e66.jsonl; response IDs msg_f039c1d0de5d48c4b98fed0d9de40e3a; log range slots/claude-opus-5.5__V04/bridge.log bytes 155-2592
- claude-opus-5.5 V04 target: transcript slots/claude-opus-5.5__V04/home/.claude/projects/-TMPDIR-verify-essential-k8C50K-workspace/dd81ba5a-c1f7-4adc-b321-07fcdbf79e66.jsonl; response IDs msg_093b984884d64ee2806c690c66433d0a; log range slots/claude-opus-5.5__V04/bridge.log bytes 2592-6501
- claude-opus-5.5 V05 interrupt: transcript slots/claude-opus-5.5__V05/home/.claude/projects/-TMPDIR-verify-essential-ANT3Kr-workspace/5e720bd1-6b2e-49cb-a14a-f49fe56d575d.jsonl; response IDs msg_2a8fca228eec414ea42411a2fa572abb; log range unknown
- claude-opus-5.5 V05 recovery: transcript slots/claude-opus-5.5__V05/home/.claude/projects/-TMPDIR-verify-essential-ANT3Kr-workspace/5e720bd1-6b2e-49cb-a14a-f49fe56d575d.jsonl; response IDs msg_dd70741cda074242b128917630d23fe0; log range slots/claude-opus-5.5__V05/bridge.log bytes 5227-8255
- claude-opus-5.5 V06 seed: transcript slots/claude-opus-5.5__V06/home/.claude/projects/-TMPDIR-verify-essential-fCg0M4-workspace/a15d7df1-3e5a-492b-a79c-3774796759e5.jsonl; response IDs msg_37fd28b25cb34254af1bda8aee710d76; log range slots/claude-opus-5.5__V06/bridge.log bytes 159-2588
- claude-opus-5.5 V06 compact: transcript slots/claude-opus-5.5__V06/home/.claude/projects/-TMPDIR-verify-essential-fCg0M4-workspace/a15d7df1-3e5a-492b-a79c-3774796759e5.jsonl; response IDs msg_884e2c2067334211a76175715f08a001; log range slots/claude-opus-5.5__V06/bridge.log bytes 2588-5306
- claude-opus-5.5 V06 recall: transcript slots/claude-opus-5.5__V06/home/.claude/projects/-TMPDIR-verify-essential-fCg0M4-workspace/a15d7df1-3e5a-492b-a79c-3774796759e5.jsonl; response IDs msg_9d35d2b7d15c4d8a952df585ccda4440; log range slots/claude-opus-5.5__V06/bridge.log bytes 5306-8378
- claude-opus-5.5 V06 resume: transcript slots/claude-opus-5.5__V06/home/.claude/projects/-TMPDIR-verify-essential-fCg0M4-workspace/a15d7df1-3e5a-492b-a79c-3774796759e5.jsonl; response IDs msg_697d88634d074ccd859503e0f94c5d35; log range slots/claude-opus-5.5__V06/bridge-2.log bytes 159-3720
- claude-sonnet-5 V01 print: transcript slots/claude-sonnet-5__V01/transcript-print.jsonl; response IDs msg_992619fee38f491d8493be6335dfeb25; log range slots/claude-sonnet-5__V01/bridge.log bytes 159-2577
- claude-sonnet-5 V01 unicode: transcript slots/claude-sonnet-5__V01/home/.claude/projects/-TMPDIR-verify-essential-jKsLWA-workspace/519fa3d1-2e97-4666-9c7d-5978ba9e5c48.jsonl; response IDs msg_c2c8555159c64c68b2ce33a539873b33; log range slots/claude-sonnet-5__V01/bridge.log bytes 2577-5265
- claude-sonnet-5 V01 clear: transcript slots/claude-sonnet-5__V01/home/.claude/projects/-TMPDIR-verify-essential-jKsLWA-workspace/7aaf4dcd-401b-43fb-9f9f-eae20f3ad45f.jsonl; response IDs msg_8b44582632344bf1bfd3d38176955a48; log range slots/claude-sonnet-5__V01/bridge.log bytes 5265-8087
- claude-sonnet-5 V02 coding: transcript slots/claude-sonnet-5__V02/transcript-coding.jsonl; response IDs msg_efc0ef64815e4fd9ae84c541bb321260, msg_5649800020cf47b2abfa3e749321ce1b, msg_67141d8e374644b189cf90a4b440995d, msg_9ea045e55a9d4c34aff765f81f8bc74b, msg_de8ea3375cea4fba95cff683c0ee4308; log range slots/claude-sonnet-5__V02/bridge.log bytes 159-16068
- claude-sonnet-5 V03 lookup: transcript slots/claude-sonnet-5__V03/home/.claude/projects/-TMPDIR-verify-essential-EOa7m6-workspace/43f11334-0e48-4ea8-b466-138a56e1172a.jsonl; response IDs msg_037dbced5d4b4dc49a44fa61e8f23f9a, msg_86ae07a8259a4717b8b55f97f7dbcc38, msg_3ea6f444cb534f5c9d0445eebc2031fd; log range slots/claude-sonnet-5__V03/bridge.log bytes 159-8276
- claude-sonnet-5 V03 recall: transcript slots/claude-sonnet-5__V03/home/.claude/projects/-TMPDIR-verify-essential-EOa7m6-workspace/43f11334-0e48-4ea8-b466-138a56e1172a.jsonl; response IDs msg_ac56283fcd824ed397cbb6ccb64ebcef; log range slots/claude-sonnet-5__V03/bridge.log bytes 8276-12219
- claude-sonnet-5 V04 source: transcript slots/claude-sonnet-5__V04/home/.claude/projects/-TMPDIR-verify-essential-PRXM4g-workspace/a485e563-8e62-49bd-ae26-432213ce4da2.jsonl; response IDs msg_bbd517d2857d4f9a98c58806a63abc9a; log range slots/claude-sonnet-5__V04/bridge.log bytes 155-2592
- claude-sonnet-5 V04 target: transcript slots/claude-sonnet-5__V04/home/.claude/projects/-TMPDIR-verify-essential-PRXM4g-workspace/a485e563-8e62-49bd-ae26-432213ce4da2.jsonl; response IDs msg_e294a46ca95841848c6848cd453170f2; log range slots/claude-sonnet-5__V04/bridge.log bytes 2592-6500
- claude-sonnet-5 V05 interrupt: transcript slots/claude-sonnet-5__V05/home/.claude/projects/-TMPDIR-verify-essential-uzcDK3-workspace/b50abd9d-9928-439a-a067-24791ec2cbd2.jsonl; response IDs msg_88c94c1d8fb243ed9e1c27d22777081f; log range unknown
- claude-sonnet-5 V05 recovery: transcript slots/claude-sonnet-5__V05/home/.claude/projects/-TMPDIR-verify-essential-uzcDK3-workspace/b50abd9d-9928-439a-a067-24791ec2cbd2.jsonl; response IDs msg_442304e7a79b4c1f971e6c30ec70adb0; log range slots/claude-sonnet-5__V05/bridge.log bytes 5324-8344
- claude-sonnet-5 V06 seed: transcript slots/claude-sonnet-5__V06/home/.claude/projects/-TMPDIR-verify-essential-Wgi0m0-workspace/1098b4a9-4a7e-42a4-8ecc-5f0cef7dc479.jsonl; response IDs msg_a1ff87dc1e5945f9b4a23284ade68014; log range slots/claude-sonnet-5__V06/bridge.log bytes 159-2579
- claude-sonnet-5 V06 compact: transcript slots/claude-sonnet-5__V06/home/.claude/projects/-TMPDIR-verify-essential-Wgi0m0-workspace/1098b4a9-4a7e-42a4-8ecc-5f0cef7dc479.jsonl; response IDs msg_5f9cb8a7f6614142ae7f69316aaa46f3; log range slots/claude-sonnet-5__V06/bridge.log bytes 2579-5290
- claude-sonnet-5 V06 recall: transcript slots/claude-sonnet-5__V06/home/.claude/projects/-TMPDIR-verify-essential-Wgi0m0-workspace/1098b4a9-4a7e-42a4-8ecc-5f0cef7dc479.jsonl; response IDs msg_5baae364aa494e49b045b9fa92c84b78; log range slots/claude-sonnet-5__V06/bridge.log bytes 5290-8353
- claude-sonnet-5 V06 resume: transcript slots/claude-sonnet-5__V06/home/.claude/projects/-TMPDIR-verify-essential-Wgi0m0-workspace/1098b4a9-4a7e-42a4-8ecc-5f0cef7dc479.jsonl; response IDs msg_b5e8ae25a4b14257860ed8c06e12a58f; log range slots/claude-sonnet-5__V06/bridge-2.log bytes 159-3711
- claude-haiku-4.5 V01 print: transcript slots/claude-haiku-4.5__V01/transcript-print.jsonl; response IDs msg_f77550884493484b9c855f776f104d27; log range slots/claude-haiku-4.5__V01/bridge.log bytes 160-2468
- claude-haiku-4.5 V01 unicode: transcript slots/claude-haiku-4.5__V01/home/.claude/projects/-TMPDIR-verify-essential-387mNz-workspace/0289ed62-2b93-4197-8f7f-6e14e0b2b468.jsonl; response IDs msg_878af0943a534e40a65c3b0aa5796c89; log range slots/claude-haiku-4.5__V01/bridge.log bytes 2468-5449
- claude-haiku-4.5 V01 clear: transcript slots/claude-haiku-4.5__V01/home/.claude/projects/-TMPDIR-verify-essential-387mNz-workspace/3b5ee945-4c8e-48f2-849f-5eaf49c27dd5.jsonl; response IDs msg_4658f025a0c242b6a751863abf926740; log range slots/claude-haiku-4.5__V01/bridge.log bytes 5449-8564
- claude-haiku-4.5 V02 coding: transcript slots/claude-haiku-4.5__V02/transcript-coding.jsonl; response IDs msg_127df7d7739f46d4bb6df360b787f0bd, msg_69ee9d74502541d3b255c28a2b96c0cc, msg_f2ddce1d34fa45da9abf467ebb8b99c8, msg_f98fa43189874488af4acf0d8bb47dcb, msg_5fcc4bec12bd4f14a410d6cc4d2907f0; log range slots/claude-haiku-4.5__V02/bridge.log bytes 160-16627
- claude-haiku-4.5 V03 lookup: transcript slots/claude-haiku-4.5__V03/home/.claude/projects/-TMPDIR-verify-essential-va3cow-workspace/973ec778-e744-453b-9823-02e7585b0fcd.jsonl; response IDs msg_ee89b3bfcad84f3ebf74bbcb1109aec2, msg_587c722b58224925876ef9ece6367471, msg_31800ff1b37a4426bb6bcf29b450c136; log range slots/claude-haiku-4.5__V03/bridge.log bytes 160-9000
- claude-haiku-4.5 V03 recall: transcript slots/claude-haiku-4.5__V03/home/.claude/projects/-TMPDIR-verify-essential-va3cow-workspace/973ec778-e744-453b-9823-02e7585b0fcd.jsonl; response IDs msg_12e54e7637524fe0a50382e887ac6e08; log range slots/claude-haiku-4.5__V03/bridge.log bytes 9000-12978
- claude-haiku-4.5 V04 source: transcript slots/claude-haiku-4.5__V04/home/.claude/projects/-TMPDIR-verify-essential-PKEPbF-workspace/d7e66cd9-901e-42e7-92d5-48f419c0a36f.jsonl; response IDs msg_5236d6d0f8244b52b7d3476b04b7786b; log range slots/claude-haiku-4.5__V04/bridge.log bytes 155-2592
- claude-haiku-4.5 V04 target: transcript slots/claude-haiku-4.5__V04/home/.claude/projects/-TMPDIR-verify-essential-PKEPbF-workspace/d7e66cd9-901e-42e7-92d5-48f419c0a36f.jsonl; response IDs msg_9c91ee3995f54e919ad627e378083ed2; log range slots/claude-haiku-4.5__V04/bridge.log bytes 2592-6483
- claude-haiku-4.5 V05 interrupt: transcript slots/claude-haiku-4.5__V05/home/.claude/projects/-TMPDIR-verify-essential-gBfgs6-workspace/0a59b78f-7861-45ea-bc93-064a422804e3.jsonl; response IDs msg_722b4eda844e48ac9b9e32feb843797c; log range unknown
- claude-haiku-4.5 V05 recovery: transcript slots/claude-haiku-4.5__V05/home/.claude/projects/-TMPDIR-verify-essential-gBfgs6-workspace/0a59b78f-7861-45ea-bc93-064a422804e3.jsonl; response IDs msg_e6d117226e52454fbb5f6984d0e4b002; log range slots/claude-haiku-4.5__V05/bridge.log bytes 5616-8890
- claude-haiku-4.5 V06 seed: transcript slots/claude-haiku-4.5__V06/home/.claude/projects/-TMPDIR-verify-essential-bhD6BL-workspace/9e97264f-cd0d-4a79-a193-6a9aa44ddd62.jsonl; response IDs msg_1eb468e6d6db43f185fb4a22edfa529e; log range slots/claude-haiku-4.5__V06/bridge.log bytes 160-2873
- claude-haiku-4.5 V06 compact: transcript slots/claude-haiku-4.5__V06/home/.claude/projects/-TMPDIR-verify-essential-bhD6BL-workspace/9e97264f-cd0d-4a79-a193-6a9aa44ddd62.jsonl; response IDs msg_439876c9249b425e94c7d722bff7ffb1; log range slots/claude-haiku-4.5__V06/bridge.log bytes 2873-5879
- claude-haiku-4.5 V06 recall: transcript slots/claude-haiku-4.5__V06/home/.claude/projects/-TMPDIR-verify-essential-bhD6BL-workspace/9e97264f-cd0d-4a79-a193-6a9aa44ddd62.jsonl; response IDs msg_642b986f1eb940e883f08d40b82e6b72; log range slots/claude-haiku-4.5__V06/bridge.log bytes 5879-9235
- claude-haiku-4.5 V06 resume: transcript slots/claude-haiku-4.5__V06/home/.claude/projects/-TMPDIR-verify-essential-bhD6BL-workspace/9e97264f-cd0d-4a79-a193-6a9aa44ddd62.jsonl; response IDs msg_bd0efc85315a4c6480661476306b18ce; log range slots/claude-haiku-4.5__V06/bridge-2.log bytes 160-3963
- gpt-6-astra V01 print: transcript slots/gpt-6-astra__V01/transcript-print.jsonl; response IDs msg_5020d184fe2c40f48000846ae3c55103; log range slots/gpt-6-astra__V01/bridge.log bytes 155-2590
- gpt-6-astra V01 unicode: transcript slots/gpt-6-astra__V01/home/.claude/projects/-TMPDIR-verify-essential-IUV77v-workspace/838dabd3-6e01-4e2c-97f8-cb372324d82a.jsonl; response IDs msg_a046bae8150048afa8e2de64e843f1f5; log range slots/gpt-6-astra__V01/bridge.log bytes 2590-5295
- gpt-6-astra V01 clear: transcript slots/gpt-6-astra__V01/home/.claude/projects/-TMPDIR-verify-essential-IUV77v-workspace/999be008-5aac-40a0-93af-31a4d9e84591.jsonl; response IDs msg_757c905d05894eb89ebce2c47f74e4fb; log range slots/gpt-6-astra__V01/bridge.log bytes 5295-8134
- gpt-6-astra V02 coding: transcript slots/gpt-6-astra__V02/transcript-coding.jsonl; response IDs msg_bc86652e3d8149ac9ff71c84d8c83d13, msg_2eb27cbb74d34ad7ace3df31bd32cdc9, msg_5f615c0babdb4ee5b2c18db93c0d4cdd, msg_bc36a8497d2d4aa9adb08f4b4bbf0889, msg_638e9370bc6c422081c290b5ed5dc8ce, msg_52b4f0f15f81460884acf84ca6dfbc91, msg_c413dac0e2f14df0aae62754a9fbcc06; log range slots/gpt-6-astra__V02/bridge.log bytes 155-23352
- gpt-6-astra V03 lookup: transcript slots/gpt-6-astra__V03/home/.claude/projects/-TMPDIR-verify-essential-m5ii4b-workspace/cc3847b4-112d-4e17-a669-7fc6f6d8655b.jsonl; response IDs msg_d43378763b76489c92fcc2edcfd512ca, msg_6199700037c0405d86068992f47c4c9b, msg_4dc7e2d3915942a4aad9daff36d8c36a; log range slots/gpt-6-astra__V03/bridge.log bytes 155-8323
- gpt-6-astra V03 recall: transcript slots/gpt-6-astra__V03/home/.claude/projects/-TMPDIR-verify-essential-m5ii4b-workspace/cc3847b4-112d-4e17-a669-7fc6f6d8655b.jsonl; response IDs msg_083679121d454c37958f30535ae474ae; log range slots/gpt-6-astra__V03/bridge.log bytes 8323-12282
- gpt-6-astra V04 source: transcript slots/gpt-6-astra__V04/home/.claude/projects/-TMPDIR-verify-essential-K7hbzL-workspace/d93298a1-1c2f-4e3a-8800-2c93b543b3f0.jsonl; response IDs msg_57e78e5c68344152a7da56609a9842f7; log range slots/gpt-6-astra__V04/bridge.log bytes 154-2583
- gpt-6-astra V04 target: transcript slots/gpt-6-astra__V04/home/.claude/projects/-TMPDIR-verify-essential-K7hbzL-workspace/d93298a1-1c2f-4e3a-8800-2c93b543b3f0.jsonl; response IDs msg_34edc99fdb2745aca923bc0026cc6e7b; log range slots/gpt-6-astra__V04/bridge.log bytes 2583-6508
- gpt-6-astra V05 interrupt: transcript slots/gpt-6-astra__V05/home/.claude/projects/-TMPDIR-verify-essential-ULLe12-workspace/3484c4dc-6019-4835-8568-4088be281801.jsonl; response IDs msg_defc1d22ccc34765989dc797886171f4; log range unknown
- gpt-6-astra V05 recovery: transcript slots/gpt-6-astra__V05/home/.claude/projects/-TMPDIR-verify-essential-ULLe12-workspace/3484c4dc-6019-4835-8568-4088be281801.jsonl; response IDs msg_6efae6a378be4b398800d8a281eb78d8; log range slots/gpt-6-astra__V05/bridge.log bytes 5318-8358
- gpt-6-astra V06 seed: transcript slots/gpt-6-astra__V06/home/.claude/projects/-TMPDIR-verify-essential-Bbh0ss-workspace/d523ce45-f28e-404c-b93b-670632503f9b.jsonl; response IDs msg_6606af8fa5ca4018b05f7d77c46341e0; log range slots/gpt-6-astra__V06/bridge.log bytes 155-2592
- gpt-6-astra V06 compact: transcript slots/gpt-6-astra__V06/home/.claude/projects/-TMPDIR-verify-essential-Bbh0ss-workspace/d523ce45-f28e-404c-b93b-670632503f9b.jsonl; response IDs msg_0b45c0bef0d549ee830ed8d4224cb241; log range slots/gpt-6-astra__V06/bridge.log bytes 2592-5323
- gpt-6-astra V06 recall: transcript slots/gpt-6-astra__V06/home/.claude/projects/-TMPDIR-verify-essential-Bbh0ss-workspace/d523ce45-f28e-404c-b93b-670632503f9b.jsonl; response IDs msg_424f68ceed834b3a9b2ad3ae9e0e1258; log range slots/gpt-6-astra__V06/bridge.log bytes 5323-8403
- gpt-6-astra V06 resume: transcript slots/gpt-6-astra__V06/home/.claude/projects/-TMPDIR-verify-essential-Bbh0ss-workspace/d523ce45-f28e-404c-b93b-670632503f9b.jsonl; response IDs msg_0de24965c9e14a8e89449742ce7592ae; log range slots/gpt-6-astra__V06/bridge-2.log bytes 155-3724
- gpt-6-sol V01 print: transcript slots/gpt-6-sol__V01/transcript-print.jsonl; response IDs msg_fb6a7d6ac9714c6e9f2d4af160868a3d; log range slots/gpt-6-sol__V01/bridge.log bytes 153-2573
- gpt-6-sol V01 unicode: transcript slots/gpt-6-sol__V01/home/.claude/projects/-TMPDIR-verify-essential-4VO1CE-workspace/4d01a28e-857c-4ba6-8ad4-ce300667e292.jsonl; response IDs msg_e9c9e40f666949f8866a8e45252a4fe5; log range slots/gpt-6-sol__V01/bridge.log bytes 2573-5263
- gpt-6-sol V01 clear: transcript slots/gpt-6-sol__V01/home/.claude/projects/-TMPDIR-verify-essential-4VO1CE-workspace/514fc613-9981-4bf1-806a-deb267d5b364.jsonl; response IDs msg_770a8dbd7392420b8bc09cee6ce3b6d8; log range slots/gpt-6-sol__V01/bridge.log bytes 5263-8087
- gpt-6-sol V02 coding: transcript slots/gpt-6-sol__V02/transcript-coding.jsonl; response IDs msg_fb78818fdc76466da0f6df9d8a3a8116, msg_8f543accd3db41cba0a5d4a2500d609b, msg_216e801031874020b1ebd0cf0d6f6a53, msg_395321dad44d4129b6b9eaba89b8ae4b, msg_ad1138fde68a42c79851f2c429f34e2e, msg_31af7cf80f49481ab847d51e9a210ffb, msg_cdedb4ca7b224ca68373c3d117d322b9; log range slots/gpt-6-sol__V02/bridge.log bytes 153-23266
- gpt-6-sol V03 lookup: transcript slots/gpt-6-sol__V03/home/.claude/projects/-TMPDIR-verify-essential-eUur8D-workspace/bdcb94d8-3246-4569-83d0-3322fcc07d09.jsonl; response IDs msg_d3108a71eb544c0f802f6c439fd38fce, msg_bf82b3f32e6d4b528f0aad25ccda76e1, msg_12b325ca07494a4dbf23cd5a65cb1bae; log range slots/gpt-6-sol__V03/bridge.log bytes 153-8282
- gpt-6-sol V03 recall: transcript slots/gpt-6-sol__V03/home/.claude/projects/-TMPDIR-verify-essential-eUur8D-workspace/bdcb94d8-3246-4569-83d0-3322fcc07d09.jsonl; response IDs msg_3ead3b6fc9e649c5a38cf41ecc7b64f3; log range slots/gpt-6-sol__V03/bridge.log bytes 8282-12229
- gpt-6-sol V04 source: transcript slots/gpt-6-sol__V04/home/.claude/projects/-TMPDIR-verify-essential-buCCXe-workspace/148ef4b0-ae66-46ed-a9b9-360927121e1e.jsonl; response IDs msg_a6da6392620e4a73b1ee078f39a82aef; log range slots/gpt-6-sol__V04/bridge.log bytes 155-2592
- gpt-6-sol V04 target: transcript slots/gpt-6-sol__V04/home/.claude/projects/-TMPDIR-verify-essential-buCCXe-workspace/148ef4b0-ae66-46ed-a9b9-360927121e1e.jsonl; response IDs msg_88c761e0d481497fa3203c62065b7a54; log range slots/gpt-6-sol__V04/bridge.log bytes 2592-6502
- gpt-6-sol V05 interrupt: transcript slots/gpt-6-sol__V05/home/.claude/projects/-TMPDIR-verify-essential-IYD11T-workspace/ea6e0bdb-c388-45fc-8d6b-283cc8590ccb.jsonl; response IDs msg_f07ef1f6f3a44790b51d49f8db38d41c; log range unknown
- gpt-6-sol V05 recovery: transcript slots/gpt-6-sol__V05/home/.claude/projects/-TMPDIR-verify-essential-IYD11T-workspace/ea6e0bdb-c388-45fc-8d6b-283cc8590ccb.jsonl; response IDs msg_3accd274c8ba4421b48758c989453d0a; log range slots/gpt-6-sol__V05/bridge.log bytes 5217-8245
- gpt-6-sol V06 seed: transcript slots/gpt-6-sol__V06/home/.claude/projects/-TMPDIR-verify-essential-o7f2Hk-workspace/dd8c5313-404c-4f5f-b806-286ab06137ca.jsonl; response IDs msg_d4b4b78a3f134a689a36ee3a20d96d71; log range slots/gpt-6-sol__V06/bridge.log bytes 153-2575
- gpt-6-sol V06 compact: transcript slots/gpt-6-sol__V06/home/.claude/projects/-TMPDIR-verify-essential-o7f2Hk-workspace/dd8c5313-404c-4f5f-b806-286ab06137ca.jsonl; response IDs msg_2ab6d3563d384b569fb63813d2630789; log range slots/gpt-6-sol__V06/bridge.log bytes 2575-5294
- gpt-6-sol V06 recall: transcript slots/gpt-6-sol__V06/home/.claude/projects/-TMPDIR-verify-essential-o7f2Hk-workspace/dd8c5313-404c-4f5f-b806-286ab06137ca.jsonl; response IDs msg_f1a20696c3b04570ba1e70bc271a1373; log range slots/gpt-6-sol__V06/bridge.log bytes 5294-8359
- gpt-6-sol V06 resume: transcript slots/gpt-6-sol__V06/home/.claude/projects/-TMPDIR-verify-essential-o7f2Hk-workspace/dd8c5313-404c-4f5f-b806-286ab06137ca.jsonl; response IDs msg_4a4b1eb30e0444b290d744655612913b; log range slots/gpt-6-sol__V06/bridge-2.log bytes 153-3707
- gpt-6-luna V01 print: transcript slots/gpt-6-luna__V01/transcript-print.jsonl; response IDs msg_e64049e1f80d4098863bed4c3d2ae2bf; log range slots/gpt-6-luna__V01/bridge.log bytes 154-2581
- gpt-6-luna V01 unicode: transcript slots/gpt-6-luna__V01/home/.claude/projects/-TMPDIR-verify-essential-RYV60m-workspace/7eb51502-d1b1-458a-8e20-7fd8618e6772.jsonl; response IDs msg_9d418ac9db26426bb4e9f7838f127f10; log range slots/gpt-6-luna__V01/bridge.log bytes 2581-5279
- gpt-6-luna V01 clear: transcript slots/gpt-6-luna__V01/home/.claude/projects/-TMPDIR-verify-essential-RYV60m-workspace/68246974-64f9-4421-a7cd-03184cc48809.jsonl; response IDs msg_1335e9d78d94441fb8a6436b7e3b0fc0; log range slots/gpt-6-luna__V01/bridge.log bytes 5279-8110
- gpt-6-luna V02 coding: transcript slots/gpt-6-luna__V02/transcript-coding.jsonl; response IDs msg_081c4baf7c774c9495a87894694b7fe8, msg_27f66f4a864d40858c1313f846dbfc18, msg_174db516b5ed44999ab96df21a66a4e7, msg_34f2120915824de48cbaabfd12f8b426, msg_ed6752956e5c4e5e88a219de25ad8617, msg_af804c5c93924206bfa2e1145a8c3b1c, msg_87ce4dc123384ea4bc58d5148d24e705; log range slots/gpt-6-luna__V02/bridge.log bytes 154-23310
- gpt-6-luna V03 lookup: transcript slots/gpt-6-luna__V03/home/.claude/projects/-TMPDIR-verify-essential-oO0d64-workspace/de214d14-b66e-45ee-8388-367a20e55469.jsonl; response IDs msg_9c4bda99711943aca29b5d55e5becb3d, msg_10c4245c6bdb4ba0b9781923940f0f6f, msg_d51ca3043e1a44eb9a3771ef3eb6c542; log range slots/gpt-6-luna__V03/bridge.log bytes 154-8302
- gpt-6-luna V03 recall: transcript slots/gpt-6-luna__V03/home/.claude/projects/-TMPDIR-verify-essential-oO0d64-workspace/de214d14-b66e-45ee-8388-367a20e55469.jsonl; response IDs msg_0940afcfad0e4b3388fc4e44d8bdc16b; log range slots/gpt-6-luna__V03/bridge.log bytes 8302-12255
- gpt-6-luna V04 source: transcript slots/gpt-6-luna__V04/home/.claude/projects/-TMPDIR-verify-essential-PXSnOU-workspace/ed977a8d-756e-40e0-aae5-c1edc1d66a5e.jsonl; response IDs msg_a396d3eb2941432baa79cac0b564c43b; log range slots/gpt-6-luna__V04/bridge.log bytes 155-2592
- gpt-6-luna V04 target: transcript slots/gpt-6-luna__V04/home/.claude/projects/-TMPDIR-verify-essential-PXSnOU-workspace/ed977a8d-756e-40e0-aae5-c1edc1d66a5e.jsonl; response IDs msg_29c1c69ea60f41b3b8e7d2ecf930198c; log range slots/gpt-6-luna__V04/bridge.log bytes 2592-6509
- gpt-6-luna V05 interrupt: transcript slots/gpt-6-luna__V05/home/.claude/projects/-TMPDIR-verify-essential-J5rYpP-workspace/6eb9fdc7-c5f3-4063-b579-5797a7bae9d0.jsonl; response IDs msg_188503d099fe4d1eb576014d0a9c28ad; log range unknown
- gpt-6-luna V05 recovery: transcript slots/gpt-6-luna__V05/home/.claude/projects/-TMPDIR-verify-essential-J5rYpP-workspace/6eb9fdc7-c5f3-4063-b579-5797a7bae9d0.jsonl; response IDs msg_05d8869219c94363b3a6bb222e13bc1c; log range slots/gpt-6-luna__V05/bridge.log bytes 5313-8347
- gpt-6-luna V06 seed: transcript slots/gpt-6-luna__V06/home/.claude/projects/-TMPDIR-verify-essential-1TzWFk-workspace/6ffcf93d-4db9-4003-a177-42ec627db2c2.jsonl; response IDs msg_871db826ac6b4c128db2fece1da1f19a; log range slots/gpt-6-luna__V06/bridge.log bytes 154-2583
- gpt-6-luna V06 compact: transcript slots/gpt-6-luna__V06/home/.claude/projects/-TMPDIR-verify-essential-1TzWFk-workspace/6ffcf93d-4db9-4003-a177-42ec627db2c2.jsonl; response IDs msg_88d1f949edbe426bb0e0fe2371eebbf8; log range slots/gpt-6-luna__V06/bridge.log bytes 2583-5308
- gpt-6-luna V06 recall: transcript slots/gpt-6-luna__V06/home/.claude/projects/-TMPDIR-verify-essential-1TzWFk-workspace/6ffcf93d-4db9-4003-a177-42ec627db2c2.jsonl; response IDs msg_612dad9cf33b4d839c06536b542384d8; log range slots/gpt-6-luna__V06/bridge.log bytes 5308-8380
- gpt-6-luna V06 resume: transcript slots/gpt-6-luna__V06/home/.claude/projects/-TMPDIR-verify-essential-1TzWFk-workspace/6ffcf93d-4db9-4003-a177-42ec627db2c2.jsonl; response IDs msg_3e30686609be46ffb725a6af40c630aa; log range slots/gpt-6-luna__V06/bridge-2.log bytes 154-3715

Preview only: no binary/authentication/connectivity checks or SDK metadata lookup.
```bash
CLAUDE_CODE_BIN="$HOME/.local/share/claude/versions/2.1.282" PENDING_TOOL_WAIT_MS='30000' npm run verify -- --model-concurrency '1' --timeout-scale '2' --models 'claude-opus-5.5,claude-sonnet-5,claude-haiku-4.5,gpt-6-astra,gpt-6-sol,gpt-6-luna' --scenarios 'V01,V02,V03,V04,V05,V06' --dry-run
```
Optional new live run: consumes real Copilot usage. Restore the frozen working-tree source copies and recorded dependencies/binary first; a dirty commit alone cannot reconstruct the code that ran. The command repeats recorded runtime budgets that differ from the defaults. This command creates a new run, never rewrites this evidence.
```bash
CLAUDE_CODE_BIN="$HOME/.local/share/claude/versions/2.1.282" PENDING_TOOL_WAIT_MS='30000' npm run verify -- --model-concurrency '1' --timeout-scale '2' --models 'claude-opus-5.5,claude-sonnet-5,claude-haiku-4.5,gpt-6-astra,gpt-6-sol,gpt-6-luna' --scenarios 'V01,V02,V03,V04,V05,V06'
```

## Limits

The six cases cover private CLI launch, Unicode/clear, coding tools, declared MCP recovery, model/effort switch, active interruption and explicit compaction/cold resume only when their gates pass. They do not prove maximum context length, automatic compaction limits, every instant of process isolation, provider internals, arbitrary plugins/hooks/subagents, permissions UI, media, production launcher/shared daemon or LiteLLM. Offline production tests are separate. Results apply to the recorded code, binary, host, models and configuration only.
