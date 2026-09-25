# Claude Code with GitHub Copilot Models

> **언어 / Language:** [English](README.md) | 한국어

로컬 브리지를 통해 Claude Code에서 GitHub Copilot 모델을 사용합니다. 브리지는 Anthropic Messages API 요청을 GitHub Copilot SDK(`@github/copilot-sdk`, 1.0.14로 고정)로 전달하며, Claude Code의 UI, 로컬 도구 실행, 권한, 훅, MCP 서버, 스킬은 그대로 둡니다.

**비공식 통합입니다.** Anthropic은 Claude가 아닌 모델을 게이트웨이로 연결하는 방식을 지원하지 않으며, 이 조합은 Anthropic도 GitHub도 지원하지 않습니다. 자세한 내용은 [되는 것과 안 되는 것](#되는-것과-안-되는-것)을 참고하세요.

[빠른 시작](#빠른-시작-direct-sdk) · [기록된 검증 결과](docs/VERIFICATION_KO.md) · [진단 가이드](docs/DIAGNOSTICS_KO.md#증상별-첫-조치)

## 경로 선택

내 Copilot 계정과 조직의 모델 정책을 그대로 쓰는 **Direct SDK를 권장합니다.** 아래 빠른 시작을 따라 하세요. 이 브리지 앞에 LiteLLM 게이트웨이가 필요한 경우에만 [LiteLLM (선택)](#litellm-선택)을 고르세요.

## 빠른 시작 (Direct SDK)

### 준비 사항

- macOS 또는 Linux (Windows 기본 셸은 지원하지 않습니다)
- Claude Code (`claude` 명령)
- GitHub Copilot CLI (`copilot` 명령)
- Node.js `^20.19.0` 또는 `>=22.12.0`
- `curl`과 Git
- GitHub Copilot 사용 권한과, 조직의 Copilot 정책이 허용한 모델

### 1. 설치

```bash
git clone https://github.com/junwoojeong100/claude-code-ghcp-sdk.git
cd claude-code-ghcp-sdk
npm ci
```

설치와 점검은 이 체크아웃에서, 실제 작업은 자신의 프로젝트에서 합니다. 아래 예시의 `/absolute/path/to/claude-code-ghcp-sdk`는 이 체크아웃의 절대 경로(여기서 `pwd`로 확인)로, `/path/to/your-project`는 작업할 프로젝트 디렉터리로 바꾸세요.

### 2. GitHub Copilot 로그인

`command -v copilot`이 아무것도 출력하지 않으면 Copilot CLI를 설치하세요.

```bash
npm install -g @github/copilot
```

그다음 로그인하세요.

```bash
copilot login
```

Anthropic API 키는 필요하지 않습니다.

### 3. 환경과 모델 확인

체크아웃 루트에서 실행하세요.

```bash
./bin/ghcp-doctor
./bin/ghcp-models
```

- `ghcp-doctor`는 Node, npm, Claude Code, Copilot CLI를 점검합니다. 실패한 항목을 해결한 뒤 진행하세요. 보고서 설명은 [환경 점검](docs/DIAGNOSTICS_KO.md#환경-점검)에 있습니다.
- `ghcp-models`는 계정에서 접근할 수 있는 모델을 나열합니다. 사용할 모델이 있는지 확인하세요. 목록 조회는 계정 접근 확인이지 모델의 응답 검증이 아닙니다. 실패하면 [진단 가이드](docs/DIAGNOSTICS_KO.md#증상별-첫-조치)를 따르세요. 모든 오류에 재로그인이 필요한 것은 아닙니다.

### 4. Claude Code 실행

작업할 프로젝트로 이동한 뒤, 체크아웃의 절대 경로로 런처를 실행하세요. PATH를 바꿀 필요는 없습니다.

```bash
cd "/path/to/your-project"
"/absolute/path/to/claude-code-ghcp-sdk/bin/claude-ghcp"
```

시작 모델의 우선순위는 `--ghcp-model` → export된 `GHCP_MODEL` → `claude-sonnet-5`(Claude Sonnet 5)입니다.

프롬프트는 Copilot 사용량을 소비합니다. Claude Code 안에서 `OK라고 답해줘`를 입력하세요. 답이 오면 요청 하나가 완료된 것이며, 모든 기능이 검증된 것은 아닙니다. `/exit`로 셸로 돌아올 수 있습니다. 공유 브리지는 계속 실행되므로 중지하기 전에 [백그라운드 브리지](#백그라운드-브리지)를 확인하세요. 시작이나 요청에 실패하면 [진단 가이드](docs/DIAGNOSTICS_KO.md#증상별-첫-조치)를 참고하세요.

**선택 가능한 다른 실행 방식 — 추가 설치 단계가 아닙니다.** 다른 모델로 대화형 세션을 시작하려면 다음을 실행하세요.

```bash
cd "/path/to/your-project"
"/absolute/path/to/claude-code-ghcp-sdk/bin/claude-ghcp" --ghcp-model gpt-6-sol
```

또는 프롬프트 하나에 답하고 종료하는 print 모드(`-p`)를 쓰세요.

```bash
cd "/path/to/your-project"
"/absolute/path/to/claude-code-ghcp-sdk/bin/claude-ghcp" --ghcp-model claude-haiku-4.5 -p "이 저장소의 구조를 설명해줘"
```

Claude Code 안에서는 `/model`로 [모델](#모델) 표의 6개 모델 사이를 오갈 수 있습니다.

### 5. 선택: claude를 PATH에 추가

위의 절대 경로는 어느 디렉터리에서든 쓸 수 있습니다. **체크아웃의 `bin`을 PATH 앞에 추가하면 기존 `claude` 대신 Direct SDK 런처가 실행됩니다.** Zsh에서 이 방식을 쓰려면 다음을 실행하세요.

```bash
cd "/absolute/path/to/claude-code-ghcp-sdk"
echo "export PATH=\"$PWD/bin:\$PATH\"" >> ~/.zshrc
exec zsh
command -v claude
```

마지막 명령은 `<clone-path>/claude-code-ghcp-sdk/bin/claude`를 출력해야 합니다. 다른 셸은 같은 export를 그 셸의 설정 파일에 넣으세요. 원래 공급자로 Claude Code를 실행하려면 `claude-current`를 쓰세요. `export GHCP_MODEL=claude-haiku-4.5`는 `--ghcp-model`을 주지 않았을 때의 시작 모델을 바꿉니다.

다른 방법은 체크아웃에서 `npm link`를 실행하는 것입니다. npm의 전역 bin 디렉터리가 PATH에 있어야 하며, `claude-ghcp`, `claude-current` 등 패키지 명령을 등록하지만 **`claude`는 등록하지 않습니다.** 런처는 심볼릭 링크를 따라가 이 체크아웃을 찾습니다. 두 설정을 되돌리는 방법은 [선택한 명령 설정 되돌리기](#선택한-명령-설정-되돌리기)를 참고하세요.

## 모델

| `/model` 이름 | `--ghcp-model` ID | Claude Code 컨텍스트 창 | Reasoning effort |
|---|---|---|---|
| Claude Opus 5.5 | `claude-opus-5.5` | 1M | `low`, `medium`, `high`, `xhigh`, `max` |
| Claude Sonnet 5 | `claude-sonnet-5` (기본값) | 1M | `low`, `medium`, `high`, `xhigh`, `max` |
| Claude Haiku 4.5 | `claude-haiku-4.5` | 200K | 지원하지 않음 |
| GPT-6 Astra | `gpt-6-astra` | 1M | `low`, `medium`, `high`, `xhigh`, `max` |
| GPT-6 Sol | `gpt-6-sol` | 1M | `none`, `low`, `medium`, `high`, `xhigh`, `max` |
| GPT-6 Luna | `gpt-6-luna` | 1M | `none`, `low`, `medium`, `high`, `xhigh`, `max` |

`/model` 목록에서 각 행은 `GitHub Copilot · <이름> (<ID>)`로 표시됩니다. 목록에는 이 6개 행과 Claude Code 자체의 `Default` 행만 나옵니다. Claude Code 2.1.280에서 `Default`는 Claude Opus 5.5입니다. 런처의 시작 모델 우선순위(`--ghcp-model`, export된 `GHCP_MODEL`, Claude Sonnet 5 순)와는 별개입니다.

Copilot 카탈로그의 다른 모델도 정책이 허용하면 `--ghcp-model`로 쓸 수 있지만 검증하지 않았습니다. 체크아웃 루트에서 `./bin/ghcp-models`로 목록을 볼 수 있습니다.

컨텍스트 창 열은 Claude Code가 계획하는 컨텍스트 크기이며, 측정한 Copilot 입력 한도가 아닙니다. 런타임의 한도는 이보다 작을 수 있습니다. [긴 대화](#긴-대화)를 참고하세요.

**Reasoning effort: 2026-09-24 카탈로그 관측값입니다.** 모델별 목록은 코드에 고정된 지원 값이나 테스트 결과가 아닙니다. 브리지는 시작할 때 SDK 카탈로그에서 읽은 지원 목록을 씁니다. 체크아웃 루트에서 `./bin/ghcp-models --json`을 실행하면 Copilot에 연결해 현재 계정의 카탈로그를 보여 주지만, 이미 실행 중인 브리지의 목록을 갱신하지는 않습니다. 값은 `--effort <level>`이나 `/effort`로 지정합니다. 모델 목록에 없는 값이면 브리지는 그보다 낮은 값 중 가장 가까운 값을 쓰고, 더 낮은 값이 없으면 모델의 가장 낮은 값을 씁니다. 예를 들어 Claude Opus 5.5에 `none`을 주면 `low`로 실행합니다. Reasoning effort를 지원하지 않는 모델에는 값을 보내지 않습니다.

Ultracode(`--effort ultracode`)는 Copilot에 `xhigh`로 전달되고, 목록에 `xhigh`가 없는 모델에서는 그보다 낮은 값 중 가장 가까운 값으로 바뀝니다. Claude Code 2.1.203 이상이 필요하고, 일반 호출보다 GitHub Copilot AI Credits를 더 쓸 수 있습니다.

Claude Opus 5.5, Sonnet 5, Haiku 4.5가 아닌 모델(예: GPT-6 모델)로 시작하면, 모델을 지정하지 않은 서브에이전트는 기본 제공 Explore 서브에이전트를 포함해 시작 모델로 실행합니다. 이 세 Claude 모델로 시작했다면 Claude Code의 기본 동작대로 주 모델을 따릅니다.

컨텍스트 창, 입력 한도, reasoning effort를 정하는 방식은 [아키텍처](docs/ARCHITECTURE_KO.md#모델-탐색과-컨텍스트)를 참고하세요.

## 일상 사용

### 백그라운드 브리지

대화형 세션, `--background`, `/background`로 넘긴 세션, `agents` 화면은 루프백 브리지 하나를 함께 씁니다(상주 브리지, 영문 문서의 *persistent bridge*). Claude Code가 끝나도 계속 실행되므로 백그라운드 작업이 이어집니다. print 모드(`-p`)는 종료 시 함께 멈추는 전용 브리지를 쓰지만, `--background`나 `agents`와 함께 쓰면 상주 브리지를 씁니다.

어느 디렉터리에서든 `"/absolute/path/to/claude-code-ghcp-sdk/bin/claude-ghcp-status"`로 상태를 확인할 수 있습니다. PID와 포트, 처음 시작할 때의 모델, 아직 실행 중인 교체된 브리지 수(`retired`)를 보여 줍니다.

**중지하기 전에 모든 세션과 백그라운드 작업을 마치고 필요한 로그를 복사해 두세요.** `claude-ghcp-stop`은 공유 브리지와 교체된 브리지를 모두 멈춰, 이를 쓰는 모든 세션과 `/background` 작업을 끊습니다. 현재 브리지 중지에 실패해도 `bridge.log`와 브리지의 실행별 설정 파일을 지웁니다. 사용자 설정, 저장된 대화, `claude-litellm` 설정 파일은 지우지 않습니다. LiteLLM 설정 파일에는 키가 남을 수 있으므로 [사용자 설정은 건드리지 않습니다](#사용자-설정은-건드리지-않습니다)를 확인하세요.

```bash
"/absolute/path/to/claude-code-ghcp-sdk/bin/claude-ghcp-stop"
```

브리지 파일은 `$GHCP_DAEMON_DIR`가 있으면 그곳에, 없으면 macOS에서는 `~/Library/Caches/claude-code-ghcp-sdk`, Linux에서는 `${XDG_CACHE_HOME:-~/.cache}/claude-code-ghcp-sdk`에 둡니다. 교체·보관 규칙은 [아키텍처](docs/ARCHITECTURE_KO.md#상주-브리지와-교체), 응답하지 않는 브리지는 [진단 가이드](docs/DIAGNOSTICS_KO.md#증상별-첫-조치)를 참고하세요.

### 체크아웃을 업데이트한 뒤

의존성을 바꾸기 전에 진행 중인 작업을 마치세요. 체크아웃에서 `git status --short`를 확인하고 로컬 변경이 있으면 먼저 보존하세요. 깨끗한 체크아웃에서 업데이트하고 잠금 파일 기준으로 의존성을 설치합니다.

```bash
cd "/absolute/path/to/claude-code-ghcp-sdk"
git pull --ff-only
npm ci
```

실행 중인 브리지는 처음 읽은 코드를 계속 씁니다. 지문에 포함되는 파일(`src/*.mjs`, `package.json`, `package-lock.json`), 체크아웃 경로, 관련 브리지 설정이 바뀌면 다음 실행이 브리지를 교체합니다. README·테스트·런처만 수정하면 교체하지 않으며, `--ghcp-model`만 달라도 브리지를 재사용합니다. 기존 세션은 보통 예전 브리지에 남습니다. 오래된 브리지나 고정 포트 등의 예외는 [아키텍처](docs/ARCHITECTURE_KO.md#상주-브리지와-교체)를 참고하세요.

대화를 업데이트한 코드로 옮기려면 Claude Code를 종료한 뒤 **원래 프로젝트 디렉터리**에서 같은 모델로 재개하세요. 아래 모델 ID는 쓰던 것으로 바꾸세요.

```bash
cd "/path/to/your-project"
"/absolute/path/to/claude-code-ghcp-sdk/bin/claude-ghcp" --ghcp-model gpt-6-astra --continue
```

저장된 대화를 고르려면 `--continue` 대신 `--resume`을 쓰세요. 재개해도 Claude Code의 대화 기록과 사용자 설정은 보존됩니다. 바뀐 `/model` 목록을 불러오려면 세션을 다시 시작하세요. 이것이 실행 중인 브리지에 캐시된 SDK 카탈로그를 갱신하지는 않습니다.

### 선택한 명령 설정 되돌리기

- `bin`을 PATH에 추가했다면 `~/.zshrc`(또는 사용하는 셸의 설정 파일)에서 그 export를 제거하고 새 터미널을 여세요.
- `npm link`를 썼다면 `npm unlink -g claude-code-ghcp-sdk`를 실행하세요.

어느 방법도 실행 중인 브리지를 멈추지는 않습니다. 브리지도 멈추려면 모든 작업을 마치고 필요한 로그를 보존한 뒤 [위의 중지 명령](#백그라운드-브리지)을 쓰세요. 이 절차는 Claude/Copilot 사용자 설정과 저장된 대화를 그대로 둡니다.

### 긴 대화

대화를 언제 압축할지는 평소처럼 Claude Code가 정합니다. Copilot 런타임의 입력 한도는 표시된 컨텍스트 창보다 작을 수 있으므로, 긴 대화는 Claude Code의 자동 압축 전에 그 한도에 닿을 수 있습니다.

- Copilot이 스스로 대화 기록을 압축하거나 버리려고 하면, 브리지는 메시지가 `prompt is too long`으로 시작하는 400 `invalid_request_error`로 턴을 끝냅니다. 그러면 Claude Code가 자신의 대화 기록을 압축하고 이어 갑니다. 이 넘겨주기는 [검증하지 않았습니다](#검증하지-않은-것).
- Copilot이 컨텍스트 한도 오류를 직접 보고하면, 브리지는 Claude Code가 압축을 시작하는 `prompt is too long` 오류가 아니라 500 `api_error`를 반환합니다. 긴 대화가 이렇게 계속 실패하면 `/compact`를 실행하세요.
- 더 큰 창을 얻으려고 자동 압축을 끄지 마세요.
- 캐시된 입력은 한 번만 세므로 Claude Code의 컨텍스트 표시가 부풀지 않습니다.

표시된 컨텍스트 창과 런타임 한도의 차이는 [아키텍처](docs/ARCHITECTURE_KO.md#모델-탐색과-컨텍스트)를 참고하세요.

### 요청 한도와 타임아웃

Copilot이 요청 한도에 걸리거나 업스트림이 실패하면, Copilot 런타임이 먼저 스스로 재시도하고 `retry-after`가 있으면 그만큼 기다립니다. 기다리는 동안에는 아무것도 스트리밍되지 않으므로, 턴이 1분 넘게 아무 출력 없이 멈춰 보일 수 있습니다. 재시도가 모두 실패하면 브리지는 429 `rate_limit_error`(요청 한도나 할당량) 또는 529 `overloaded_error`(업스트림 5xx)를 반환하고, Claude Code가 자체 백오프로 다시 시도합니다.

모델 진행이 5분 동안 없거나(`TURN_IDLE_TIMEOUT_MS`) 턴이 모두 30분을 넘기면(`TURN_MAX_DURATION_MS`) 턴은 500 `api_error`로 실패합니다. Copilot이 429나 5xx 재시도를 기다리는 중에 둘 중 하나에 걸리면 턴은 대신 429나 529로 실패하므로, Claude Code가 다시 시도합니다.

상주 브리지는 실패한 Messages 요청(`bridge.request_failed`)과 완료된 턴(`bridge.turn_completed`, 요청 모델·SDK 보고 모델·토큰 수 포함)의 운영 요약을 `bridge.log`에 씁니다. 이 요약은 대화 내용을 담지 않지만, 다른 줄에는 업스트림 오류 문구가 포함될 수 있습니다. 공유하기 전에 전체 로그를 확인하세요. 상태 코드는 [업스트림 오류](docs/DIAGNOSTICS_KO.md#업스트림-오류), 이벤트와 개인정보 관련 주의 사항은 [로그](docs/DIAGNOSTICS_KO.md#로그)를 참고하세요.

## LiteLLM (선택)

가상 키나 요청 로그 때문에 LiteLLM 게이트웨이를 거쳐 Copilot 모델을 써야 할 때만 고르세요. LiteLLM은 이 브리지 앞에 놓일 뿐 브리지를 대신하지 않습니다. 게이트웨이를 거친 모든 요청은 누가 보냈든 브리지 운영자의 Copilot 좌석 하나와 그 조직 정책으로 실행됩니다. 클라이언트에는 이 체크아웃과 Node.js가 필요하지만 의존성 설치와 `copilot login`은 필요 없습니다. 6개 모델의 `/model` 목록과 1M 컨텍스트 창은 쓸 수 없고, 이 경로는 [검증하지 않았습니다](#검증하지-않은-것).

런처는 실행별 설정 파일에 키를 저장합니다. 사용하기 전에 [사용자 설정은 건드리지 않습니다](#사용자-설정은-건드리지-않습니다)에서 보관·제거 방법을 확인하세요.

```bash
export LITELLM_BASE_URL="https://litellm.example.com"
export LITELLM_API_KEY="<scoped-virtual-key>"
export LITELLM_MODEL="claude-sonnet-5"
cd "/path/to/your-project"
"/absolute/path/to/claude-code-ghcp-sdk/bin/claude-litellm"
```

연결 방법, 게이트웨이 운영, Direct SDK와 다른 점은 [LiteLLM 가이드](docs/LITELLM_KO.md)를 참고하세요.

## 명령과 설정

### 명령

아래 상대 경로 명령은 **체크아웃 루트** 기준입니다. 다른 프로젝트에서는 [빠른 시작](#4-claude-code-실행)처럼 체크아웃의 절대 경로를 쓰거나, 선택 사항인 PATH/링크 설정을 사용하세요.

| 용도 | 명령 |
|---|---|
| Copilot 모델로 Claude Code 실행 (Direct SDK) | `./bin/claude-ghcp` 또는 `./bin/claude` |
| 계정에서 쓸 수 있는 Copilot 모델 보기 | `./bin/ghcp-models` |
| 환경 점검 | `./bin/ghcp-doctor` 또는 `npm run doctor` |
| 상주 브리지 상태 보기 | `./bin/claude-ghcp-status` |
| 상주 브리지와 교체된 브리지 모두 멈추기 | `./bin/claude-ghcp-stop` |
| LiteLLM 게이트웨이를 거쳐 Claude Code 실행 | `./bin/claude-litellm` |
| 원래 공급자로 Claude Code 실행 | `./bin/claude-current` |

`claude-ghcp`는 `--model`과 `--settings`를 받지 않습니다. 모델은 `--ghcp-model`로 고르세요. `-h`/`--help`는 런처 자체의 도움말을 보여 주고, Claude Code의 도움말은 `./bin/claude-current --help`로 볼 수 있습니다. 나머지 옵션과 프롬프트는 그대로 Claude Code에 전달합니다. `bin`이 PATH에 있으면 `./bin/`을 빼도 됩니다.

### 설정

명령줄 옵션이 환경 변수보다 우선합니다. 런처는 export된 변수만 읽고 `.env` 파일은 읽지 않습니다. 모든 변수와 기본값은 [`.env.example`](.env.example)에 있습니다.

| 옵션 / 변수 | 기본값 | 효과 |
|---|---|---|
| `--ghcp-model` / `GHCP_MODEL` | `claude-sonnet-5` | Direct SDK의 시작 모델 |
| `--bridge-port` / `GHCP_BRIDGE_PORT` | 빈 포트 | 브리지의 루프백 포트 고정 |
| `GHCP_NATIVE_TOOL_SEARCH` | `0` | `1`이면 Claude Code 자체의 MCP 도구 검색을 켭니다. 기본값에서는 모든 도구를 전체 스키마로 보냅니다 |
| `GHCP_DAEMON_DIR` | [백그라운드 브리지](#백그라운드-브리지) 참고 | 상주 브리지의 디렉터리. 상대 경로는 실행한 디렉터리를 기준으로 풉니다. `~`는 펼치지 않으므로 `~`로 시작하는 값은 거부합니다 |
| `CLAUDE_CODE_BIN` | PATH에서 처음 찾은, 이 저장소의 런처가 아닌 `claude` | 런처가 실행하는 실제 Claude Code 실행 파일 |
| `COPILOT_CLI_PATH` | 없음 | SDK에 들어 있는 런타임 대신 기존 Copilot CLI를 실행합니다. 다른 런타임은 검증하지 않았습니다 |
| `MAX_BODY_BYTES`, `MAX_REPLAY_BYTES` | 각각 `268435456` (256 MiB) | 요청 본문과 재생하는 대화 기록의 최대 크기. 늘리면 메모리를 더 쓰지만 모델의 컨텍스트 창은 커지지 않습니다 |
| `TURN_IDLE_TIMEOUT_MS`, `TURN_MAX_DURATION_MS` | `300000`, `1800000` | 턴 제한. [요청 한도와 타임아웃](#요청-한도와-타임아웃) 참고 |
| `--litellm-base-url` / `LITELLM_BASE_URL` | 없음, 필수 | LiteLLM 게이트웨이 URL |
| `LITELLM_API_KEY` | 없음, 필수 | LiteLLM 가상 키 |
| `--litellm-model` / `LITELLM_MODEL` | `claude-sonnet-5` | 게이트웨이 모델 별칭 |

`--bridge-port`, `COPILOT_CLI_PATH`, 바이트 한도, 턴 제한은 브리지 설정에 속합니다. 이 중 하나를 바꾸면 다음 실행에서 새 상주 브리지가 시작되고, 기존 브리지에 이미 열린 세션은 예전 값을 계속 씁니다.

### 사용자 설정은 건드리지 않습니다

런처는 `~/.claude/settings.json`이나 프로젝트 설정을 쓰지 않습니다. 실행할 때마다 설정 파일 하나(권한 `0600`)를 `--settings`로 Claude Code에 추가로 넘깁니다.

- 이 파일은 Claude Code가 브리지(`claude-litellm`이면 게이트웨이)로 요청을 보내게 하고, 토큰, 모델 이름, 서브에이전트와 Explore의 모델 설정을 담습니다.
- `CLAUDE_CODE_USE_BEDROCK` 같은 공급자 선택 변수와 `ANTHROPIC_DEFAULT_MODEL` 같은 물려받은 모델 변수는 비워 둡니다. 셸이나 사용자 설정의 값이 요청을 다른 곳으로 보내지 못하게 하기 위해서입니다.
- Direct 파일은 `/model` 목록도 정하고, `CLAUDE_CODE_ATTRIBUTION_HEADER=0`과 `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`을 설정하고, `CLAUDE_CODE_MAX_CONTEXT_TOKENS`를 비웁니다. `GHCP_NATIVE_TOOL_SEARCH=1`이 아니면 `ENABLE_TOOL_SEARCH`도 비웁니다.
- `claude-litellm` 파일은 `ENABLE_TOOL_SEARCH`를 비우고 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`을 설정합니다.

테마, 권한, 훅, 플러그인, 스킬, MCP 서버, 프로젝트 설정은 모두 그대로 불러옵니다. Claude Code에서 관리형(조직) 설정은 명령줄 설정보다 우선하므로, 강제된 공급자 선택, `availableModels` 목록, MCP 도구 검색 설정은 그대로 적용됩니다. 이 저장소는 이 부분을 테스트하지 않습니다. 런처는 `PATH`도 바꾸지 않으므로 Claude Code는 실행한 셸의 `PATH`를 그대로 받습니다.

print 모드 실행(`--background` 없는 `-p`)은 끝날 때 이 파일을 지웁니다. 나머지 실행은 파일을 남겨 둡니다. Claude Code가 나중에 `/background` 작업을 이 파일로 다시 시작하기 때문입니다. `claude-ghcp`는 브리지 디렉터리에, `claude-litellm`은 `${XDG_STATE_HOME:-~/.local/state}/claude-code-ghcp-sdk/litellm-settings`에 남기며, `claude-litellm`의 파일에는 LiteLLM 키가 들어 있고 `claude-ghcp-stop`은 이 파일을 지우지 않습니다. 저장된 키를 없애려면 그 디렉터리를 직접 지우세요(아직 그 파일을 쓰는 `/background` 작업은 다시 시작하지 못합니다). 남겨 둔 파일을 언제 지우는지는 [브리지가 남기는 파일](docs/ARCHITECTURE_KO.md#브리지가-남기는-파일)을 참고하세요.

브리지는 Copilot CLI 자체의 MCP 서버(`~/.copilot/mcp-config.json`, 작업 공간 파일, 설치된 Copilot 플러그인에 등록된 서버와 기본 제공 `github-mcp-server`)가 자기 세션에서 시작되지 않게 막습니다. 그 설정 자체는 바꾸지 않고, Claude Code의 MCP 서버에도 영향이 없습니다. 자세한 내용은 [Copilot 런타임 MCP 서버](docs/ARCHITECTURE_KO.md#copilot-런타임-mcp-서버)를 참고하세요.

## 되는 것과 안 되는 것

### 핵심 검증이 확인하는 것

핵심 검증은 시나리오 6개를 [주요 모델](#모델) 6개 모두에 실행하는 **36개 케이스**입니다. 아래 목록은 각 케이스가 통과하려면 보여야 하는 것이며 결과가 아닙니다. 최근 실행의 통과 여부와 그때의 버전·코드는 **[기록된 검증 결과](docs/VERIFICATION_KO.md)**에 있습니다.

- **V01 — 실행·격리:** print/TUI 시작, 정확한 Unicode 응답, 6개 모델 picker와 `/clear` 후 새 대화.
- **V02 — 코딩:** 완전한 Read 결과, 실제 foreground 테스트 실패, 소스만 고친 Edit, 테스트 3개가 모두 통과하는 재검사와 하네스 독립 재검사.
- **V03 — MCP:** 예상한 lookup 오류 후 숨은 값 조회 성공, 같은 프로세스의 도구 없는 회상.
- **V04 — 모델·effort:** 같은 대화에서 모델을 전환하고 요청·해석·SDK 보고 모델 ID와 SDK의 실제 effort 설정 확인.
- **V05 — 중단:** 실제 스트리밍 중 Escape가 SDK abort로 이어지고 같은 프로세스가 후속 질문에 응답.
- **V06 — 압축·재개:** native `/compact` 후 원래 프롬프트 대신 압축된 기록을 받은 새 SDK 세션의 정확한 회상, 정상 종료, 새 CLI·전용 브리지가 정확한 저장 세션을 재개한 뒤의 회상.
- **실행 전체:** 36개 케이스, 코드·설정 불변과 소유 프로세스 정리가 모두 통과해야 합니다. 필수 근거 누락은 blocked, 확인된 위반은 fail이며 부분 실행은 전체 통과가 아닙니다.

모델 검사는 **SDK가 보고한 모델 ID**를 기준으로 하며 제공자 내부 모델 구현을 독립적으로 증명하지 않습니다. 검사와 근거는 [테스트 가이드](docs/TESTING_KO.md)에 있습니다. 변환, 모델 매핑, 오류, 취소, 세션·서브에이전트 분리, 런타임 MCP 차단, 런처의 production 오프라인 회귀 테스트는 유지하며 실측 결과와 구분합니다.

**편집 재생 영상(61초):** [브라우저에서 바로 재생](https://cdn.jsdelivr.net/gh/junwoojeong100/claude-code-ghcp-sdk@13fd4ccd1220c365860d42a1bb0147ad1bc36e25/docs/assets/verification/2026-09-25T09-55-54-058Z-9bdbc340/video.mp4) · [저장소 MP4 내려받기](docs/assets/verification/2026-09-25T09-55-54-058Z-9bdbc340/video.mp4). 재생 링크는 커밋에 고정된 jsDelivr 사본이며, GitHub는 저장소 파일을 내려받기로 제공합니다.

정지 화면: [V01](docs/assets/verification/2026-09-25T09-55-54-058Z-9bdbc340/still-02-v01-unicode-answer.png) · [V04](docs/assets/verification/2026-09-25T09-55-54-058Z-9bdbc340/still-03-v04-model-switch.png) · [V05](docs/assets/verification/2026-09-25T09-55-54-058Z-9bdbc340/still-04-v05-interrupt-continue.png) · [V06](docs/assets/verification/2026-09-25T09-55-54-058Z-9bdbc340/still-05-v06-cold-resume.png) · [결과 카드](docs/assets/verification/2026-09-25T09-55-54-058Z-9bdbc340/still-01-results-summary.png).

**출처:** 실행 `2026-09-25T09-55-54-058Z-9bdbc340`에 봉인된 PTY 녹화에서 경로와 토큰을 가리고 렌더링했습니다. 케이스가 어떻게 보이는지 보여 줄 뿐, **검증 근거는 아닙니다.** 원본 녹화·시간 구간·편집·해시는 [manifest.json](docs/assets/verification/2026-09-25T09-55-54-058Z-9bdbc340/manifest.json)에 있습니다. 실행 결과는 [기록된 검증 결과](docs/VERIFICATION_KO.md)를 보세요.

### 검증하지 않은 것

핵심 검증이 다루지 않는 범위입니다.

- 긴 컨텍스트 검색, 최대 컨텍스트 용량, 자동 압축, 컨텍스트 한도 복구.
- 실제 요청 한도·장애 복구(429/529), `/rewind`, 권한 확인 창.
- 서브에이전트, ToolSearch, 임의 MCP 통합, WebFetch, 스킬, 훅, 플러그인, 예약 작업, 노트북·미디어 작업.
- 세션 포크, 브리지 충돌 시 진행 중 턴의 복구, 공유 데몬 교체, 백그라운드 에이전트와 런처 자체 경로. 실행기가 전용 브리지를 직접 소유하며 V06은 정상 재시작이지 충돌 복구가 아닙니다.
- LiteLLM, 6개 밖의 모델, 결과에 기록되지 않은 다른 호스트·런타임 조합.

기록된 실행의 한계는 [검증 결과](docs/VERIFICATION_KO.md)를 보세요. [호환성](docs/COMPATIBILITY_KO.md)에 적힌 구현 지원은 실측 범위를 넓히지 않습니다.

### 지원하지 않는 것

- Anthropic이나 GitHub의 공식 지원과 SLA.
- Windows 기본 셸.
- Remote Control. `ANTHROPIC_BASE_URL`이 사용자 지정 게이트웨이를 가리키면 Claude Code가 끕니다.
- 웹의 Claude Code, `--cloud`, `--teleport`, 모바일 세션, 클라우드 ultrareview. Anthropic 인프라에서 실행되므로 브리지를 거치지 않습니다.
- IDE 확장이나 Claude Desktop이 시작한 Claude Code. 런처를 쓰지 않습니다. IDE의 통합 터미널에서 런처를 실행하면 동작합니다.
- 확장 사고(extended thinking). `thinking` 필드는 무시되고, 응답에는 사고 블록도 서명도 없습니다. 대신 reasoning effort를 전달합니다.
- 인용, 그리고 프롬프트 캐시. `cache_control` 표시는 효과가 없습니다.
- WebSearch. Anthropic 서버에서 실행됩니다.
- `temperature`, `top_p`, `stop_sequences` 같은 샘플링 제어. 브리지는 이 값을 받지만 적용하지 않고 `bridge.degraded_controls`에 기록합니다.

기능별 확인은 [호환성](docs/COMPATIBILITY_KO.md#기능별-확인)을 참고하세요.

### 적합한 용도

| 용도 | 적합성 |
|---|---|
| 개인 실험과 연구 | 적합 |
| Claude Code UI에서 Copilot 모델로 코딩 | 기록된 V01–V06 결과와 필요한 도구 조합을 먼저 확인하세요 |
| 긴 세션과 무인 자동화 | 제한된 핵심 검증만으로 보장하지 않습니다. 요청 한도 복구·자동 압축·장시간 안정성은 범위 밖입니다 |
| 팀이 함께 쓰는 게이트웨이 | 부적합. 모든 요청이 한 사람의 Copilot 좌석으로 실행됩니다 |
| 공식 지원이나 SLA가 필요한 작업 | 부적합 |

## 검증 실행

체크아웃에서 오프라인 확인부터 시작하세요. 두 검사 모두 모델을 호출하지 않습니다.

```bash
cd "/absolute/path/to/claude-code-ghcp-sdk"
npm test
npm run verify -- --dry-run
```

테스트는 실패 없이 끝나야 합니다. dry-run은 예상한 **36개 케이스**를 출력하며 Claude Code·브리지·모델을 실행하지 않습니다. `npm run verify:plan`도 같은 실행기의 dry-run입니다.

실제 연동 근거가 필요하면 [테스트 가이드](docs/TESTING_KO.md)에 따라 `PENDING_TOOL_WAIT_MS=30000`, `--model-concurrency 1`, `--timeout-scale 2`로 6개 모델·시나리오 전체를 실행하고 출력된 정확한 산출물 디렉터리를 확인하세요. 먼저 로컬 모의 API로 설치된 CLI를 사전 검사합니다. 이후 실측은 GitHub Copilot AI Credits를 쓰며 36개 케이스는 API 요청 36개보다 많은 호출을 합니다. `--models`, `--scenarios` 부분 선택은 디버깅용이며 전체 실행을 대신하지 않습니다.

옵션 없는 `npm run verify`도 전체 매트릭스를 선택하며 모델 작업자 1개, `--timeout-scale 1`, export하지 않았다면 브리지 기본값인 `PENDING_TOOL_WAIT_MS=10000`을 씁니다. 어느 명령도 통과를 보장하지 않습니다. 실제 사용한 설정은 [검증 결과](docs/VERIFICATION_KO.md)에 기록합니다.

## 문서 안내

| 알고 싶은 것 | 문서 |
|---|---|
| 브리지 동작 방식과 보안 경계 | [아키텍처](docs/ARCHITECTURE_KO.md) |
| 로그 읽기와 오류 진단 | [진단 가이드](docs/DIAGNOSTICS_KO.md) |
| 테스트 실행, 실패 확인, 결과 문서 생성 | [테스트 가이드](docs/TESTING_KO.md) |
| 특정 Claude Code 기능이 되는지 | [호환성](docs/COMPATIBILITY_KO.md) |
| 마지막으로 기록한 핵심 시나리오의 모델별 결과 | [검증 결과](docs/VERIFICATION_KO.md) |
| LiteLLM 게이트웨이 사용과 운영 | [LiteLLM 가이드](docs/LITELLM_KO.md) |
| 모든 환경 변수와 기본값 | [`.env.example`](.env.example) |
