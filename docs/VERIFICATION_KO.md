# 검증 결과: Copilot 모델 6개, 66개 슬롯 중 66개 통과

<!-- scripts/verify/report.mjs가 생성하는 파일입니다. 다시 생성하면 덮어쓰므로 직접 고치지 마세요. -->

> **언어 / Language:** [English](VERIFICATION.md) | 한국어

**PASS.** 66개 슬롯이 모두 통과했습니다. 기록된 검사 1,146개 중 실패한 검사는 없습니다.

슬롯은 Copilot 모델 하나가 시나리오 하나를 실행하는 단위이며, 이 실행은 모델 6개 × 시나리오 11개입니다.

- 코드: 커밋 `bed30ce`. 커밋하지 않은 변경이 없었습니다. 실행하는 동안 코드가 바뀌지 않았습니다.
- Claude Code: 2.1.280.
- 브리지 설정(모든 브리지 공통): `PENDING_TOOL_WAIT_MS=30000`, 기본값은 10000입니다.
- 검증 하네스: `--timeout-scale 2`, 모델 3개 병렬, 모델마다 시나리오 2개 병렬. 기록된 설정 전체는 [이 실행의 설정](#이-실행의-설정)에 있습니다.
- 실행: 2026-09-23T09:11:26.241Z부터 2026-09-23T09:19:25.033Z까지 479초. 호스트: darwin arm64, Node v22.16.0.

## 슬롯 실행 방식

- **v01–v10.** 검증 하네스가 슬롯의 모델에 맞춘 브리지(`node src/server.mjs`, 비어 있는 로컬 포트)를 띄우고, 런처가 쓰는 것과 같은 `src/write-launch-settings.mjs`로 Claude Code 설정 파일을 만듭니다. 그다음 설치된 `claude` 바이너리를 print 모드(`-p`, stream-json 출력)로 실행하면서 `--settings`로 그 파일을 넘깁니다. 슬롯마다 브리지, 작업 폴더, Claude Code 설정 폴더가 따로 있습니다.
- **v11.** 하네스가 사용자처럼 `bin/claude-ghcp`를 실행합니다. 상주 브리지 데몬을 띄우는 `--background` 실행, 자체 브리지를 쓰는 `-p` 실행, 데몬을 거치는 `agents` 실행입니다.

LiteLLM을 거치는 슬롯은 없고, 모의 응답이나 대체 구현도 쓰지 않습니다. 모든 모델 턴은 GitHub Copilot으로 갑니다.

검사는 디스크의 파일, git 이력, 훅 로그, Claude Code의 stream-json 출력(init 이벤트, 도구 호출, 도구 결과, 마지막 result 이벤트)을 읽습니다. v11 검사는 런처, `claude-ghcp-status`, `claude-ghcp-stop`, `claude agents`의 출력과 데몬 폴더도 읽습니다. 모델의 답을 읽는 검사는 하네스가 심어 둔 값을 찾습니다. 예외는 두 가지입니다. v05는 모든 단계를 마쳤다는 주장을 파일과 대조하고, v08은 명령이 차단되었다는 말이 답에 있어야 합니다.

v01–v10의 Claude Code 실행에는 모두 아래 검사가 더 붙습니다. 한 슬롯은 Claude Code를 1–3회 실행합니다.

1. 제한 시간 안에 result 이벤트로 끝났습니다.
2. 모든 tool_use에 tool_result가 있고, 모든 tool_result에 tool_use가 있습니다.
3. `modelUsage`에 슬롯의 모델이나 Claude Code를 실행할 때 쓴 별칭이 있습니다.
4. result 이벤트에 `stop_reason`이나 `subtype`이 있습니다.
5. usage의 입력 토큰이 0보다 큽니다.
6. result가 오류가 아닙니다.

1–3번 중 하나라도 실패하면 슬롯은 BLOCK입니다. 판정할 수 없다는 뜻이며 미통과로 셉니다. 브리지가 끝내 정상 응답을 하지 않는 것처럼 검증 하네스 자체가 실패해도 BLOCK입니다. 4–6번 중 하나라도 실패하면 FAIL입니다. v09는 첫 번째 실행이 통과하지 못하면 멈추고, 건너뛴 두 실행 때문에 슬롯은 BLOCK이 됩니다. v11은 Claude Code의 stream-json 출력을 읽지 않으므로 이 검사가 없습니다. 대신 런처의 종료 코드와 출력, 데몬 상태, 백그라운드 에이전트가 쓴 파일을 검사합니다.

## 이 실행으로 검증하지 않은 것

통과한 실행이라도 아래 내용은 보여 주지 않습니다.

- **업스트림 오류.** Copilot 실패를 일부러 일으키는 슬롯이 없습니다. 브리지의 429(요청 한도)와 529(과부하) 응답은 이 실행이 아니라 `npm test`가 확인합니다.
- **컨텍스트 한도 오류와 압축.** 모델의 컨텍스트 창을 채우는 시나리오가 없습니다. 그래서 브리지의 컨텍스트 한도 오류와 그 뒤에 Claude Code가 하는 압축이 일어나지 않습니다.
- **대화형 세션.** v01–v10은 Claude Code를 모두 print 모드(`-p`)로 실행합니다. v11은 런처를 `--background`, `-p`, `agents`로 실행합니다. 대화형 터미널 화면, `/rewind`, Esc 취소는 다루지 않습니다.
- **권한 확인 창.** v01–v10은 `bypassPermissions`로 실행하고, v02의 plan 모드 턴만 예외입니다. v11에서 모델을 호출하는 실행은 `acceptEdits`로 실행합니다. 사람에게 도구 사용 승인을 묻는 확인 창은 검증하지 않습니다.
- **실제로 답한 Copilot 모델.** 모델 검사는 `modelUsage`를 읽는데, 여기에는 Claude Code가 요청한 모델 이름이 들어 있습니다. 어떤 Copilot 모델이 턴을 처리했는지는 알 수 없습니다.
- **커스텀 명령, 스킬, 예약 작업의 실행.** v08은 이들이 Claude Code의 init 이벤트에 나오는지, 예약 작업이 만들어지고 목록에 나오는지만 확인합니다. 실제로 실행되었는지는 검사하지 않습니다.
- **세션 도중의 브리지 재시작.** v09의 처음·재개·포크 프로세스는 계속 실행 중인 브리지 하나를 함께 씁니다.
- **LiteLLM.** 모든 슬롯이 브리지에 직접 연결합니다.
- **매트릭스 밖의 모델.** 결과 표에 있는 모델만 실행했습니다.
- **브리지가 무시하거나 적용하지 못하는 요청 값.** [COMPATIBILITY_KO.md](COMPATIBILITY_KO.md#적용하지-않는-요청-값)를 보세요.
- **검사가 없는 기능과 어느 시나리오도 선언하지 않은 기능.** 둘 다 [기능 커버리지](#기능-커버리지)에 있습니다.
- **다른 호스트.** 이 실행은 이 문서 맨 위에 적은 머신 한 대에서만 돌았습니다.
- **기록한 커밋 이후의 코드.** 이 실행은 이 문서 맨 위에 적은 커밋만 검증합니다. 이후 변경과 그 변경을 확인하는 방법은 [README_KO.md](../README_KO.md#검증한-것)에 있습니다.
- **기본 `PENDING_TOOL_WAIT_MS` 값.** 이 실행의 모든 브리지는 Copilot이 도구 호출을 등록하기를 최대 30000 ms 기다렸습니다. 기본값은 10000 ms입니다.

## 결과 매트릭스

| 시나리오 | claude-opus-5.5 | claude-sonnet-5 | claude-haiku-4.5 | gpt-6-astra | gpt-6-sol | gpt-6-luna |
| --- | --- | --- | --- | --- | --- | --- |
| `v01-repo-recon` | PASS | PASS | PASS | PASS | PASS | PASS |
| `v02-surgical-edit` | PASS | PASS | PASS | PASS | PASS | PASS |
| `v03-test-fix-loop` | PASS | PASS | PASS | PASS | PASS | PASS |
| `v04-shell-ops` | PASS | PASS | PASS | PASS | PASS | PASS |
| `v05-multi-step` | PASS | PASS | PASS | PASS | PASS | PASS |
| `v06-subagent` | PASS | PASS | PASS | PASS | PASS | PASS |
| `v07-mcp-playwright` | PASS | PASS | PASS | PASS | PASS | PASS |
| `v08-hooks-memory` | PASS | PASS | PASS | PASS | PASS | PASS |
| `v09-session-resume` | PASS | PASS | PASS | PASS | PASS | PASS |
| `v10-long-context` | PASS | PASS | PASS | PASS | PASS | PASS |
| `v11-daemon-background` | PASS | PASS | PASS | PASS | PASS | PASS |

**pass 66 / fail 0 / blocked 0**, 전체 66개 슬롯.

아래 슬롯에서는 `modelUsage`에 모델이 둘 이상 있었습니다. 모델 검사는 그중 하나라도 슬롯의 모델이나 실행할 때 쓴 별칭이면 통과합니다.

- gpt-6-astra × `v01-repo-recon`: `github-copilot/claude-gpt-6-astra[1m]`, `claude-opus-5-5[1m]`

## 통과하지 못한 슬롯

없습니다.

## 시나리오

### `v01-repo-recon` — 저장소 정찰

코드를 고치기 전에 저장소에서 대상을 찾습니다. 거의 모든 세션이 이 동작으로 시작합니다.

**잡아내려는 브리지 결함:** 여러 검색 호출의 결과가 유실되거나, 짝이 어긋나거나, 순서가 바뀌어 모델이 읽지 않은 경로를 답하는 경우.

검사:

- Claude Code가 stream-json 입력을 해석하고 사용자 메시지를 되돌려 보냈습니다.
- 검색 도구(Bash, Glob, Grep, Task 중 하나)를 사용했습니다. 이 빌드에는 Glob과 Grep이 없습니다.
- 답에 상수를 정의한 파일과 그 상수의 값이 있습니다.
- 답이 미끼 파일을 가리키지 않습니다.

### `v02-surgical-edit` — 정밀 편집과 파일 생성

요청한 부분만 정확히 바꾸고 나머지는 그대로 둔 뒤 새 파일을 만듭니다. 그보다 먼저 plan 모드 턴이 실행되며, 이 턴은 파일을 바꾸면 안 됩니다.

**잡아내려는 브리지 결함:** tool_use 입력의 공백이나 줄바꿈이 정규화되어 Edit의 정확한 일치가 실패하거나, 엉뚱한 줄이 조용히 바뀌는 경우.

검사:

- plan 모드 턴이 승인을 기다리지 않고 끝났고, 요청받은 변경을 하지 않았습니다.
- 편집 턴에서 표시한 값이 새 값으로 바뀌었습니다.
- 표시한 다른 두 줄은 바뀌지 않은 채 남아 있습니다.
- 요청한 새 파일이 있고, 요청한 const를 export합니다.
- 편집 턴에서 Edit(또는 MultiEdit, NotebookEdit)를 사용했습니다.

### `v03-test-fix-loop` — 실패 테스트 진단과 수정

테스트를 실행하고, 실패를 읽고, 소스를 고친 뒤 테스트가 통과할 때까지 다시 실행하는 핵심 에이전트 루프입니다.

**잡아내려는 브리지 결함:** 실패한 테스트 실행의 tool_result가 모델에 전달되지 않아, 모델이 실패를 모른 채 일찍 멈추는 경우.

검사:

- 모델이 Bash를 호출했습니다.
- 도구 결과 중 하나에 "not ok", "fail", "AssertionError"가 있거나 오류 결과가 있고, 모델이 도구를 두 번 이상 호출했습니다. `node --test` 출력은 "# fail" 개수를 늘 찍으므로 어떤 출력이든 이 조건에 맞습니다.
- 테스트 파일은 바이트 단위로 그대로입니다.
- 검증 하네스가 테스트를 직접 다시 실행했고, 종료 코드가 0입니다.

### `v04-shell-ops` — 백그라운드 셸과 git 워크플로

명령 하나로 끝나지 않는 두 가지 셸 작업, 오래 실행되는 프로세스와 버전 관리를 다룹니다.

**잡아내려는 브리지 결함:** 길게 이어지는 셸과 git 도구 결과가 유실되거나 짝이 어긋나, 모델이 커밋, worktree 생성, ticker 종료 중 하나를 건너뛰는 경우.

검사:

- ticker 스크립트 이름이 들어가거나 백그라운드로 실행한 Bash 호출이 있고, tick 로그 파일 이름이 들어간 Bash 명령이나 Read 호출이 있습니다.
- tick 로그가 세 줄 이상이고, 기록 파일이 만들어졌습니다.
- git log에 요청한 제목과 정확히 같은 커밋이 있습니다.
- git의 worktree 목록을 읽을 수 있고, 요청한 브랜치나 EnterWorktree가 그 이름으로 만드는 브랜치에 등록된 다른 worktree가 정확히 하나 있습니다.
- 그 worktree의 디스크와 HEAD 커밋에 표식 파일이 같은 내용으로 있습니다.
- 주 체크아웃과 그 HEAD에는 표식 파일이 없습니다.
- 턴이 끝난 뒤 실행 중인 ticker 프로세스가 없습니다.

### `v05-multi-step` — 파일 종류를 넘나드는 4단계 계획

한 턴 안에서 4단계 계획을 끝까지 지킵니다. 소스 파일, 텍스트 파일, 새 마크다운 파일, 주피터 노트북을 차례로 고친 뒤, 작업 폴더의 PDF와 PNG에서 확인 문자열을 읽습니다.

**잡아내려는 브리지 결함:** tool_result 안에 담긴 PDF 페이지나 이미지가 텍스트만 옮기는 변환에서 빠지는 경우, 또는 도구 루프가 길어지며 계획이 흐트러져 마지막 단계가 조용히 빠지는 경우.

검사:

- 네 가지 변경이 모두 디스크에 반영되었습니다.
- 노트북이 여전히 nbformat 4 문서로 파싱되고, 셀의 RATE가 새 값입니다.
- 답이 모든 단계를 마쳤다고 주장하면, 네 파일이 모두 그 주장과 맞습니다.
- 답에 PDF와 PNG에 적힌 확인 문자열이 모두 있습니다. 각 문자열의 무작위 여섯 글자 중 한 글자까지는 잘못 읽어도 허용합니다.

### `v06-subagent` — 서브에이전트 위임

프로젝트에 정의한 서브에이전트에 작업을 넘기고, 돌아온 결과를 이어서 씁니다.

**잡아내려는 브리지 결함:** 중첩 세션에서 도구 루프를 돈 서브에이전트의 최종 보고가 인계 지점에서 유실되어, 부모 에이전트가 답을 지어내는 경우.

검사:

- 프로젝트에 정의한 에이전트가 init 이벤트에 나옵니다.
- Agent 도구(init 이벤트에는 Task로 표시)를 그 에이전트를 `subagent_type`으로 지정해 호출했습니다.
- 위임 호출이 오류가 아닌 tool_result를 돌려받았습니다.
- 최종 답에 표식이 든 파일이 모두 있습니다.

### `v07-mcp-playwright` — MCP 브라우저 자동화(headless Chrome)

MCP로 들어온 외부 기능을 실제로 씁니다. @playwright/mcp가 headless Chrome을 조작합니다.

**잡아내려는 브리지 결함:** MCP 도구 스키마가 브리지를 지나며 바뀌거나 이름공간이 달라져, 모델이 도구를 호출하지 못하거나 잘못된 형태로 호출하는 경우.

검사:

- init 이벤트에서 playwright MCP 서버가 연결됨으로 나옵니다.
- `mcp__playwright__*` 도구를 한 번 이상 호출했습니다.
- 하네스가 띄운 페이지에 표시된 빌드 토큰이 답에 있습니다.

### `v08-hooks-memory` — 훅·메모리·명령·스킬

프로젝트가 모델에 덧붙여 설정하는 것을 모두 씁니다. CLAUDE.md 규칙, 관찰하고 차단하는 훅, 커스텀 명령, 스킬, 플러그인, 예약 작업입니다.

**잡아내려는 브리지 결함:** 훅의 차단이 오류가 아닌 평범한 tool_result로 모델에 전달되어, 모델이 막힌 명령을 실행된 것으로 보고하는 경우.

검사:

- 감사 기록이 프롬프트가 제안한 경로가 아니라 CLAUDE.md가 정한 경로에 생겼고, 감사 토큰과 정해진 제목이 들어 있습니다.
- 훅 로그에 PreToolUse 훅과 차단 훅이 모두 실행된 기록이 있습니다.
- 금지한 `curl` 명령이 요청한 페이지가 어떤 도구 결과에도 없고, 답에 차단이나 거부를 뜻하는 말(blocked, denied, 차단, 거부 등)이 있습니다.
- 커스텀 슬래시 명령과 프로젝트 스킬이 init 이벤트에 나옵니다. Claude Code는 모델 요청 전에 로컬 파일로 이 이벤트를 만들므로, 이 검사에는 브리지가 관여하지 않습니다.
- `--plugin-dir`로 불러온 플러그인이 명령과 스킬을 하나씩 추가하고, 둘 다 init 이벤트에 나옵니다. 이 검사에도 브리지는 관여하지 않습니다.
- 두 번째 턴에서 CronCreate로 작업을 만들었고, CronList가 그 작업을 id나 프롬프트로 다시 보여 줍니다.

### `v09-session-resume` — 프로세스 간 세션 재개

Claude Code 프로세스 세 개가 브리지 하나를 차례로 씁니다. 처음 턴, `--resume` 턴, `--resume --fork-session` 턴입니다. 뒤의 두 턴은 도구나 영구 메모리 없이 처음 턴에서 준 값을 그대로 답해야 합니다. 그동안 브리지는 계속 실행 중입니다.

**잡아내려는 브리지 결함:** 브리지는 Claude Code 세션 ID와 에이전트, 모델, 도구, 시스템 프롬프트로 Copilot 세션을 찾습니다. 재개하거나 포크한 프로세스가 엉뚱한 기록에 연결되거나 아무 기록에도 연결되지 않아, 앞선 턴 없이 답하는 경우.

검사:

- 처음 턴이 하네스가 준 세션 ID로 실행되었고, 재개한 턴도 같은 ID를 유지했습니다.
- 재개한 턴이 심어 둔 빌드 ID로 답했습니다.
- 세 턴 모두 도구를 호출하지 않았습니다.
- 포크한 턴이 자기 세션 ID로 실행되면서 심어 둔 배포 시간을 답했습니다.

### `v10-long-context` — 대형 컨텍스트 검색과 추론

프롬프트에 붙여 넣은 약 108,000자 분량의 보고서에서 멀리 떨어진 두 사실을 찾아 숫자 하나로 계산합니다.

**잡아내려는 브리지 결함:** 업스트림에서 컨텍스트가 조용히 잘려, 모델이 남은 부분만 보고 자신 있게 답하는 경우. 보고서를 프롬프트에 붙여 넣으므로, 크게 잘리면 입력 토큰 수에 드러납니다.

검사:

- result에 `--json-schema`가 요구하는 숫자 `difference`를 가진 구조화 객체가 있습니다.
- 두 사실이 모두 있어야 나오는 차이 값이 정확합니다.
- 한 줄짜리 대조 턴과 비교해 입력 토큰이 보고서 추정 크기(글자 수 ÷ 4)의 절반 이상 늘었습니다.
- Read, Grep, Glob을 호출하지 않았습니다. Bash는 막지 않으며, 작업 폴더에도 보고서 사본이 있습니다.

### `v11-daemon-background` — 런처·데몬·백그라운드 에이전트

이 프로젝트가 실제로 제공하는 진입점을 씁니다. bin/claude-ghcp 런처, 런처가 남겨 두는 상주 브리지 데몬, 런처가 끝난 뒤에도 계속 응답을 받는 분리 실행 에이전트입니다.

**잡아내려는 브리지 결함:** 두 번째 실행이 살아 있는 데몬을 재사용하지 않고 경쟁 데몬을 띄우거나, 낡은 레지스트리가 죽은 포트를 넘기거나, 정지한 뒤에도 포트가 점유된 채 남는 경우. v01–v10은 슬롯마다 브리지를 따로 띄우므로 v11만 이 문제를 볼 수 있습니다.

검사:

- `bin/claude-ghcp --background`가 종료 코드 0으로 끝났고 백그라운드 세션 ID를 출력했습니다.
- `claude-ghcp-status`가 데몬이 실행 중이며 pid와 포트가 있다고 보고하고, 그 기록의 모델이 슬롯의 모델과 같습니다.
- 분리 실행한 에이전트가 검증용 파일에만 있는 값을 기록했습니다.
- `claude agents`가 슬롯 작업 폴더의 백그라운드 세션을 보여 줍니다.
- 자체 브리지를 쓰는 print 모드(`-p`) 실행이 종료 코드 0으로 끝났고, 읽으라고 한 파일의 값으로 답했으며, 데몬의 pid와 포트는 바뀌지 않았습니다.
- 상주 브리지를 쓰는 실행(모델을 호출하지 않는 `agents` 하위 명령)이 종료 코드 0으로 끝났고, 데몬 폴더에 설정 파일을 하나 더 만들었으며, 같은 pid와 포트의 데몬을 찾았습니다.
- `claude-ghcp-stop`이 정지를 보고하고, 이후 status가 데몬이 실행 중이 아님을 보여 주며, 레지스트리와 로그가 지워졌습니다.

## 기능 커버리지

이 실행의 시나리오 11개는 `scripts/verify/features.mjs`에서 세는 기능 43개 중 39개를 선언합니다. 가중치로는 **92.2%**(102 중 94)입니다. 이 비율은 검사가 아니라 시나리오가 `covers`에 적은 기능을 센 값이고, 통과율이 아닙니다. 가중치는 거의 모든 세션에서 쓰는 기능이 3, 자주 쓰는 기능이 2, 드물게 쓰는 기능이 1입니다. 파일에는 기능이 47개 있고, 그중 Claude Code에 없는 도구가 필요한 4개는 세지 않습니다.

### 선언했지만 검사하지 않는 기능

아래 기능은 비율에 들어가지만, 적힌 시나리오의 검사 중 이 기능을 확인하는 것은 없습니다.

- `parallel-tools` (`v01-repo-recon`): 한 어시스턴트 메시지에 든 도구 호출 수를 세는 검사가 없습니다. 이 기능을 선언한 다른 시나리오도 없습니다.
- `error-recovery` (`v04-shell-ops`): v04에는 실패한 도구 결과를 다루는 검사가 없습니다. v03과 v08도 이 기능을 선언합니다.

### 어느 시나리오도 선언하지 않은 기능

- `thinking`: 확장 사고(reasoning) 블록
- `webfetch`: WebFetch / WebSearch
- `tui`: 대화형 TUI 요소(plan 선택 화면, /rewind)
- `compaction`: 자동 컨텍스트 압축

각 기능이 브리지에서 동작하는지는 [COMPATIBILITY_KO.md](COMPATIBILITY_KO.md#기능별-확인)에서 확인하세요.

### Claude Code에 없는 도구

`scripts/verify/probe.mjs`로 확인한 결과 Claude Code 2.1.278에는 다음 도구가 없습니다: `TodoWrite`, `BashOutput`, `KillShell`, `Glob`, `Grep`. 각 도구를 이름으로 지정해 호출하게 했을 때, 같은 턴의 Read 호출은 tool_use를 만들었지만 이 도구들은 만들지 않았습니다. 이 실행이 쓴 Claude Code 2.1.280에서는 프로브를 다시 돌리지 않았습니다. 이 도구가 있어야 하는 기능은 선언한 것으로도, 빠진 것으로도 세지 않습니다.

- `glob` (`Glob` 필요): Glob 경로 검색
- `grep` (`Grep` 필요): Grep 내용 검색
- `bash-background` (`BashOutput` 필요): 백그라운드 셸과 출력 폴링
- `todo` (`TodoWrite` 필요): TodoWrite 작업 추적

## 재현

`npm run verify`는 모든 슬롯에서 실제 Copilot 모델을 호출하며, 지금 체크아웃된 코드를 실행합니다. 이 실행이 검증한 코드를 다시 돌리려면 먼저 다음 커밋을 체크아웃하세요: `bed30ce`. 첫 번째 명령은 이 실행에 기록된 `--timeout-scale`, `--model-concurrency`, `--scenario-concurrency`, `PENDING_TOOL_WAIT_MS` 값을 그대로 씁니다. 다른 브리지 설정과 설치된 Claude Code를 포함한 나머지는 실행하는 컴퓨터의 것을 씁니다.

```bash
PENDING_TOOL_WAIT_MS=30000 npm run verify -- --timeout-scale 2 --model-concurrency 3 --scenario-concurrency 2 # 모델 6개 × 시나리오 11개
PENDING_TOOL_WAIT_MS=30000 npm run verify -- --timeout-scale 2 --model-concurrency 3 --scenario-concurrency 2 --dry-run # 모델 호출 없이 계획만 출력
npm run verify:probe        # 이 Claude Code 빌드에 없는 도구를 다시 확인 (모델 호출)
npm run verify:report       # 가장 최근 실행 요약
```

### 이 실행의 설정

| 설정 | 값 | 적용 대상 |
| --- | --- | --- |
| `--timeout-scale` | 2 | 아래 하네스 대기 시간에 곱하는 배율 |
| `PENDING_TOOL_WAIT_MS` | 30000 ms (30 s) | 브리지 설정. 각 브리지가 Copilot이 도구 호출을 등록하기를 기다리는 시간. 기본값 10000 ms. 배율 적용 안 함. |
| `--model-concurrency` | 3 | 동시에 실행하는 모델 수 |
| `--scenario-concurrency` | 2 | 모델마다 동시에 실행하는 시나리오 수 |
| `bridgeHealthMs` | 240000 ms (240 s) | 슬롯 브리지가 정상 응답할 때까지 대기 |
| `planTurnMs` | 180000 ms (180 s) | v02의 plan 모드 Claude Code 실행 |
| `backgroundLaunchMs` | 240000 ms (240 s) | v11의 `--background` 실행 |
| `foregroundLaunchMs` | 360000 ms (360 s) | v11의 `-p` 실행 |
| `persistentLaunchMs` | 240000 ms (240 s) | v11에서 데몬을 거치는 `agents` 실행 |
| `detachedOutputMs` | 480000 ms (480 s) | v11에서 백그라운드 에이전트의 출력 파일 대기 |
| `scenarioMs.v01-repo-recon` | 480000 ms (480 s) | 이 시나리오의 Claude Code 실행 1회마다 |
| `scenarioMs.v02-surgical-edit` | 480000 ms (480 s) | 이 시나리오의 Claude Code 실행 1회마다 |
| `scenarioMs.v03-test-fix-loop` | 480000 ms (480 s) | 이 시나리오의 Claude Code 실행 1회마다 |
| `scenarioMs.v04-shell-ops` | 840000 ms (840 s) | 이 시나리오의 Claude Code 실행 1회마다 |
| `scenarioMs.v05-multi-step` | 600000 ms (600 s) | 이 시나리오의 Claude Code 실행 1회마다 |
| `scenarioMs.v06-subagent` | 480000 ms (480 s) | 이 시나리오의 Claude Code 실행 1회마다 |
| `scenarioMs.v07-mcp-playwright` | 600000 ms (600 s) | 이 시나리오의 Claude Code 실행 1회마다 |
| `scenarioMs.v08-hooks-memory` | 660000 ms (660 s) | 이 시나리오의 Claude Code 실행 1회마다 |
| `scenarioMs.v09-session-resume` | 600000 ms (600 s) | 이 시나리오의 Claude Code 실행 1회마다 |
| `scenarioMs.v10-long-context` | 480000 ms (480 s) | 이 시나리오의 Claude Code 실행 1회마다 |
| `scenarioMs.v11-daemon-background` | 840000 ms (840 s) | 쓰지 않음. v11은 위의 v11 대기 시간을 따름 |

`--timeout-scale`은 이 표의 하네스 대기 시간에만 곱합니다. `PENDING_TOOL_WAIT_MS`, 하네스의 고정 대기(status·stop·`claude agents`·정리 명령, 폴링, v03의 테스트 재실행, SIGKILL 전 5초 유예 등), 런처와 데몬 자체의 시작 제한에는 배율을 적용하지 않습니다.

## 실행 기록

이 문서는 `scripts/verify/report.mjs`가 실행 `2026-09-23T09-11-26-241Z`의 `summary.json`과 `slots.jsonl`로 만듭니다. 이 두 파일은 실행한 컴퓨터에만 있고 커밋하지 않습니다. 결과, 설정, 코드 기록은 그 실행에서 가져옵니다. 시나리오 설명과 기능 목록은 문서를 생성할 때의 `scripts/verify/`에서 가져옵니다. 이전 실행과 일회성 실측은 [VERIFICATION_HISTORY_KO.md](VERIFICATION_HISTORY_KO.md)에 있습니다.

- 정책: strict-all-pass-v1
- 범위: full (전체 매트릭스 66개 슬롯)
- 예상: 66 / 실제: 66
- 결과: PASS
- PASS가 되려면 다음을 모두 만족해야 합니다. 기록한 매트릭스에 빠지거나 중복되거나 예상 밖인 슬롯이 없고, 모든 슬롯이 통과하고, 사용자의 Claude Code 설정 파일이 바뀌지 않고, 실행이 끝날 때의 코드가 시작할 때와 같아야 합니다.
- 시작과 종료 시 코드: commit: bed30cebc49b155b09c2795618b7e28ad044aae5; dirty: false; fingerprint: sha256 verification-code-v1 1fa37d3abcd284e9d1481fafef02c211d976e63fabeaa8d64d4879a159fb5bc7; files: 41
- 사용자 설정 파일: 바뀌지 않음

코드 지문(fingerprint)은 `src/`, `bin/`, `scripts/verify/`의 코드 파일과 패키지 매니페스트로 계산한 SHA-256 해시입니다.
