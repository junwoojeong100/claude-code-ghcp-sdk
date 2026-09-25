# 핵심 연동 검증

> [English](VERIFICATION.md) | 한국어

결과: NOT PASSED
pass 35 / fail 1 / blocked 0 / unknown 0
예상: 36 / 실제: 36 / gate: 36
범위: full (36 전체 매트릭스 케이스)
정책: strict-all-pass-v2; suite: claude-ghcp-essential-v1; schema: 2
전체 PASS에는 정규 슬롯 36개·필수 단계 검사·원본 증거 재판정·정리·설정/코드/실행 파일 불변·소스/산출물 해시 검증이 필요합니다. BLOCKED는 통과가 아닙니다.

## 모델 × 시나리오 결과

| 선택 모델 | V01 | V02 | V03 | V04 | V05 | V06 |
| --- | --- | --- | --- | --- | --- | --- |
| claude-opus-5.5 | PASS | PASS | PASS | PASS | PASS | PASS |
| claude-sonnet-5 | PASS | PASS | PASS | PASS | PASS | PASS |
| claude-haiku-4.5 | PASS | FAIL | PASS | PASS | PASS | PASS |
| gpt-6-astra | PASS | PASS | PASS | PASS | PASS | PASS |
| gpt-6-sol | PASS | PASS | PASS | PASS | PASS | PASS |
| gpt-6-luna | PASS | PASS | PASS | PASS | PASS | PASS |

## 실패와 누락 증거

- Every expected slot must pass; fail, blocked and unknown outcomes are not passes.
- FAIL claude-haiku-4.5 × V02: coding: exact answer: entire fresh answer must match
  - coding: exact answer: entire fresh answer must match
  - coding: exact answer: entire fresh answer must match
    - exact answer: entire fresh answer must match

## 시나리오 기준

필수 기준이며 실패·차단된 케이스가 만족했다는 뜻이 아닙니다.
- V01 r2 — 실행·Unicode·새 대화 격리
  - 실제 print 응답이 정상 완료되며 요청한 답과 정확히 같습니다.
  - native picker에 대상 모델 6개가 있으며 새로운 Unicode 응답이 정확합니다.
  - native /clear가 세션을 바꾸고 다음 요청에서 이전 대화가 제거됩니다.
- V02 r1 — 읽기·수정·회귀 테스트
  - 실패하는 foreground 테스트 전에 Read가 숨은 sample·소스·테스트 전체를 반환합니다.
  - 성공한 Edit가 discount.mjs만 고친 뒤 종료 상태를 가리지 않은 동일 명령의 테스트 3개가 통과합니다.
  - 독립 재검사도 통과하며 다른 파일·모드·링크는 불변이고 최종 답은 숨은 sample입니다.
- V03 r1 — MCP 오류·도구 결과 복구
  - CLI 소유 MCP lookup이 missing의 ENOENT를 반환한 후 숨은 selected 값을 반환합니다.
  - native 도구 ID·인자·결과와 MCP ledger가 일치하며 파일·셸 우회가 없습니다.
  - 같은 프로세스·세션의 두 번째 턴에서 도구 없이 정확한 값을 회상합니다.
- V04 r1 — 모델·추론 수준 전환
  - 다른 source 모델이 응답한 후 같은 대화에서 native /model로 target을 선택합니다.
  - 각 새 응답의 요청·해석·SDK 보고 모델이 단계와 맞으며 대화 문맥이 유지됩니다.
  - 지원 모델에는 High effort가 전달되어 SDK 실제 상태와 일치하고 Haiku에는 effort를 적용하지 않습니다.
- V05 r2 — 중단 후 같은 프로세스에서 계속
  - Escape가 실제 스트리밍 요청을 중단하며 같은 요청의 client_abort와 SDK abort acknowledgment가 있고 정상 완료는 없습니다.
  - 같은 native 프로세스·세션이 후속 질문에 정확한 완료 응답을 반환합니다.
- V06 r2 — 압축·종료·콜드 재개
  - native /compact의 실제 요약 요청·압축 경계가 기록되고, seed 프롬프트 없이 압축된 기록을 받은 새 SDK 세션이 대화 전용 값을 정확히 회상합니다.
  - 정상 종료와 소유 브리지 정리 후 새 CLI·브리지가 정확한 저장 세션 ID를 재개합니다.
  - 재개 세션은 도구·보조 기억 없이 같은 값을 회상하며 후속 프롬프트에 값을 다시 넣지 않습니다.

## 단계별 증거

브리지 요청 이름과 SDK 보고 ID를 구분합니다. 연결된 SDK 기록만 처리 모델 증거이며 누락은 unknown입니다. 모델 목록 노출은 실제 실행 증거가 아닙니다.
effort는 연결된 모델 상태 기록마다 요청 / 적용 / 관측을 표시합니다. "요청 없음"은 요청에 effort가 없었음을, "적용 없음"은 브리지가 적용하지 않았음을, "SDK 미보고"는 SDK 모델 상태에 reasoningEffort가 없었음을, "관측 실패 (사유)"는 기록된 사유로 모델 상태 조회가 실패했음을, "모델 상태 없음"은 연결된 기록이 없음을, "unknown"은 저장 기록에 해당 필드가 없음을 뜻합니다. 값을 채워 넣지 않습니다.
| 모델 / 케이스 | 단계 | 결과 | 브리지 요청 이름 | SDK 보고 ID | effort 요청 / 적용 / 관측 |
| --- | --- | --- | --- | --- | --- |
| claude-opus-5.5 / V01 | print | PASS | claude-opus-5-5 | claude-opus-5.5 | medium / medium / medium |
| claude-opus-5.5 / V01 | unicode | PASS | claude-opus-5-5 | claude-opus-5.5 | medium / medium / medium |
| claude-opus-5.5 / V01 | clear | PASS | claude-opus-5-5 | claude-opus-5.5 | medium / medium / medium |
| claude-opus-5.5 / V02 | coding | PASS | claude-opus-5-5 | claude-opus-5.5 | medium / medium / medium; medium / medium / medium; medium / medium / medium; medium / medium / medium; medium / medium / medium |
| claude-opus-5.5 / V03 | lookup | PASS | claude-opus-5-5 | claude-opus-5.5 | medium / medium / medium; medium / medium / medium; medium / medium / medium |
| claude-opus-5.5 / V03 | recall | PASS | claude-opus-5-5 | claude-opus-5.5 | medium / medium / medium |
| claude-opus-5.5 / V04 | source | PASS | github-copilot/claude-gpt-6-astra | gpt-6-astra | high / high / high |
| claude-opus-5.5 / V04 | target | PASS | claude-opus-5-5 | claude-opus-5.5 | high / high / high |
| claude-opus-5.5 / V05 | interrupt | PASS | claude-opus-5-5 | unknown | 모델 상태 없음 |
| claude-opus-5.5 / V05 | recovery | PASS | claude-opus-5-5 | claude-opus-5.5 | medium / medium / medium |
| claude-opus-5.5 / V06 | seed | PASS | claude-opus-5-5 | claude-opus-5.5 | medium / medium / medium |
| claude-opus-5.5 / V06 | compact | PASS | claude-opus-5-5 | claude-opus-5.5 | 모델 상태 없음 |
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
| claude-sonnet-5 / V05 | interrupt | PASS | claude-sonnet-5 | unknown | 모델 상태 없음 |
| claude-sonnet-5 / V05 | recovery | PASS | claude-sonnet-5 | claude-sonnet-5 | high / high / high |
| claude-sonnet-5 / V06 | seed | PASS | claude-sonnet-5 | claude-sonnet-5 | high / high / high |
| claude-sonnet-5 / V06 | compact | PASS | claude-sonnet-5 | claude-sonnet-5 | 모델 상태 없음 |
| claude-sonnet-5 / V06 | recall | PASS | claude-sonnet-5 | claude-sonnet-5 | high / high / high |
| claude-sonnet-5 / V06 | resume | PASS | claude-sonnet-5 | claude-sonnet-5 | high / high / high |
| claude-haiku-4.5 / V01 | print | PASS | claude-haiku-4-5 | claude-haiku-4.5 | 요청 없음 / 적용 없음 / SDK 미보고 |
| claude-haiku-4.5 / V01 | unicode | PASS | claude-haiku-4-5 | claude-haiku-4.5 | 요청 없음 / 적용 없음 / SDK 미보고 |
| claude-haiku-4.5 / V01 | clear | PASS | claude-haiku-4-5 | claude-haiku-4.5 | 요청 없음 / 적용 없음 / SDK 미보고 |
| claude-haiku-4.5 / V02 | coding | FAIL | claude-haiku-4-5 | claude-haiku-4.5 | 요청 없음 / 적용 없음 / SDK 미보고; 요청 없음 / 적용 없음 / SDK 미보고; 요청 없음 / 적용 없음 / SDK 미보고; 요청 없음 / 적용 없음 / SDK 미보고; 요청 없음 / 적용 없음 / SDK 미보고 |
| claude-haiku-4.5 / V03 | lookup | PASS | claude-haiku-4-5 | claude-haiku-4.5 | 요청 없음 / 적용 없음 / SDK 미보고; 요청 없음 / 적용 없음 / SDK 미보고; 요청 없음 / 적용 없음 / SDK 미보고 |
| claude-haiku-4.5 / V03 | recall | PASS | claude-haiku-4-5 | claude-haiku-4.5 | 요청 없음 / 적용 없음 / SDK 미보고 |
| claude-haiku-4.5 / V04 | source | PASS | github-copilot/claude-gpt-6-astra | gpt-6-astra | high / high / high |
| claude-haiku-4.5 / V04 | target | PASS | claude-haiku-4-5 | claude-haiku-4.5 | 요청 없음 / 적용 없음 / SDK 미보고 |
| claude-haiku-4.5 / V05 | interrupt | PASS | claude-haiku-4-5 | unknown | 모델 상태 없음 |
| claude-haiku-4.5 / V05 | recovery | PASS | claude-haiku-4-5 | claude-haiku-4.5 | 요청 없음 / 적용 없음 / SDK 미보고 |
| claude-haiku-4.5 / V06 | seed | PASS | claude-haiku-4-5 | claude-haiku-4.5 | 요청 없음 / 적용 없음 / SDK 미보고 |
| claude-haiku-4.5 / V06 | compact | PASS | claude-haiku-4-5 | claude-haiku-4.5 | 모델 상태 없음 |
| claude-haiku-4.5 / V06 | recall | PASS | claude-haiku-4-5 | claude-haiku-4.5 | 요청 없음 / 적용 없음 / SDK 미보고 |
| claude-haiku-4.5 / V06 | resume | PASS | claude-haiku-4-5 | claude-haiku-4.5 | 요청 없음 / 적용 없음 / SDK 미보고 |
| gpt-6-astra / V01 | print | PASS | github-copilot/claude-gpt-6-astra | gpt-6-astra | high / high / high |
| gpt-6-astra / V01 | unicode | PASS | github-copilot/claude-gpt-6-astra | gpt-6-astra | high / high / high |
| gpt-6-astra / V01 | clear | PASS | github-copilot/claude-gpt-6-astra | gpt-6-astra | high / high / high |
| gpt-6-astra / V02 | coding | PASS | github-copilot/claude-gpt-6-astra | gpt-6-astra | high / high / high; high / high / high; high / high / high; high / high / high; high / high / high; high / high / high; high / high / high |
| gpt-6-astra / V03 | lookup | PASS | github-copilot/claude-gpt-6-astra | gpt-6-astra | high / high / high; high / high / high; high / high / high |
| gpt-6-astra / V03 | recall | PASS | github-copilot/claude-gpt-6-astra | gpt-6-astra | high / high / high |
| gpt-6-astra / V04 | source | PASS | github-copilot/claude-gpt-6-luna | gpt-6-luna | high / high / high |
| gpt-6-astra / V04 | target | PASS | github-copilot/claude-gpt-6-astra | gpt-6-astra | high / high / high |
| gpt-6-astra / V05 | interrupt | PASS | github-copilot/claude-gpt-6-astra | unknown | 모델 상태 없음 |
| gpt-6-astra / V05 | recovery | PASS | github-copilot/claude-gpt-6-astra | gpt-6-astra | high / high / high |
| gpt-6-astra / V06 | seed | PASS | github-copilot/claude-gpt-6-astra | gpt-6-astra | high / high / high |
| gpt-6-astra / V06 | compact | PASS | github-copilot/claude-gpt-6-astra | gpt-6-astra | 모델 상태 없음 |
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
| gpt-6-sol / V05 | interrupt | PASS | github-copilot/claude-gpt-6-sol | unknown | 모델 상태 없음 |
| gpt-6-sol / V05 | recovery | PASS | github-copilot/claude-gpt-6-sol | gpt-6-sol | high / high / high |
| gpt-6-sol / V06 | seed | PASS | github-copilot/claude-gpt-6-sol | gpt-6-sol | high / high / high |
| gpt-6-sol / V06 | compact | PASS | github-copilot/claude-gpt-6-sol | gpt-6-sol | 모델 상태 없음 |
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
| gpt-6-luna / V05 | interrupt | PASS | github-copilot/claude-gpt-6-luna | unknown | 모델 상태 없음 |
| gpt-6-luna / V05 | recovery | PASS | github-copilot/claude-gpt-6-luna | gpt-6-luna | high / high / high |
| gpt-6-luna / V06 | seed | PASS | github-copilot/claude-gpt-6-luna | gpt-6-luna | high / high / high |
| gpt-6-luna / V06 | compact | PASS | github-copilot/claude-gpt-6-luna | gpt-6-luna | 모델 상태 없음 |
| gpt-6-luna / V06 | recall | PASS | github-copilot/claude-gpt-6-luna | gpt-6-luna | high / high / high |
| gpt-6-luna / V06 | resume | PASS | github-copilot/claude-gpt-6-luna | gpt-6-luna | high / high / high |

## 실행 메타데이터

run: .verify-runs/2026-09-25T09-55-54-058Z-9bdbc340
Claude Code: 2.1.282 (~/.local/share/claude/versions/2.1.282); SHA256 fcfd837103965c64de34a6b9b94370d77a347ea71819715a27d5f0ef01775ea4; end SHA256 fcfd837103965c64de34a6b9b94370d77a347ea71819715a27d5f0ef01775ea4
Copilot SDK (@github/copilot-sdk) 패키지 버전: 1.0.14; 실행 시작 시 기록한 npm 패키지 버전이며 Copilot 런타임 실행 파일 식별 정보가 아닙니다
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
슬롯마다 CLI 실행별 종료 코드·시그널·강제 종료·SIGKILL 승격과 소유 프로세스 회수 여부, 소유 브리지별 정지 기록과 /health 요약을 표시합니다. 전체 /health 기록은 slots.jsonl에 있습니다.
claude-opus-5.5 V01: seconds 25.7
  CLI 1: PID 21809; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 남은 PID unknown)
  CLI 2: PID 21910; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 헬퍼 종료 예; 남은 PID 없음)
  브리지 1 /health: ok 예; instance verify-claude-opus-5.5-57446-10328302e4f3; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 21804; port 57446; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/claude-opus-5.5__V01/bridge.log
  브리지 정지 1: PID 21804; 그룹 종료 예; 포트 해제 예; 종료 코드 0; 시그널 없음
claude-opus-5.5 V02: seconds 24.8
  CLI 1: PID 22140; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 남은 PID unknown)
  브리지 1 /health: ok 예; instance verify-claude-opus-5.5-57481-21c8645a6251; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 22137; port 57481; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/claude-opus-5.5__V02/bridge.log
  브리지 정지 1: PID 22137; 그룹 종료 예; 포트 해제 예; 종료 코드 0; 시그널 없음
claude-opus-5.5 V03: seconds 24.5
  CLI 1: PID 22296; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 헬퍼 종료 예; 남은 PID 없음)
  브리지 1 /health: ok 예; instance verify-claude-opus-5.5-57540-7aa10ea60457; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 22281; port 57540; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/claude-opus-5.5__V03/bridge.log
  브리지 정지 1: PID 22281; 그룹 종료 예; 포트 해제 예; 종료 코드 0; 시그널 없음
claude-opus-5.5 V04: seconds 20.7
  CLI 1: PID 22523; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 헬퍼 종료 예; 남은 PID 없음)
  브리지 1 /health: ok 예; instance verify-gpt-6-astra-57571-fc957546c704; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 22508; port 57571; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/claude-opus-5.5__V04/bridge.log
  브리지 정지 1: PID 22508; 그룹 종료 예; 포트 해제 예; 종료 코드 0; 시그널 없음
claude-opus-5.5 V05: seconds 18.9
  CLI 1: PID 22767; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 헬퍼 종료 예; 남은 PID 없음)
  브리지 1 /health: ok 예; instance verify-claude-opus-5.5-57596-9e997bd3075f; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 22752; port 57596; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/claude-opus-5.5__V05/bridge.log
  브리지 정지 1: PID 22752; 그룹 종료 예; 포트 해제 예; 종료 코드 0; 시그널 없음
claude-opus-5.5 V06: seconds 43.2
  CLI 1: PID 22968; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 헬퍼 종료 예; 남은 PID 없음)
  CLI 2: PID 23275; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 헬퍼 종료 예; 남은 PID 없음)
  브리지 1 /health: ok 예; instance verify-claude-opus-5.5-57620-978813c701d0; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 22953; port 57620; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/claude-opus-5.5__V06/bridge.log
  브리지 2 /health: ok 예; instance verify-claude-opus-5.5-57650-2cdb7dccfb28; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 23260; port 57650; 전체 기록 slots.jsonl bridges[1].health; 로그 slots/claude-opus-5.5__V06/bridge-2.log
  브리지 정지 1: PID 22953; 그룹 종료 예; 포트 해제 예; 종료 코드 0; 시그널 없음
  브리지 정지 2: PID 23260; 그룹 종료 예; 포트 해제 예; 종료 코드 0; 시그널 없음
claude-sonnet-5 V01: seconds 23.7
  CLI 1: PID 23403; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 남은 PID unknown)
  CLI 2: PID 23505; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 헬퍼 종료 예; 남은 PID 없음)
  브리지 1 /health: ok 예; instance verify-claude-sonnet-5-57671-8c1fd3783ddb; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 23400; port 57671; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/claude-sonnet-5__V01/bridge.log
  브리지 정지 1: PID 23400; 그룹 종료 예; 포트 해제 예; 종료 코드 0; 시그널 없음
claude-sonnet-5 V02: seconds 19.7
  CLI 1: PID 23735; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 남은 PID unknown)
  브리지 1 /health: ok 예; instance verify-claude-sonnet-5-57697-cdc7c6d71397; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 23732; port 57697; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/claude-sonnet-5__V02/bridge.log
  브리지 정지 1: PID 23732; 그룹 종료 예; 포트 해제 예; 종료 코드 0; 시그널 없음
claude-sonnet-5 V03: seconds 20.9
  CLI 1: PID 23879; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 헬퍼 종료 예; 남은 PID 없음)
  브리지 1 /health: ok 예; instance verify-claude-sonnet-5-57722-b95773a85751; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 23864; port 57722; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/claude-sonnet-5__V03/bridge.log
  브리지 정지 1: PID 23864; 그룹 종료 예; 포트 해제 예; 종료 코드 없음; 시그널 SIGKILL
claude-sonnet-5 V04: seconds 20.8
  CLI 1: PID 24072; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 헬퍼 종료 예; 남은 PID 없음)
  브리지 1 /health: ok 예; instance verify-gpt-6-astra-57751-b429e4c35289; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 24057; port 57751; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/claude-sonnet-5__V04/bridge.log
  브리지 정지 1: PID 24057; 그룹 종료 예; 포트 해제 예; 종료 코드 없음; 시그널 SIGKILL
claude-sonnet-5 V05: seconds 19.8
  CLI 1: PID 24339; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 헬퍼 종료 예; 남은 PID 없음)
  브리지 1 /health: ok 예; instance verify-claude-sonnet-5-57774-a135e23db32b; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 24324; port 57774; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/claude-sonnet-5__V05/bridge.log
  브리지 정지 1: PID 24324; 그룹 종료 예; 포트 해제 예; 종료 코드 0; 시그널 없음
claude-sonnet-5 V06: seconds 44.7
  CLI 1: PID 24544; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 헬퍼 종료 예; 남은 PID 없음)
  CLI 2: PID 24902; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 헬퍼 종료 예; 남은 PID 없음)
  브리지 1 /health: ok 예; instance verify-claude-sonnet-5-57803-292c4d7b7f50; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 24512; port 57803; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/claude-sonnet-5__V06/bridge.log
  브리지 2 /health: ok 예; instance verify-claude-sonnet-5-57847-7f0f6cb59ef4; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 24886; port 57847; 전체 기록 slots.jsonl bridges[1].health; 로그 slots/claude-sonnet-5__V06/bridge-2.log
  브리지 정지 1: PID 24512; 그룹 종료 예; 포트 해제 예; 종료 코드 0; 시그널 없음
  브리지 정지 2: PID 24886; 그룹 종료 예; 포트 해제 예; 종료 코드 0; 시그널 없음
claude-haiku-4.5 V01: seconds 25.4
  CLI 1: PID 25040; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 남은 PID unknown)
  CLI 2: PID 25142; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 헬퍼 종료 예; 남은 PID 없음)
  브리지 1 /health: ok 예; instance verify-claude-haiku-4.5-57870-1133d86f756e; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 25035; port 57870; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/claude-haiku-4.5__V01/bridge.log
  브리지 정지 1: PID 25035; 그룹 종료 예; 포트 해제 예; 종료 코드 0; 시그널 없음
claude-haiku-4.5 V02: seconds 19.8
  CLI 1: PID 25374; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 남은 PID unknown)
  브리지 1 /health: ok 예; instance verify-claude-haiku-4.5-57898-b8769dbf56e2; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 25370; port 57898; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/claude-haiku-4.5__V02/bridge.log
  브리지 정지 1: PID 25370; 그룹 종료 예; 포트 해제 예; 종료 코드 0; 시그널 없음
claude-haiku-4.5 V03: seconds 21.3
  CLI 1: PID 25521; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 헬퍼 종료 예; 남은 PID 없음)
  브리지 1 /health: ok 예; instance verify-claude-haiku-4.5-57922-2281da602616; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 25503; port 57922; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/claude-haiku-4.5__V03/bridge.log
  브리지 정지 1: PID 25503; 그룹 종료 예; 포트 해제 예; 종료 코드 0; 시그널 없음
claude-haiku-4.5 V04: seconds 23.6
  CLI 1: PID 25748; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 헬퍼 종료 예; 남은 PID 없음)
  브리지 1 /health: ok 예; instance verify-gpt-6-astra-57947-7bdba49069f4; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 25716; port 57947; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/claude-haiku-4.5__V04/bridge.log
  브리지 정지 1: PID 25716; 그룹 종료 예; 포트 해제 예; 종료 코드 0; 시그널 없음
claude-haiku-4.5 V05: seconds 18.9
  CLI 1: PID 25998; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 헬퍼 종료 예; 남은 PID 없음)
  브리지 1 /health: ok 예; instance verify-claude-haiku-4.5-57971-55fd5b6375be; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 25982; port 57971; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/claude-haiku-4.5__V05/bridge.log
  브리지 정지 1: PID 25982; 그룹 종료 예; 포트 해제 예; 종료 코드 0; 시그널 없음
claude-haiku-4.5 V06: seconds 44.2
  CLI 1: PID 26210; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 헬퍼 종료 예; 남은 PID 없음)
  CLI 2: PID 26523; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 헬퍼 종료 예; 남은 PID 없음)
  브리지 1 /health: ok 예; instance verify-claude-haiku-4.5-57995-ea9c3d902c69; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 26195; port 57995; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/claude-haiku-4.5__V06/bridge.log
  브리지 2 /health: ok 예; instance verify-claude-haiku-4.5-58018-7e24adfe0ff7; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 26508; port 58018; 전체 기록 slots.jsonl bridges[1].health; 로그 slots/claude-haiku-4.5__V06/bridge-2.log
  브리지 정지 1: PID 26195; 그룹 종료 예; 포트 해제 예; 종료 코드 0; 시그널 없음
  브리지 정지 2: PID 26508; 그룹 종료 예; 포트 해제 예; 종료 코드 0; 시그널 없음
gpt-6-astra V01: seconds 28.6
  CLI 1: PID 26651; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 남은 PID unknown)
  CLI 2: PID 26753; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 헬퍼 종료 예; 남은 PID 없음)
  브리지 1 /health: ok 예; instance verify-gpt-6-astra-58039-62908fd6fd05; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 26648; port 58039; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/gpt-6-astra__V01/bridge.log
  브리지 정지 1: PID 26648; 그룹 종료 예; 포트 해제 예; 종료 코드 없음; 시그널 SIGKILL
gpt-6-astra V02: seconds 28.3
  CLI 1: PID 27007; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 남은 PID unknown)
  브리지 1 /health: ok 예; instance verify-gpt-6-astra-58068-89ee1a53a9c7; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 26993; port 58068; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/gpt-6-astra__V02/bridge.log
  브리지 정지 1: PID 26993; 그룹 종료 예; 포트 해제 예; 종료 코드 0; 시그널 없음
gpt-6-astra V03: seconds 23.8
  CLI 1: PID 27145; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 헬퍼 종료 예; 남은 PID 없음)
  브리지 1 /health: ok 예; instance verify-gpt-6-astra-58094-00da2c34004a; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 27129; port 58094; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/gpt-6-astra__V03/bridge.log
  브리지 정지 1: PID 27129; 그룹 종료 예; 포트 해제 예; 종료 코드 0; 시그널 없음
gpt-6-astra V04: seconds 20.6
  CLI 1: PID 27364; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 헬퍼 종료 예; 남은 PID 없음)
  브리지 1 /health: ok 예; instance verify-gpt-6-luna-58125-d8c0bb814136; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 27349; port 58125; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/gpt-6-astra__V04/bridge.log
  브리지 정지 1: PID 27349; 그룹 종료 예; 포트 해제 예; 종료 코드 0; 시그널 없음
gpt-6-astra V05: seconds 20.4
  CLI 1: PID 27620; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 헬퍼 종료 예; 남은 PID 없음)
  브리지 1 /health: ok 예; instance verify-gpt-6-astra-58146-377cd32d3100; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 27605; port 58146; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/gpt-6-astra__V05/bridge.log
  브리지 정지 1: PID 27605; 그룹 종료 예; 포트 해제 예; 종료 코드 0; 시그널 없음
gpt-6-astra V06: seconds 73.6
  CLI 1: PID 27847; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 헬퍼 종료 예; 남은 PID 없음)
  CLI 2: PID 28312; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 헬퍼 종료 예; 남은 PID 없음)
  브리지 1 /health: ok 예; instance verify-gpt-6-astra-58172-78d57236da04; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 27831; port 58172; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/gpt-6-astra__V06/bridge.log
  브리지 2 /health: ok 예; instance verify-gpt-6-astra-58208-b25533d4f3b1; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 28297; port 58208; 전체 기록 slots.jsonl bridges[1].health; 로그 slots/gpt-6-astra__V06/bridge-2.log
  브리지 정지 1: PID 27831; 그룹 종료 예; 포트 해제 예; 종료 코드 0; 시그널 없음
  브리지 정지 2: PID 28297; 그룹 종료 예; 포트 해제 예; 종료 코드 0; 시그널 없음
gpt-6-sol V01: seconds 26.0
  CLI 1: PID 28446; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 남은 PID unknown)
  CLI 2: PID 28551; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 헬퍼 종료 예; 남은 PID 없음)
  브리지 1 /health: ok 예; instance verify-gpt-6-sol-58230-73a8d548d566; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 28441; port 58230; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/gpt-6-sol__V01/bridge.log
  브리지 정지 1: PID 28441; 그룹 종료 예; 포트 해제 예; 종료 코드 없음; 시그널 SIGKILL
gpt-6-sol V02: seconds 25.6
  CLI 1: PID 28783; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 남은 PID unknown)
  브리지 1 /health: ok 예; instance verify-gpt-6-sol-58259-259feef9b440; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 28780; port 58259; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/gpt-6-sol__V02/bridge.log
  브리지 정지 1: PID 28780; 그룹 종료 예; 포트 해제 예; 종료 코드 0; 시그널 없음
gpt-6-sol V03: seconds 20.6
  CLI 1: PID 28935; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 헬퍼 종료 예; 남은 PID 없음)
  브리지 1 /health: ok 예; instance verify-gpt-6-sol-58282-844fdfc100c8; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 28907; port 58282; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/gpt-6-sol__V03/bridge.log
  브리지 정지 1: PID 28907; 그룹 종료 예; 포트 해제 예; 종료 코드 0; 시그널 없음
gpt-6-sol V04: seconds 21.9
  CLI 1: PID 29129; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 헬퍼 종료 예; 남은 PID 없음)
  브리지 1 /health: ok 예; instance verify-gpt-6-astra-58303-ef64a367b038; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 29114; port 58303; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/gpt-6-sol__V04/bridge.log
  브리지 정지 1: PID 29114; 그룹 종료 예; 포트 해제 예; 종료 코드 0; 시그널 없음
gpt-6-sol V05: seconds 19.6
  CLI 1: PID 29387; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 헬퍼 종료 예; 남은 PID 없음)
  브리지 1 /health: ok 예; instance verify-gpt-6-sol-58325-68410b6565d2; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 29372; port 58325; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/gpt-6-sol__V05/bridge.log
  브리지 정지 1: PID 29372; 그룹 종료 예; 포트 해제 예; 종료 코드 0; 시그널 없음
gpt-6-sol V06: seconds 55.7
  CLI 1: PID 29583; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 헬퍼 종료 예; 남은 PID 없음)
  CLI 2: PID 29952; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 헬퍼 종료 예; 남은 PID 없음)
  브리지 1 /health: ok 예; instance verify-gpt-6-sol-58353-1232909abca9; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 29568; port 58353; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/gpt-6-sol__V06/bridge.log
  브리지 2 /health: ok 예; instance verify-gpt-6-sol-58383-b0c303447bdd; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 29937; port 58383; 전체 기록 slots.jsonl bridges[1].health; 로그 slots/gpt-6-sol__V06/bridge-2.log
  브리지 정지 1: PID 29568; 그룹 종료 예; 포트 해제 예; 종료 코드 0; 시그널 없음
  브리지 정지 2: PID 29937; 그룹 종료 예; 포트 해제 예; 종료 코드 없음; 시그널 SIGKILL
gpt-6-luna V01: seconds 23.6
  CLI 1: PID 30094; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 남은 PID unknown)
  CLI 2: PID 30204; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 헬퍼 종료 예; 남은 PID 없음)
  브리지 1 /health: ok 예; instance verify-gpt-6-luna-58401-b3dce0988bf0; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 30091; port 58401; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/gpt-6-luna__V01/bridge.log
  브리지 정지 1: PID 30091; 그룹 종료 예; 포트 해제 예; 종료 코드 0; 시그널 없음
gpt-6-luna V02: seconds 19.6
  CLI 1: PID 30430; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 남은 PID unknown)
  브리지 1 /health: ok 예; instance verify-gpt-6-luna-58435-982aa7375607; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 30427; port 58435; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/gpt-6-luna__V02/bridge.log
  브리지 정지 1: PID 30427; 그룹 종료 예; 포트 해제 예; 종료 코드 0; 시그널 없음
gpt-6-luna V03: seconds 20.5
  CLI 1: PID 30552; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 헬퍼 종료 예; 남은 PID 없음)
  브리지 1 /health: ok 예; instance verify-gpt-6-luna-58460-3c127a774746; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 30537; port 58460; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/gpt-6-luna__V03/bridge.log
  브리지 정지 1: PID 30537; 그룹 종료 예; 포트 해제 예; 종료 코드 0; 시그널 없음
gpt-6-luna V04: seconds 22.2
  CLI 1: PID 30758; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 헬퍼 종료 예; 남은 PID 없음)
  브리지 1 /health: ok 예; instance verify-gpt-6-astra-58484-3657cb3a638e; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 30742; port 58484; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/gpt-6-luna__V04/bridge.log
  브리지 정지 1: PID 30742; 그룹 종료 예; 포트 해제 예; 종료 코드 0; 시그널 없음
gpt-6-luna V05: seconds 20.9
  CLI 1: PID 31050; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 헬퍼 종료 예; 남은 PID 없음)
  브리지 1 /health: ok 예; instance verify-gpt-6-luna-58562-cb16ab2850e8; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 31035; port 58562; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/gpt-6-luna__V05/bridge.log
  브리지 정지 1: PID 31035; 그룹 종료 예; 포트 해제 예; 종료 코드 없음; 시그널 SIGKILL
gpt-6-luna V06: seconds 44.3
  CLI 1: PID 31252; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 헬퍼 종료 예; 남은 PID 없음)
  CLI 2: PID 31567; 종료 코드 0; 시그널 없음; 강제 종료 아니오; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 헬퍼 종료 예; 남은 PID 없음)
  브리지 1 /health: ok 예; instance verify-gpt-6-luna-58600-06407f29d94e; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 31237; port 58600; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/gpt-6-luna__V06/bridge.log
  브리지 2 /health: ok 예; instance verify-gpt-6-luna-58629-3b9c24c16ff0; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 31552; port 58629; 전체 기록 slots.jsonl bridges[1].health; 로그 slots/gpt-6-luna__V06/bridge-2.log
  브리지 정지 1: PID 31237; 그룹 종료 예; 포트 해제 예; 종료 코드 0; 시그널 없음
  브리지 정지 2: PID 31552; 그룹 종료 예; 포트 해제 예; 종료 코드 0; 시그널 없음
슬롯 예산은 단계마다 갱신하지 않는 전체 deadline입니다. 런타임 예산은 배율 변경 없이 기록합니다. 현재 의존성·환경·설치 실행 파일에서 메타데이터를 채우지 않습니다.

## 증거와 재현

저장소 루트에서 실행하세요. 명시한 저장 실행을 읽을 때 모델을 호출하지 않습니다. 리포터는 저장된 PASS 슬롯의 원본 증거를 현재 체크아웃의 평가기로 재판정하며 저장된 실패를 올리지 않습니다. 동결된 소스 사본(sources/files/)은 재현 자료이며 리포터는 해시만 검사하고 실행하지 않습니다.
```bash
node scripts/verify/report.mjs '.verify-runs/2026-09-25T09-55-54-058Z-9bdbc340'
```
```bash
npm run verify:doc -- '.verify-runs/2026-09-25T09-55-54-058Z-9bdbc340'
```
소스 사본에 자격 증명·설정·이전 실행 증거를 넣지 않습니다. private 설정에는 임시 브리지 키가 있고 원본 transcript에는 민감한 정보가 있을 수 있습니다. 공유 전 검토하세요.
실행 디렉터리 안의 경로는 그 디렉터리 기준 상대 경로로 표시합니다. 이 문서에서 ~와 $HOME은 홈 디렉터리, $TMPDIR은 사용자별 임시 디렉터리이며 Claude 프로젝트 디렉터리 이름 안의 -HOME / -TMPDIR은 각각 이를 뜻합니다.
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

미리보기: 실행 파일·인증·연결 검사와 SDK 메타데이터 조회 없음.
```bash
CLAUDE_CODE_BIN="$HOME/.local/share/claude/versions/2.1.282" PENDING_TOOL_WAIT_MS='30000' npm run verify -- --model-concurrency '1' --timeout-scale '2' --models 'claude-opus-5.5,claude-sonnet-5,claude-haiku-4.5,gpt-6-astra,gpt-6-sol,gpt-6-luna' --scenarios 'V01,V02,V03,V04,V05,V06' --dry-run
```
선택 사항인 새 실제 실행: 실제 Copilot 사용량을 소비합니다. 동결된 작업 트리 소스와 기록된 의존성/실행 파일을 먼저 맞추세요. dirty 커밋만으로 실행한 코드를 복원할 수 없습니다. 명령은 기본값과 다른 기록된 런타임 예산을 그대로 지정합니다. 이 명령은 새 실행을 만들며 저장 증거를 덮어쓰지 않습니다.
```bash
CLAUDE_CODE_BIN="$HOME/.local/share/claude/versions/2.1.282" PENDING_TOOL_WAIT_MS='30000' npm run verify -- --model-concurrency '1' --timeout-scale '2' --models 'claude-opus-5.5,claude-sonnet-5,claude-haiku-4.5,gpt-6-astra,gpt-6-sol,gpt-6-luna' --scenarios 'V01,V02,V03,V04,V05,V06'
```

## 한계

여섯 케이스는 gate 통과 시 private CLI 실행·Unicode/clear·코딩 도구·선언된 MCP 복구·모델/effort 전환·활성 응답 중단·명시적 압축/콜드 재개를 다룹니다. 최대 context·자동 압축 한계·모든 순간의 프로세스 격리·제공자 내부·임의 플러그인/훅/서브에이전트·권한 UI·미디어·production 런처/공유 데몬·LiteLLM을 증명하지 않습니다. production 오프라인 테스트는 별도이며 결과는 기록된 코드·실행 파일·호스트·모델·설정에만 해당합니다.
