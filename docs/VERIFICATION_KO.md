# 검증 결과 — 7개 모델 × 10개 시나리오

이 문서는 `scripts/verify/report.mjs`가 실행 기록(`slots.jsonl`)에서 생성합니다. 손으로 고치지 마세요 — 다시 생성하면 덮어쓰입니다.

## 무엇을 검증했나

모든 슬롯은 실제 경로를 그대로 지납니다: 진짜 Claude Code 바이너리 → 브리지 → Copilot SDK → Copilot 모델. 목이나 스텁은 없습니다. 판정은 모델이 무엇을 말했는지가 아니라 **디스크 상태, git 이력, 훅 로그, stream-json 이벤트**로 합니다.

- Claude Code: `2.1.278`
- 실행 시각: 2026-09-20T16:37:45.541Z → 2026-09-20T16:40:38.648Z
- 소요: 173초
- 호스트: darwin arm64 / node v22.16.0

## 결과 매트릭스

| 시나리오 | claude-opus-5 | claude-sonnet-5 | claude-haiku-4.5 | gpt-5.6-sol | gpt-5.6-terra | gpt-5.6-luna | gpt-6-astra |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `v01-repo-recon` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `v02-surgical-edit` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `v03-test-fix-loop` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `v04-shell-ops` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `v05-multi-step` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `v06-subagent` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `v07-mcp-playwright` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `v08-hooks-memory` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `v09-session-resume` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `v10-long-context` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

**pass 70 / fail 0 / blocked 0** — 전체 70슬롯, 통과 기준 67.

⚠️(blocked)는 통과가 아닙니다. 전송 계층이 깨져 모델에 대해 아무것도 말해주지 못한 슬롯이며, 분모에 그대로 남습니다.

## 시나리오

### `v01-repo-recon` — 저장소 정찰

코드를 고치기 전에 저장소에서 대상을 찾아내는, 거의 모든 세션의 첫 동작.

**이 시나리오가 잡아내려는 브리지 결함**: 큰 tool_result가 전송 중 잘리거나 재인코딩되는 경우, 또는 다중 호출 턴 순서가 뒤바뀌어 읽지도 않은 경로를 답하는 경우.

판정 기준:
- A search tool (Glob, Grep or Bash) was actually used.
- The answer names the planted file, not either decoy.
- Every tool_use in the transcript has a matching tool_result.
- result carries a stop_reason and non-zero usage, and modelUsage names the expected backend.

### `v02-surgical-edit` — 정밀 편집과 파일 생성

요청한 것만 정확히 바꾸고 나머지는 건드리지 않은 뒤 새 파일을 만드는, 바이트 단위 편집 계약.

**이 시나리오가 잡아내려는 브리지 결함**: tool_use 페이로드의 공백·개행 정규화로 Edit의 정확 일치가 실패하거나 엉뚱한 줄에 조용히 매칭되는 경우.

판정 기준:
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
- No ticker process survives the slot.

### `v05-multi-step` — 파일 종류를 넘나드는 4단계 계획

한 턴 안에서 4단계 계획을 유지하며 소스 파일, 평문 파일, 새 마크다운 파일, 주피터 노트북까지 모든 단계를 완수하는 것.

**이 시나리오가 잡아내려는 브리지 결함**: 도구 루프가 길어지며 계획이 유실되어 앞쪽 단계만 반영되고 뒤쪽 단계가 조용히 누락되는 경우.

판정 기준:
- All four changes are present on disk.
- The notebook still parses as a valid nbformat 4 document.
- No step was reported done without the file backing it.

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

### `v09-session-resume` — 프로세스 간 세션 재개

작업을 덮었다 다시 여는 상황 — 두 번째 프로세스가 첫 번째의 문맥을 그대로 이어받아야 한다.

**이 시나리오가 잡아내려는 브리지 결함**: 세션 상태가 업스트림 연결에 묶여 있어 재개 시 빈 대화가 열리고 아무 근거 없이 답하는 경우.

판정 기준:
- The resumed process reports the same session id.
- It recalls the planted build id.
- It used no file-reading tool: the answer came from conversation context.

### `v10-long-context` — 대형 컨텍스트 검색과 추론

큰 컨텍스트의 멀리 떨어진 두 사실을 꺼내 결합하는 것 — 긴 컨텍스트의 실제 용도.

**이 시나리오가 잡아내려는 브리지 결함**: 업스트림에서 컨텍스트가 조용히 잘려 모델이 남은 절반만 보고 자신 있게 답하는 경우.

판정 기준:
- The arithmetic answer is exactly right, which needs both facts.
- Reported input usage reflects the whole corpus, not a truncated prefix.
- The answer came from the prompt itself: no file-reading tool was used.

## 커버리지

10개 시나리오가 Claude Code 핵심 기능 인벤토리의 **90.7%**(가중치 78/86)를 실제로 행사합니다. 이 숫자는 산문이 아니라 `scripts/verify/features.mjs`의 기능 목록과 각 시나리오의 `covers`에서 계산됩니다.

### 커버하지 못한 기능 (정직한 잔여분)

- `thinking` (가중치 2) — 확장 사고 블록
- `webfetch` (가중치 2) — WebFetch / WebSearch
- `tui` (가중치 2) — 대화형 TUI 요소
- `compaction` (가중치 2) — 자동 컨텍스트 압축

### 이 빌드에 없는 도구 (분모에서 제외)

Claude Code 2.1.278는 다음 도구를 제공하지 않습니다: `TodoWrite`, `BashOutput`, `KillShell`. 직접 호출을 시켜 확인했고, 모델이 "없다"고 답한 뒤 우회 수단을 택했습니다. 브리지의 결함이 아니라 CLI가 애초에 제공하지 않는 기능이므로, 커버한 것으로도 못 한 것으로도 세지 않고 분모에서 제외합니다.

- `bash-background` (가중치 2, `BashOutput` 필요) — 백그라운드 셸/출력 폴링
- `todo` (가중치 2, `TodoWrite` 필요) — TodoWrite 작업 추적

## 재현

```bash
npm run verify              # 7개 모델 × 10개 시나리오
npm run verify:plan         # 실행 없이 계획만
npm run verify:report       # 최근 실행 결과 요약
```

