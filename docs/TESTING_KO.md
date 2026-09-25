# 테스트

> **언어 / Language:** [English](TESTING.md) | 한국어

필수 실측은 **V01–V06 시나리오 6개를 주요 모델 6개 모두에 실행**하는 것입니다.
Claude Opus 5.5, Sonnet 5, Haiku 4.5, GPT-6 Astra, Sol, Luna가 대상이며 총 **36개 슬롯**입니다.
일반적인 Claude Code 기능 전체가 아니라 Claude Code → 브리지 → GitHub Copilot SDK →
Copilot 모델 연동을 검사합니다. 아래 목록은 통과 조건이지 결과가 아닙니다. 가장 최근에
기록된 결과와 범위는 [검증 결과](VERIFICATION_KO.md)에 있습니다. 부분 실행이나 이전
시나리오 개정판으로 기록된 실행은 이 행렬의 결과를 증명하지 못합니다.

## 준비 사항

아래 명령은 저장소 루트에서 실행하세요. 필요한 것은 다음과 같습니다.

- Node.js `^20.19.0 || >=22.12.0`, npm, git과 dev dependencies 및 `@xterm/headless`를
  포함한 저장소 의존성. 설치는 [README](../README_KO.md)를 참고하세요.
- `python3`로 PATH에 있고 표준 라이브러리의 PTY 기능을 쓸 수 있는 Python 3.9 이상.
  native 터미널 드라이버는 Python의 PTY와 설치된 `@xterm/headless`를 사용하며
  브라우저를 쓰지 않습니다.
- 실측에는 기존 Copilot 로그인과 **6개 모델 모두**에 대한 정책상 접근 권한이 필요합니다.
  사용할 수 없는 모델은 blocked로 남깁니다. 다른 모델로 바꾸거나 전체 실행의 분모에서
  빼지 마세요.
- 필요한 print 및 native 터미널 기능을 지원하는 실제 설치된 Claude Code 실행 파일.
  필요하면 `CLAUDE_CODE_BIN`에 절대 경로를 지정하세요. 없으면 PATH에서 래퍼가 아닌
  첫 `claude`를 찾으며 Agent SDK에 든 CLI로 대신하지 않습니다. 이 저장소의 런처를
  지정하지 마세요.

브리지는 기존 Copilot CLI 인증(`COPILOT_HOME`, 보통 `~/.copilot`)을 씁니다. dry-run은
로그인이나 모델 가용성을 확인하지 않습니다. V03은 실행기 소유의 로컬 MCP fixture를
시작하며 외부 MCP 서비스나 공유 데몬은 필요하지 않습니다.

실행기는 루프백 포트, 토큰, settings, `CLAUDE_CONFIG_DIR`, 체크아웃 밖 임시 작업 공간을
따로 둔 비공개 Direct 브리지를 시작합니다. print와 native 실행은 격리된 설정과 기능을
확인한 CLI 옵션을 사용합니다. 자동 메모리와 외부 훅·플러그인·MCP가 답을 제공하면 안
됩니다. V02는 범위를 제한한 Read/Edit/Bash를, V03은 로컬 MCP 도구만 허용하며 회상
턴에서는 도구를 쓸 수 없습니다. 이 격리는 **보안 샌드박스가 아닙니다.** 허용한 도구는
모델의 호출에 따라 호스트에서 실행됩니다.

슬롯마다 Claude Code 설정은 production 작성기(`src/write-launch-settings.mjs`)가 만듭니다.
실행기는 브리지 토큰을 명령줄이 아니라 `GHCP_BRIDGE_TOKEN`으로 넘깁니다. 설정은
production 자격 증명 경로를 씁니다. 토큰은 `ANTHROPIC_AUTH_TOKEN`에 들어가 Claude Code가
`Authorization: Bearer`로 보내고, `ANTHROPIC_API_KEY`는 비웁니다. 실행기는
`autoMemoryEnabled: false`, `disableAllHooks: true` 같은 격리용 키만 더합니다. Claude Code가
"Do you want to use this API key?" 창을 띄우면 하네스가 거부하고 그 실행은 실패합니다.

비공개 브리지는 Copilot 자격 증명과 연결 설정(`GH_TOKEN`, `GITHUB_TOKEN`, `COPILOT_HOME`과
`COPILOT_CLI_PATH` 같은 `COPILOT_*`, 프록시 변수), 그리고 런타임 예산 6개
`TURN_IDLE_TIMEOUT_MS`, `TURN_MAX_DURATION_MS`, `SESSION_OPERATION_TIMEOUT_MS`,
`PENDING_TOOL_WAIT_MS`, `CLEANUP_TIMEOUT_MS`, `STATE_IDLE_TTL_MS`를 물려받습니다. 실행기는 이
예산을 기록하고 각 브리지의 `/health`와 비교합니다. `MAX_BODY_BYTES`, `MAX_REPLAY_BYTES`,
`MAX_STATES`, `MAX_TOOL_RESULTS`, `RETIRED_IDLE_MS`, `ALLOW_NON_LOOPBACK`,
`COPILOT_SDK_DEFAULT_CONNECTION`은 빼므로 실행마다 기본값을 씁니다. `ANTHROPIC_*`,
`CLAUDE*`, `BRIDGE_*`, `GHCP_*`, `OPENAI_*`, `AZURE_OPENAI_*`, `ENABLE_TOOL_SEARCH`,
`NODE_OPTIONS`도 뺍니다.

실행이 끝날 때까지 구현, 의존성, Claude Code 사용자 설정을 바꾸지 마세요. 다른 세션에서
설정을 저장하지도 마세요. 실행 전후 코드 지문과 사용자 설정 다이제스트를 비교합니다.
실행기는 전역 설정을 바꾸거나 공유 브리지를 멈추지 않습니다. 브리지를 직접 시작하므로
이 행렬은 **production 런처, 공유 데몬, 교체 또는 백그라운드 세션 수명 주기를 검증하지
않습니다.**

## 오프라인 검사와 dry-run

다음 명령은 모델을 호출하지 않습니다.

```bash
npm test
npm run verify:plan
PENDING_TOOL_WAIT_MS=30000 npm run verify -- \
  --model-concurrency 1 --timeout-scale 2 --dry-run
```

`npm test`는 메시지·SSE 변환, 모델·effort 매핑, 오류, 취소, 세션·서브에이전트 분리,
런타임 MCP 차단, 런처와 데몬 수명 주기의 production 회귀 테스트를 유지합니다.
검증기 테스트는 합성 36개 슬롯 범위, 근거·무결성 검사와 소유 프로세스 정리를 확인합니다.
통과는 로컬 동작의 근거이지 실제 Copilot 모델 동작의 증명은 아닙니다.

`verify:plan`은 같은 실행기에 `--dry-run`을 준 것입니다. dry-run은 부작용 없이 선택값을
검사하고 예상 슬롯과 실행 설정을 출력합니다. Claude Code를 찾거나 실행하지 않고,
사전 점검을 실행하거나 브리지를 시작하거나 카탈로그를 조회하거나 실행 산출물을
만들지도 않습니다. 크레딧을 쓰기 전에 오프라인 실패부터 고치세요.

## 필수 6개 모델 검증 실행

아래 경로를 실제 CLI 경로로 바꾸거나, PATH로 찾을 수 있으면 첫 줄을 생략하세요.

```bash
CLAUDE_CODE_BIN="/absolute/path/to/claude" \
PENDING_TOOL_WAIT_MS=30000 npm run verify -- \
  --model-concurrency 1 --timeout-scale 2
```

전체 실행은 먼저 **실제로 설치된 Claude Code**를 제한 시간이 있는 로컬 모의 Messages
API에 연결합니다. 이 사전 점검은 Copilot 모델을 호출하지 않고 시나리오에 필요한
native/print 기능과 격리를 확인합니다. 쓸 수 없는 기능은 해당 슬롯을 blocked로
남기며, 합성 통과로 바꾸거나 조용히 제외하지 않습니다. 나머지 실측 행렬은 **하네스
재시도 없이 한 번** 실행합니다. 정리나 격리 위반이 확인되면 이후 실측을 중단합니다.

**실측 슬롯은 GitHub Copilot AI Credits를 소비합니다.** 슬롯 36개가 API 요청 36개라는
뜻은 아닙니다. 여러 턴과 도구 왕복이 있고 V06은 새 CLI와 브리지도 시작합니다.
통과할 때까지 재실행하지 말고 실패·차단 근거를 남기세요. 하네스의 무재시도 정책은
CLI와 런타임 자체의 업스트림 재시도를 끄는 것은 아닙니다.

`--model-concurrency 1`이 기본값이며 각 모델의 시나리오는 순서대로 실행합니다.
`--timeout-scale` 기본값은 1입니다. 아래 시나리오 제한 시간은 **브리지 시작과 모든
단계를 포함한 슬롯 전체 예산**입니다. 단계마다 새로 주는 시간도, 행렬 전체의 마감
시간도 아닙니다.

| 시나리오 | 단계 | 배수 적용 전 슬롯 예산 |
|---|---|---|
| V01 | `print`, `unicode`, `clear` | 240초 |
| V02 | `coding` | 300초 |
| V03 | `lookup`, `recall` | 240초 |
| V04 | `source`, `target` | 240초 |
| V05 | `interrupt`, `recovery` | 240초 |
| V06 | `seed`, `compact`, `recall`, `resume` | 420초 |

`--timeout-scale`은 다음 검증기 예산에만 곱해집니다. 위의 슬롯 예산, 브리지 시작
대기(`bridgeHealthMs`, 120초), 정리 예산(`cleanupMs`, 10초), V05의 중단 예산(진행 90초,
정착 15초, 복구 60초)입니다. print 단계와 모델 턴은 배수를 적용한 슬롯 예산의 남은
시간만큼 기다립니다. native CLI 자체의 단계별 대기는 고정값이며 배수를 적용하지
않습니다. 프롬프트 준비 최대 30초, 선언한 MCP 도구 준비 최대 15초, 시작 창 입력 3초, 입력
확인과 프롬프트 입력 5초, 정상 `/exit` 2초 + 3초, PTY 도우미 종료 5초입니다. V02의 독립
테스트 재실행(최대 30초), `SIGKILL` 전 브리지의 `SIGTERM` 유예(최대 5초), 로컬 사전 점검의
자체 예산도 마찬가지입니다.

브리지의 런타임 예산에는 배수를 적용하지 않습니다. `PENDING_TOOL_WAIT_MS`의 기본값은
10000이며 위 명령은 30000을 명시합니다. 실행 설정은 기록에 남으며 통과를 보장하지
않습니다.

다른 옵션은 `--out DIR`(타임스탬프별 실행을 담을 상위 경로, 기본값은 저장소의
`.verify-runs/`)과 `--keep-workspaces`(통과한 작업 공간도 보관)입니다.
`--models a,b`와 `--scenarios V01,V02`는 알려진 값을 중복 없이 골라 **특정 문제를
디버깅할 때만** 씁니다. 부분 실행의 검사가 통과해도 36개 전체 결과가 아닙니다.
`--scenario-concurrency` 옵션은 없습니다.

## 결과 읽기와 문서 생성

실행기의 `artifacts:` 줄에 출력된 **정확한 디렉터리**를 쓰세요. `--out`을 썼다면 그
위치까지 포함합니다. 단지 가장 최근이라는 이유로 실행을 고르지 마세요.

```bash
run_dir=".verify-runs/<timestamp-from-artifacts-line>"
node scripts/verify/report.mjs "$run_dir"
npm run verify:doc -- "$run_dir"
```

첫 명령은 터미널 보고서를 출력합니다. `verify:doc`도 같은 입력을 명시해야 하며,
그 실행으로 `docs/VERIFICATION.md`와 `docs/VERIFICATION_KO.md`를 만듭니다.
두 언어를 모두 렌더링한 뒤 기존 문서를 교체합니다. 모델 호출이나 외부 게시가 아니라
로컬 파일 작업입니다. 보고서는 저장된 `pass` 표시나 현재 카탈로그를 대신 믿지 않고
저장된 v2 소스 스냅샷, 해시 명세와 원시 근거를 검사합니다. 보고서 생성 성공은 검증
성공이 아니므로 판정과 범위를 읽으세요. 실패와 부분 실행을 그대로 표시하고 커밋 전에
생성된 차이를 검토하세요.

보고서는 결과와 개수, 모델 × 시나리오 표, 실패와 누락 근거, 시나리오 기준, 단계별 근거,
실행 메타데이터, 근거와 재현, 한계 순서로 나옵니다.

- 저장된 PASS 슬롯마다 저장된 원시 근거를 현재 체크아웃의 판정기로 다시 판정하며, 저장된
  실패를 통과로 올리지 않습니다. `sources/files/`의 동결된 소스 사본은 재현용 자료로,
  해시를 검사할 뿐 실행하지 않습니다. 이전 시나리오 개정판으로 기록된 실행은 현재
  검증 모음과 맞지 않으므로 통과가 될 수 없습니다.
- effort 열은 연결된 모델 상태 기록마다 요청 / 적용 / 관측을 보여 줍니다. `요청 없음`은
  요청에 effort가 없었다는 뜻, `적용 없음`은 브리지가 적용하지 않았다는 뜻, `SDK 미보고`는
  SDK 모델 상태에 `reasoningEffort`가 없었다는 뜻, `관측 실패 (<사유>)`는 모델 상태 조회가
  실패했다는 뜻, `모델 상태 없음`은 연결된 기록이 없다는 뜻, `unknown`은 저장된 기록에
  필드가 없다는 뜻입니다. 값을 채워 넣지 않습니다.
- 실행 메타데이터는 슬롯마다 CLI 실행별 종료 코드, 시그널, 강제 종료, `SIGKILL` 승격과
  소유 프로세스 회수 여부를, 브리지별로 정지 기록(그룹 종료, 포트 해제, 종료 코드,
  시그널)과 짧은 `/health` 요약을 보여 줍니다. 전체 `/health` 기록은 `slots.jsonl`에
  있습니다. 실행되지 않은 슬롯은 `CLI 시작 안 됨`이나 `브리지 시작 안 됨`으로 나옵니다.
- 선택 사항인 새 실측 명령은 기록된 런타임 예산 가운데 기본값과 다른 것을 모두 다시
  지정합니다. 중단 예산과 MCP 탐색 예산은 바꿀 수 있는 변수가 없습니다.
- 생성된 Markdown에는 홈 디렉터리나 macOS 사용자별 임시 디렉터리 경로가 나오지 않습니다.
  `~`나 `$HOME`, `$TMPDIR`가 이를 대신하고(Claude 프로젝트 디렉터리 이름 안에서는 `-HOME`,
  `-TMPDIR`), 실행 디렉터리 안의 경로는 그 디렉터리 기준 상대 경로이며, 명령은
  `"$HOME/..."` 형태라 그대로 붙여 넣을 수 있습니다. 터미널 보고서는 절대 경로를
  유지합니다.

실패했다면 실행 전체의 문제와 해당 슬롯의 실패한 검사부터 확인하세요.

- `summary.json`: 저장된 시나리오 정의와 예상 행렬, 실행 설정, 사전 점검,
  Claude·Node·호스트 버전, 설치된 `copilotSdk.version`, 시작·종료 코드 및 사용자 설정
  근거, 정리 결과.
- `sources/manifest.json`과 `sources/files/`: 저장된 v2 소스 명세와 소스 스냅샷.
  `artifact-manifest.json`은 보관된 실행 근거의 해시를 기록합니다.
- `slots.jsonl`: 모델·시나리오별 `outcome`, `reason`, `checks`, `evidence.phases`,
  원시 근거, SDK 관측, 작업 공간과 정리 기록.
- `slots/<model>__Vxx/`: print 단계의 `transcript-<phase>.jsonl`, native 터미널 로그와
  세션 기록, `bridge.log`. V06에는 교체한 비공개 브리지의 `bridge-2.log`도 있습니다.
  무관한 부수 호출이 아니라 기록된 단계·대화 기록 경로와 응답 ID를 따라가세요.
  터미널 표시 텍스트만으로 답을 증명하지 않습니다. 로그 필드는 [진단](DIAGNOSTICS_KO.md)에
  있습니다.
- native 실행마다 원시 `terminal-<launchId>.log` 옆에 `terminal-events-<launchId>.jsonl`
  (입력 바이트 없는 입출력 기록. Escape마다 `test-interrupt`, `cleanup`, `picker-dismiss`,
  `mcp-dismiss`(실행 시 /mcp 준비 확인 패널 닫기) 중 하나의 목적이 붙습니다. 중단 행에는
  입력한 프롬프트가 보이는 렌더링된 화면도 들어갑니다),
  `cleanup-<pid>.json`, 드라이버의 단계 표시가 든 출력 전용 녹화
  `terminal-output-<launchId>.jsonl`이 있습니다. 녹화의 마지막 줄은 판정이 아니라
  녹화 상태를 나타내며, 녹화는 답의 근거가 아닙니다([자세히](DIAGNOSTICS_KO.md#근거-찾기)).
- 기록된 작업 공간: 실패·차단 슬롯은 보관합니다. 통과한 것은 `--keep-workspaces`가
  없으면 지웁니다. 실행 산출물은 별도로 남습니다.

중단된 실행은 필수 완료 근거가 없으므로 통과할 수 없습니다. 해당 실행 소유의 프로세스와
파일만 확인하세요. 검증기는 공유 데몬을 쓰지 않으므로 정리에 `claude-ghcp-stop`을 쓰지
마세요. 과거 실행 디렉터리와 남겨 둔 작업 공간은 자동으로 삭제하지 않습니다.

native 대화 기록과 설정 파일을 포함한 산출물에는 브리지 토큰, 대화·도구 내용, 비공개
경로가 들어갈 수 있습니다. gitignore는 민감한 내용을 지우지 않으므로 공유 전에
검토하세요. SDK 버전은 설치된 패키지를 식별할 뿐 런타임 바이너리나 모델의 증명이
아닙니다. 보고서는 저장된 버전만 쓰고, 누락된 값은 **기록 없음**으로 남깁니다.
현재 설치값으로 채우지 않습니다. `COPILOT_CLI_PATH`를 재정의하면 다른 런타임을
쓸 수 있습니다.

`node scripts/verify/render-recording.mjs --spec <spec.json> --out <새 디렉터리>`는 끝난
실행의 터미널 녹화로 정지 화면과 MP4를 오프라인에서 만들며 모델을 호출하지 않습니다.
spec에는 실행과 렌더링할 구간이나 정지 화면을 적습니다(형식은 그 파일의 `parseSpec`이
정합니다). 시스템에 설치된 Google Chrome과 PATH의 `ffmpeg`/`ffprobe`가 필요합니다. 실행의
산출물 명세에 봉인된 녹화만 받으며, 새 디렉터리나 빈 디렉터리가 아니거나 `.verify-runs/`
또는 그 실행 안에 있는 출력 디렉터리는 거부합니다. 렌더링 전에 홈·임시 경로, `sk-` 키(가려
표시된 `sk-...` 포함), `gh*_`, `github_pat_` 키, 문자와 숫자를 모두 포함한 32자 이상의 16진수·base64url 문자열,
사용자 이름을 같은 폭의 자리 표시로 바꿉니다. 이 가림은 패턴 기반이며 화면에 표시된 프롬프트와 응답은 가리지 않습니다.
게시 전에 결과를 확인하세요. 결과물은
실제 PTY 녹화를 편집한 재생으로 표시되며 검증 근거가 아닙니다.

## 통과의 의미

### 코딩과 재개

코딩과 재개는 한 시나리오의 두 단계가 아니라 별도 시나리오입니다.

- **V02:** 성공한 Read가 초기 foreground 테스트 전에 숨은 sample, 소스, 테스트
  전체를 반환합니다. 초기 할인 계산 회귀 테스트는 실패해야 합니다. 성공한 Edit가
  `discount.mjs`만 고친 뒤 종료 상태를 가리지 않은 동일 명령으로 테스트 **3개**가
  모두 통과해야 합니다. 하네스도 독립적으로 재검사하며 정확한 수정과 다른 파일·모드·링크의
  불변을 확인합니다. 최종 답은 숨은 sample이어야 합니다. 도구 ID, 인수, 반환 내용,
  순서와 파일 근거가 필요하며 모델의 “완료”라는 말로 대신하지 않습니다. 명령 체이닝,
  리다이렉션, 백그라운드 실행으로 테스트 결과를 가리면 안 됩니다.
- **V06:** native `/compact`가 실제 요약 요청과 native 압축 경계를 남긴 뒤 대화에만
  넣은 무작위 값을 정확히 회상해야 합니다. 이 회상은 새 SDK 세션에서 나와야 합니다.
  브리지가 회상 단계에서 보고한 SDK 세션 ID는 모두 seed와 compact 요청의 것과 달라야
  합니다. seed 요청에는 seed 프롬프트가 있어야 하고 회상 요청에는 없어야 하므로, 새 세션은
  압축된 기록을 받은 것입니다. 세션 ID나 요청 다이제스트가 없으면 blocked, 세션을 다시
  쓰거나 seed 프롬프트를 다시 보냈으면 fail입니다. CLI가 정상 종료하고 첫 비공개 브리지가
  정리된 다음, 새 CLI와 새 비공개 브리지가 **정확한 저장 세션 ID**를 재개해 같은 값을
  회상해야 합니다. 후속 질문에는 답을 다시 넣지 않으며 도구·파일·보조 메모리가 답을
  제공하면 안 됩니다. 이는 정상 종료 뒤의 콜드 대화 재전송이며 **진행 중인 턴의 복구나
  공유 데몬 재시작 검증이 아닙니다.**

### 나머지 필수 시나리오

- **V01:** 실제 print 응답이 정확하고 native picker에 대상 모델 6개가 있어야 합니다.
  새 Unicode 답이 정확해야 하며 native `/clear`가 세션을 바꾸고 다음 요청에서 이전
  대화를 제거해야 합니다.
- **V03:** CLI 소유 로컬 MCP lookup이 먼저 `missing`에 예상한 ENOENT 오류를 반환한
  다음 숨은 `selected` 값을 반환해야 합니다. native 도구 ID·인수·결과와 MCP ledger가
  일치해야 하며 파일·셸 우회는 안 됩니다. 같은 프로세스·세션의 두 번째 턴이 도구 없이
  그 값을 정확히 회상해야 합니다.
- **V04:** 다른 source 모델이 응답한 뒤 같은 대화에서 native `/model`로 target을
  선택해야 합니다. 새 응답은 문맥을 유지하고 각 단계의 요청·해석·SDK 보고 모델과
  일치해야 합니다. 지원 모델에는 High effort가 전달되어 SDK의 실제 모델 상태와
  일치해야 하며 Haiku에는 **effort를 적용하지 않아야** 합니다. 모든 effort 수준이나
  Ultracode를 검사하는 것은 아닙니다.
- **V05:** Escape가 실제로 스트리밍 중인 요청을 중단해야 합니다. 같은 요청에
  `client_abort`와 SDK의 중단 확인이 있어야 하며 정상 완료로 대신하면 안 됩니다.
  이어서 같은 native 프로세스·세션이 정확한 복구 답을 완전한 응답으로 반환해야 합니다.

### 연동과 실행 전체의 검사

성공한 print 단계는 유효한 완료 결과와 정상 종료가 필요합니다. native 단계에는 새로운
native 기록, 연결된 완료 응답과 시나리오별 수명 주기 근거가 필요하며 가짜 print result
형식으로 판정하지 않습니다. V05의 중단 단계에는 대신 중단 근거가 필요합니다. 도구
호출·결과는 중복 없이 순서대로 대응해야 하고 선언하지 않은 도구나 예상 밖의 도구
오류가 없어야 합니다. 완료 응답은 유한·음수 아닌 보고 사용량, 입출력 활동과 일치하는
중지 사유가 필요합니다.

루트 assistant `message.id`를 슬롯의 `bridge.turn_completed.responseId`와 연결합니다.
해당 요청·해석 모델과 SDK 보고 `servedModels`의 **모든** 항목은 알려진 별칭과 컨텍스트
접미사만 정규화한 뒤 단계의 기대 모델과 일치해야 합니다. V04의 source 단계는 의도적으로
다른 모델을 씁니다. CLI `modelUsage`나 카탈로그 등재 여부로 대신할 수 없습니다.
이는 **SDK 보고 ID 확인**이지 제공자 내부 모델 구현의 독립 증명은 아닙니다.

기본값으로 꺼진 `BRIDGE_VERIFY_OBSERVE=1`은 검증기에서만 켭니다. 이 관측은 원시 요청
내용 대신 요청·응답 ID, 세션 ID와 콘텐츠 다이제스트를 연결합니다. 모델·effort 근거는
최대 5초 안에 실제 SDK 모델 상태를 읽으며, 빠진 상태를 요청 설정에서 추정하지 않습니다.
그렇다고 native 산출물이나 오류를 합친 로그가 공유하기 안전해지는 것은 아닙니다.

확인된 위반은 **FAIL**입니다. 그 외에 필수 실행이나 근거가 빠졌으면 **BLOCKED**입니다.
SDK 모델 근거가 없거나 해석 불가인 경우도 포함합니다. 모든 필수 검사가 통과해야
**PASS**입니다. 뒤 단계의 근거 누락이 이미 확인된 실패를 덮지 않습니다. 전체 통과에는
정확히 **예상한 모델·시나리오 슬롯 36개**, 누락·중복·예상 밖·알 수 없는 결과 없음,
저장된 근거·소스 해시의 무결성, 코드·사용자 설정 불변, 비공개 설정 격리와 소유 프로세스의
성공한 정리가 모두 필요합니다. **36개 모두 통과해야 하며 fail과 blocked는 통과로 세지
않습니다.**

실측 범위에 LiteLLM, production 런처나 공유·백그라운드 데몬, 권한 승인 창이나 auto 모드,
외부 MCP 서비스나 ToolSearch, 서브에이전트, 훅·스킬·플러그인, 미디어, 컨텍스트 창 전체의
수용량이나 자동 초과 압축, 실제 429/529 복구, 포크, 충돌·진행 중인 턴의 복구는 포함하지
않습니다. 해당 production 코드와 오프라인 회귀 테스트는 유지합니다.
[호환성](COMPATIBILITY_KO.md)을 참고하세요.
