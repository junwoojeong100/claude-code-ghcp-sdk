# 검증 결과 — 7개 모델 × 11개 시나리오

이 문서는 `scripts/verify/report.mjs`가 실행 기록(`slots.jsonl`)에서 생성합니다. 손으로 고치지 마세요 — 다시 생성하면 덮어쓰입니다.

## 무엇을 검증했나

모든 슬롯은 실제 경로를 그대로 지납니다: 진짜 Claude Code 바이너리 → 브리지 → Copilot SDK → Copilot 모델. 목이나 스텁은 없습니다. 판정은 모델이 무엇을 말했는지가 아니라 **디스크 상태, git 이력, 훅 로그, stream-json 이벤트**로 합니다.

- Claude Code: `2.1.278`
- 실행 시각: 2026-09-21T23:07:19.056Z → 2026-09-21T23:21:41.753Z
- 소요: 863초
- 호스트: darwin arm64 / node v22.16.0

## 정책, 완전성 및 코드 출처

- 정책: strict-all-pass-v1
- 범위: full (77 전체 매트릭스 카탈로그 슬롯)
- 예상: 77 / 실제: 77
- 결과: NOT GREEN
- 엄격한 통과는 비어 있지 않은 예상 매트릭스의 정확하고 중복 없는 완료, 모든 슬롯의 pass, 사용자 설정 보존 및 시작/종료 코드 출처 일치를 요구합니다.
- 진단: Every expected slot must pass; fail, blocked and unknown outcomes are not passes.
- 코드 출처 start: commit: 3b42a61af1d461f3aa6c9bcc807fcb7afdfdd4e1; dirty: true; fingerprint: sha256 verification-code-v1 0101162ad82ba5f80f123368628f64a325b17dc79eb9ef47897385e9dd2b0f6e; files: 41
- 코드 출처 end: commit: 3b42a61af1d461f3aa6c9bcc807fcb7afdfdd4e1; dirty: true; fingerprint: sha256 verification-code-v1 0101162ad82ba5f80f123368628f64a325b17dc79eb9ef47897385e9dd2b0f6e; files: 41

## 기록된 실행 설정

| 설정 / 대기 | 기록된 값 | 적용 범위 |
| --- | --- | --- |
| `--timeout-scale` | 2 | 검증 전용 timeout 배율 |
| `PENDING_TOOL_WAIT_MS` | 30000 ms (30 s) | 별도의 pending-tool 대기. --timeout-scale을 곱하지 않음 |
| `--model-concurrency` | 7 | 동시에 실행할 모델 작업자 수 |
| `--scenario-concurrency` | 2 | 모델별로 동시에 실행할 시나리오 작업자 수 |
| `bridgeHealthMs` | 240000 ms (240 s) | 검증용 bridge health 대기 |
| `planTurnMs` | 180000 ms (180 s) | plan-mode의 각 headless 턴 |
| `backgroundLaunchMs` | 240000 ms (240 s) | v11 background launcher 호출 |
| `foregroundLaunchMs` | 360000 ms (360 s) | v11 foreground launcher 호출 |
| `persistentLaunchMs` | 240000 ms (240 s) | v11 persistent launcher 호출 |
| `detachedOutputMs` | 480000 ms (480 s) | v11 detached 출력 대기 |
| `scenarioMs.v01-repo-recon` | 480000 ms (480 s) | 슬롯 전체가 아닌 headless 턴마다 적용 (v01–v10) |
| `scenarioMs.v02-surgical-edit` | 480000 ms (480 s) | 슬롯 전체가 아닌 headless 턴마다 적용 (v01–v10) |
| `scenarioMs.v03-test-fix-loop` | 480000 ms (480 s) | 슬롯 전체가 아닌 headless 턴마다 적용 (v01–v10) |
| `scenarioMs.v04-shell-ops` | 840000 ms (840 s) | 슬롯 전체가 아닌 headless 턴마다 적용 (v01–v10) |
| `scenarioMs.v05-multi-step` | 600000 ms (600 s) | 슬롯 전체가 아닌 headless 턴마다 적용 (v01–v10) |
| `scenarioMs.v06-subagent` | 480000 ms (480 s) | 슬롯 전체가 아닌 headless 턴마다 적용 (v01–v10) |
| `scenarioMs.v07-mcp-playwright` | 600000 ms (600 s) | 슬롯 전체가 아닌 headless 턴마다 적용 (v01–v10) |
| `scenarioMs.v08-hooks-memory` | 660000 ms (660 s) | 슬롯 전체가 아닌 headless 턴마다 적용 (v01–v10) |
| `scenarioMs.v09-session-resume` | 600000 ms (600 s) | 슬롯 전체가 아닌 headless 턴마다 적용 (v01–v10) |
| `scenarioMs.v10-long-context` | 480000 ms (480 s) | 슬롯 전체가 아닌 headless 턴마다 적용 (v01–v10) |
| `scenarioMs.v11-daemon-background` | 840000 ms (840 s) | 계획용 값만 기록. v11은 위의 별도 단계별 대기를 사용 |

Status/list/stop/final-cleanup wrapper, poll/probe, 로컬 테스트 제한, SIGKILL 유예 시간과 실제 운용 launcher/daemon 시작 기본값은 timeout 배율로 바뀌지 않습니다.

명령 한정 PENDING_TOOL_WAIT_MS=30000(30초)은 검증 시의 예방 조치이지, 결과 없이 종료되는 현상의 확립된 해결책이 아닙니다.

단일 턴 기준 일정 추정치는 계획용이며 deadline이나 실제 최악의 경우 상한이 아닙니다. 한 슬롯에 여러 호출이 있을 수 있고, v11은 scenarioMs 계획 예산이 아닌 별도의 단계별 대기를 사용합니다.

## 결과 매트릭스

| 시나리오 | claude-opus-5 | claude-sonnet-5 | claude-haiku-4.5 | gpt-5.6-sol | gpt-5.6-terra | gpt-5.6-luna | gpt-6-astra |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `v01-repo-recon` | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| `v02-surgical-edit` | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| `v03-test-fix-loop` | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| `v04-shell-ops` | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| `v05-multi-step` | PASS | PASS | BLOCK | PASS | PASS | PASS | PASS |
| `v06-subagent` | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| `v07-mcp-playwright` | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| `v08-hooks-memory` | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| `v09-session-resume` | FAIL | FAIL | PASS | PASS | PASS | PASS | PASS |
| `v10-long-context` | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| `v11-daemon-background` | PASS | PASS | PASS | PASS | PASS | PASS | PASS |

**pass 74 / fail 2 / blocked 1** — 전체 77슬롯, 통과 기준 77.

BLOCK(blocked)는 통과가 아닙니다. 실행하지 못한 슬롯이며 분모에 그대로 남습니다. DUP는 중복 기록, UNKNOWN은 알 수 없는 결과입니다.

## 시나리오

### `v01-repo-recon` — 저장소 정찰

코드를 고치기 전에 저장소에서 대상을 찾아내는, 거의 모든 세션의 첫 동작.

**이 시나리오가 잡아내려는 브리지 결함**: 큰 tool_result가 전송 중 잘리거나 재인코딩되는 경우, 또는 다중 호출 턴 순서가 뒤바뀌어 읽지도 않은 경로를 답하는 경우.

판정 기준:
- The prompt went in as a stream-json envelope and the CLI replayed it back.
- A search tool was actually used (Bash — this build offers no Glob or Grep).
- The answer names the planted file, not either decoy.
- Every tool_use in the transcript has a matching tool_result.
- result carries a stop_reason and non-zero usage, and modelUsage names the expected backend.

### `v02-surgical-edit` — 정밀 편집과 파일 생성

요청한 것만 정확히 바꾸고 나머지는 건드리지 않은 뒤 새 파일을 만드는, 바이트 단위 편집 계약.

**이 시나리오가 잡아내려는 브리지 결함**: tool_use 페이로드의 공백·개행 정규화로 Edit의 정확 일치가 실패하거나 엉뚱한 줄에 조용히 매칭되는 경우.

판정 기준:
- A plan-mode turn finished on its own and left the file untouched.
- The second marked line holds the new value.
- The first and third marked lines are byte-for-byte unchanged.
- The requested new file exists with the requested export.
- The Edit tool was used; the file was not rewritten wholesale.

### `v03-test-fix-loop` — 실패 테스트 진단과 수정

실행 → 실패 확인 → 소스 수정 → 재실행을 녹색이 될 때까지 반복하는 핵심 에이전트 루프.

**이 시나리오가 잡아내려는 브리지 결함**: 비정상 종료나 stderr 위주의 tool_result가 유실·오표기되어 모델이 실패 사실을 모른 채 조기 종료하는 경우.

판정 기준:
- Bash was used to run the suite.
- The first run came back failing and the session continued anyway.
- The test file is byte-for-byte unchanged.
- The runner re-runs the suite itself afterwards and it exits 0.

### `v04-shell-ops` — 백그라운드 셸과 git 워크플로

단일 명령보다 오래 사는 두 가지 셸 워크플로 — 장기 실행 프로세스와 버전 관리.

**이 시나리오가 잡아내려는 브리지 결함**: 백그라운드 셸 핸들이 턴을 넘기며 유실되어 모델이 완료를 확인하지 못하고 프로세스가 고아로 남는 경우.

판정 기준:
- A long-running process was started and watched to completion.
- The tick log reached at least three lines.
- git log shows exactly the requested commit subject.
- Exactly one secondary worktree matches the requested branch or its native EnterWorktree equivalent.
- The same worktree holds the marker file both on disk and committed unchanged in HEAD.
- The marker file is absent from both the primary checkout and its HEAD.
- No ticker process survives the slot.

### `v05-multi-step` — 파일 종류를 넘나드는 4단계 계획

한 턴 안에서 4단계 계획을 유지하며 소스 파일, 평문 파일, 새 마크다운 파일, 주피터 노트북까지 모든 단계를 완수하는 것.

**이 시나리오가 잡아내려는 브리지 결함**: 도구 루프가 길어지며 계획이 유실되어 앞쪽 단계만 반영되고 뒤쪽 단계가 조용히 누락되는 경우.

판정 기준:
- All four changes are present on disk.
- The notebook still parses as a valid nbformat 4 document.
- No step was reported done without the file backing it.
- The tokens inside the attached PDF and PNG both came back.

### `v06-subagent` — 서브에이전트 위임

프로젝트에 정의된 서브에이전트에 작업을 넘기고 그 결과를 이어 쓰는 동작.

**이 시나리오가 잡아내려는 브리지 결함**: 서브에이전트의 도구 루프는 중첩 세션에서 돌기 때문에 최종 보고가 인계 지점에서 유실되고 부모가 답을 지어내는 경우.

판정 기준:
- The project-defined agent is advertised in the init event.
- The Task tool was invoked against that agent.
- A tool_result came back for the delegation.
- The final answer names the files only the delegated search could have found.

### `v07-mcp-playwright` — MCP 브라우저 자동화(헤드리스)

MCP로 들어온 외부 기능을 실제로 사용하는 것 — @playwright/mcp로 구동되는 헤드리스 Chrome.

**이 시나리오가 잡아내려는 브리지 결함**: MCP 도구 스키마가 경유 중 재작성·네임스페이스 변경되어 모델이 호출하지 못하거나 잘못된 형태로 호출하는 경우.

판정 기준:
- The playwright MCP server is connected in the init event.
- At least one mcp__playwright__* tool was called.
- The answer carries the token that only exists in the served page's DOM.

### `v08-hooks-memory` — 훅·메모리·명령·스킬

프로젝트가 모델 주위에 설정하는 모든 것 — CLAUDE.md 규칙, 관찰·차단하는 훅, 커스텀 명령과 스킬.

**이 시나리오가 잡아내려는 브리지 결함**: 훅 차단이 거부가 아닌 평범한 tool_result로 전달되어 모델이 막힌 동작을 수행된 것으로 오인하는 경우.

판정 기준:
- The CLAUDE.md rule was obeyed: the record landed at the path the project mandates.
- The PreToolUse hook fired and left its log.
- The forbidden command was denied and never ran.
- The custom command and skill are advertised in the init event.
- A plugin loaded from --plugin-dir contributes a command and a skill, both advertised.
- A cron job was created and came back out of the job list, carrying the id or the prompt it was created with.

### `v09-session-resume` — 프로세스 간 세션 재개

작업을 덮었다 다시 여는 상황 — 두 번째 프로세스가 첫 번째의 문맥을 그대로 이어받아야 한다.

**이 시나리오가 잡아내려는 브리지 결함**: 세션 상태가 업스트림 연결에 묶여 있어 재개 시 빈 대화가 열리고 아무 근거 없이 답하는 경우.

판정 기준:
- The resumed process reports the same session id.
- It recalls the planted build id.
- It used no file-reading tool: the answer came from conversation context.
- A forked resume inherits the same context under a session id of its own.

### `v10-long-context` — 대형 컨텍스트 검색과 추론

큰 컨텍스트의 멀리 떨어진 두 사실을 꺼내 결합하는 것 — 긴 컨텍스트의 실제 용도.

**이 시나리오가 잡아내려는 브리지 결함**: 업스트림에서 컨텍스트가 조용히 잘려 모델이 남은 절반만 보고 자신 있게 답하는 경우.

판정 기준:
- The result carries a schema-valid structured object, not just prose.
- The arithmetic answer is exactly right, which needs both facts.
- Reported input usage reflects the whole corpus, not a truncated prefix.
- The answer came from the prompt itself: no file-reading tool was used.

### `v11-daemon-background` — 런처·데몬·백그라운드 에이전트

이 프로젝트가 실제로 배포하는 진입점 — bin/claude-ghcp 런처, 그것이 남기는 상주 브리지 데몬, 런처가 종료된 뒤에도 계속 응답받는 분리형 에이전트.

**이 시나리오가 잡아내려는 브리지 결함**: 데몬은 자신을 띄운 프로세스보다 오래 살기 때문에 수명이 부모가 아니라 레지스트리 파일에 묶인다. 레지스트리가 낡으면 죽은 포트를 건네고, 두 번째 실행이 살아 있는 데몬을 재사용하지 않고 조용히 경쟁 데몬을 띄우며, 종료가 포트를 남긴다. 슬롯마다 단명 브리지를 직접 띄우는 시나리오로는 보이지 않는 영역이다.

판정 기준:
- The launcher's own preflight passed and it reported a backgrounded session id.
- claude-ghcp-status reports the daemon running, with a pid and port, under the requested model.
- The detached agent wrote a value that exists only in a file it had to read.
- claude agents lists the background session against the slot's workspace.
- A foreground launch answers from its own ephemeral bridge and leaves the daemon undisturbed.
- A launch that asks for the persistent bridge goes through the daemon and reuses the same pid and port instead of starting a rival.
- claude-ghcp-stop reports stopped, status goes not-running, and the registry and log are gone.

## 커버리지

선택한 11개 시나리오는 현재 Claude Code 핵심 기능 인벤토리의 **92.2%**(가중치 94/102)에 해당합니다. 이는 카탈로그 커버리지이며 통과율이 아니고 모든 슬롯 실행의 증거도 아닙니다. 결과 집계와 별도로 `scripts/verify/features.mjs`의 기능 목록과 선택한 각 시나리오의 `covers`에서 계산됩니다.

### 커버하지 못한 기능 (정직한 잔여분)

- `thinking` (가중치 2) — 확장 사고 블록
- `webfetch` (가중치 2) — WebFetch / WebSearch
- `tui` (가중치 2) — 대화형 TUI 요소
- `compaction` (가중치 2) — 자동 컨텍스트 압축

### 이 빌드에 없는 도구 (분모에서 제외)

Claude Code 2.1.278는 다음 도구를 제공하지 않습니다: `TodoWrite`, `BashOutput`, `KillShell`, `Glob`, `Grep`. `scripts/verify/probe.mjs`가 측정합니다. 각 도구를 이름으로 지목해 호출시키고 스트림을 읽습니다 — 빌드가 제공하지 않는 도구는 아무리 강하게 요구해도 tool_use 블록을 만들 수 없기 때문입니다. 같은 턴에서 Read를 양성 대조군으로 함께 호출시키므로, 모델이 통째로 거부한 경우와 도구가 실제로 없는 경우를 구분할 수 있습니다. 브리지의 결함이 아니라 CLI가 애초에 제공하지 않는 기능이므로, 커버한 것으로도 못 한 것으로도 세지 않고 분모에서 제외합니다.

- `glob` (가중치 3, `Glob` 필요) — Glob 경로 검색
- `grep` (가중치 3, `Grep` 필요) — Grep 내용 검색
- `bash-background` (가중치 2, `BashOutput` 필요) — 백그라운드 셸/출력 폴링
- `todo` (가중치 2, `TodoWrite` 필요) — TodoWrite 작업 추적

## 통과하지 못한 슬롯

### claude-sonnet-5 × `v09-session-resume` — fail

- FAIL fork inherited the seed turn's context — `Thursday 2026-09-24 02:00 UTC`
- fork inherited the seed turn's context: Thursday 2026-09-24 02:00 UTC

### claude-haiku-4.5 × `v05-multi-step` — blocked

- FAIL src/greet.mjs carries "Good morning" — `export function greet(name) {
  return "Hello, " + name + "!";
}
`
- FAIL VERSION carries "0.2.0" — `0.1.0
`
- FAIL CHANGELOG.md carries "ZS75BN" — `file missing`
- FAIL analysis.ipynb carries "0.08" — `{
 "cells": [
  {
   "cell_type": "markdown",
   "id": "intro",
   "metadata": {},
   "source": [
    "# Rate analysis\n`
- FAIL notebook is still a valid nbformat 4 document — `nbformat=4 cells=2`
- FAIL the PDF's token came back — `looked for PDFDOCC38821 in: I'll complete the four changes and then extract the tokens from the PDF and image.`
- FAIL the image's token came back — `looked for IMGTAG99AB92 in: I'll complete the four changes and then extract the tokens from the PDF and image.`
- FAIL main: completed — `timed out after 602s`
- FAIL main: expected model served — `modelUsage was empty`
- FAIL main: result.stop_reason present — `missing`
- FAIL main: usage reports input tokens — `input=0`
- main: timed out after 602s

### claude-opus-5 × `v09-session-resume` — fail

- FAIL resume: usage reports input tokens — `input=0`
- resume: usage reports input tokens: input=0

## 재현

아래 명령은 기록된 설정을 다시 사용합니다. 기록되지 않은 설정에는 과거 값을 추정하지 않고 현재 기본값을 적용합니다.

```bash
PENDING_TOOL_WAIT_MS=30000 npm run verify -- --timeout-scale 2 --model-concurrency 7 --scenario-concurrency 2 # 7개 모델 × 11개 시나리오
PENDING_TOOL_WAIT_MS=30000 npm run verify -- --timeout-scale 2 --model-concurrency 7 --scenario-concurrency 2 --dry-run # 실행 없이 계획만
npm run verify:probe        # 없는 도구 목록의 근거가 되는 능력 프로브
npm run verify:report       # 최근 실행 결과 요약
```

