# Claude Code with GitHub Copilot Models

> **언어 / Language:** [English](README.md) | 한국어

이 저장소는 Claude Code가 GitHub Copilot 모델을 쓰게 해 주는 로컬 브리지입니다. Claude Code는 Anthropic Messages API 요청을 브리지로 보내고, 브리지는 GitHub Copilot SDK(`@github/copilot-sdk`, 1.0.14로 고정)를 통해 이 요청을 Copilot 모델에서 실행합니다. Claude Code는 브리지에 직접 연결할 수도 있고, 앞에 둔 LiteLLM 프록시를 거칠 수도 있습니다. Claude Code의 UI, 도구 실행, 권한, 훅, MCP 서버, 스킬은 그대로 동작합니다.

**비공식 통합입니다.** Anthropic은 Claude가 아닌 모델을 게이트웨이로 연결하는 방식을 지원하지 않으며, 이 조합은 Anthropic도 GitHub도 지원하지 않습니다. 자세한 내용은 [되는 것과 안 되는 것](#되는-것과-안-되는-것)을 참고하세요.

## 경로 선택

| 원하는 것 | 경로 | 명령 |
|---|---|---|
| 내 Copilot 계정을 조직의 모델 정책 그대로 사용 | **Direct SDK** | `./bin/claude-ghcp` |
| 이 브리지 앞에 놓인 LiteLLM 게이트웨이를 거쳐 Copilot 모델 사용 | LiteLLM | `./bin/claude-litellm` |

대부분은 Direct SDK를 쓰면 됩니다. LiteLLM 게이트웨이를 반드시 거쳐야 할 때만 LiteLLM을 고르세요. [LiteLLM (선택)](#litellm-선택)을 참고하세요.

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
npm install
```

### 2. GitHub Copilot 로그인

PATH에 `copilot`이 없다면 Copilot CLI를 설치한 뒤 로그인하세요.

```bash
npm install -g @github/copilot
copilot login
```

Anthropic API 키는 필요하지 않습니다.

### 3. 환경과 모델 확인

```bash
./bin/ghcp-doctor
./bin/ghcp-models
```

두 명령이 모두 성공하고, `ghcp-models` 출력에 사용할 모델이 보이면 됩니다.

### 4. Claude Code 실행

```bash
# 기본 모델 Claude Sonnet 5로 시작
./bin/claude-ghcp

# 다른 모델로 시작
./bin/claude-ghcp --ghcp-model gpt-6-sol

# print 모드(-p): 프롬프트 하나에 답하고 종료
./bin/claude-ghcp --ghcp-model claude-haiku-4.5 -p "이 저장소의 구조를 설명해줘"
```

Claude Code 안에서는 `/model`로 [모델](#모델) 표의 6개 모델 사이를 오갈 수 있습니다.

### 5. 선택: claude를 PATH에 추가

어느 디렉터리에서든 실행하려면 이 저장소의 `bin` 디렉터리를 PATH에 추가하세요. Zsh라면 저장소 루트에서 다음을 실행합니다.

```bash
echo "export PATH=\"$PWD/bin:\$PATH\"" >> ~/.zshrc
exec zsh
command -v claude   # <clone-path>/claude-code-ghcp-sdk/bin/claude
```

다른 셸은 같은 줄을 그 셸의 설정 파일에 넣으세요. 이제 `claude`는 Direct SDK 런처를 실행합니다.

```bash
claude
claude --ghcp-model claude-haiku-4.5

# 기본 모델 바꾸기
export GHCP_MODEL=claude-haiku-4.5

# 원래 공급자로 Claude Code 실행
claude-current
```

## 모델

| `/model` 이름 | `--ghcp-model` ID | Claude Code 컨텍스트 창 | Reasoning effort |
|---|---|---|---|
| Claude Opus 5.5 | `claude-opus-5.5` | 1M | `low`, `medium`, `high`, `xhigh`, `max` |
| Claude Sonnet 5 | `claude-sonnet-5` (기본값) | 1M | `low`, `medium`, `high`, `xhigh`, `max` |
| Claude Haiku 4.5 | `claude-haiku-4.5` | 200K | 지원하지 않음 |
| GPT-6 Astra | `gpt-6-astra` | 1M | `low`, `medium`, `high`, `xhigh`, `max` |
| GPT-6 Sol | `gpt-6-sol` | 1M | `none`, `low`, `medium`, `high`, `xhigh`, `max` |
| GPT-6 Luna | `gpt-6-luna` | 1M | `none`, `low`, `medium`, `high`, `xhigh`, `max` |

`/model` 목록에서 각 행은 `GitHub Copilot · <이름> (<ID>)`로 표시됩니다. 목록에는 이 6개 행과 Claude Code 자체의 `Default` 행만 나옵니다. Claude Code 2.1.280에서 `Default`는 Claude Opus 5.5이고, `--ghcp-model` 없이 실행하면 Claude Sonnet 5로 시작합니다.

Copilot 카탈로그의 다른 모델도 정책이 허용하면 `--ghcp-model`로 쓸 수 있지만 검증하지 않았습니다. `./bin/ghcp-models`로 목록을 볼 수 있습니다.

컨텍스트 창 열은 Claude Code가 계획하는 컨텍스트 크기입니다. 6개 중 5개 모델은 Copilot의 입력 한도가 이보다 작습니다. [긴 대화](#긴-대화)를 참고하세요.

Reasoning effort 값은 2026-09-24에 Copilot 카탈로그가 알려 준 목록입니다. 지금 계정에서 쓸 수 있는 값은 `./bin/ghcp-models --json`으로 확인하세요. 값은 `--effort <level>`이나 `/effort`로 지정합니다. 모델 목록에 없는 값이면 브리지는 그보다 낮은 값 중 가장 가까운 값을 쓰고, 더 낮은 값이 없으면 모델의 가장 낮은 값을 씁니다. 예를 들어 Claude Opus 5.5에 `none`을 주면 `low`로 실행합니다. Reasoning effort를 지원하지 않는 모델에는 값을 보내지 않습니다.

Ultracode(`--effort ultracode`)는 Copilot에 `xhigh`로 전달되고, 목록에 `xhigh`가 없는 모델에서는 그보다 낮은 값 중 가장 가까운 값으로 바뀝니다. Claude Code 2.1.203 이상이 필요하고, 일반 호출보다 GitHub Copilot AI Credits를 더 쓸 수 있습니다.

Claude Opus 5.5, Sonnet 5, Haiku 4.5가 아닌 모델(예: GPT-6 모델)로 시작하면, 모델을 지정하지 않은 서브에이전트는 기본 제공 Explore 서브에이전트를 포함해 시작 모델로 실행합니다. 이 세 Claude 모델로 시작했다면 Claude Code의 기본 동작대로 주 모델을 따릅니다.

컨텍스트 창, 입력 한도, reasoning effort를 정하는 방식은 [아키텍처](docs/ARCHITECTURE_KO.md#모델-탐색과-컨텍스트)를 참고하세요.

## 일상 사용

### 백그라운드 브리지

print 모드를 뺀 모든 `claude-ghcp` 실행은 루프백에서 백그라운드로 도는 브리지 하나를 함께 씁니다. 이 문서에서는 이를 상주 브리지라고 부릅니다(런처 도움말과 영문 문서의 persistent bridge). 대화형 세션, `--background`, `/background`로 넘긴 세션, `agents` 화면이 모두 이 브리지를 씁니다. Claude Code가 끝나도 상주 브리지는 계속 실행되므로 백그라운드 작업이 이어집니다.

- print 모드(`-p`)는 명령이 끝나면 함께 종료되는 전용 브리지를 받습니다. `-p`를 `--background`나 `agents`와 함께 쓰면 상주 브리지를 씁니다.
- `./bin/claude-ghcp-status`는 상주 브리지의 실행 여부, PID와 포트, 처음 시작할 때의 모델, 아직 실행 중인 교체된 브리지 수(`retired`)를 보여 줍니다.
- `./bin/claude-ghcp-stop`은 상주 브리지와 교체된 브리지를 모두 멈추고, `bridge.log`와 실행별 설정 파일을 모두 지웁니다. 이것을 쓰던 세션과 `/background` 작업은 더 이상 동작하지 않으니, 작업을 모두 마친 뒤 실행하세요.
- `--ghcp-model`만 다르면 실행 중인 브리지를 그대로 씁니다. 브리지 설정이 다르면 새 브리지를 시작합니다. 브리지 코드나 의존성이 바뀐 경우, 이 저장소의 다른 체크아웃에서 실행한 경우, `--bridge-port`가 다른 경우, `TURN_IDLE_TIMEOUT_MS` 같은 브리지 환경 변수가 다른 경우가 여기에 해당합니다. 전체 목록은 [아키텍처](docs/ARCHITECTURE_KO.md#상주-브리지와-교체)에 있습니다.
- 교체된 브리지는 이미 열린 세션을 계속 처리합니다. 그 세션의 런처가 모두 끝나고 `RETIRED_IDLE_MS`(기본 1시간) 동안 요청이 없으면 종료합니다. 교체된 뒤에도 계속 처리하는 기능이 없는 예전 버전의 브리지이거나, 새 실행이 그 브리지가 쓰는 포트를 고정했다면 대신 바로 멈춥니다.
- 브리지 파일(`bridge.log`, 레지스트리, 실행별 설정 파일)은 `$GHCP_DAEMON_DIR`가 있으면 그곳에, 없으면 macOS에서는 `~/Library/Caches/claude-code-ghcp-sdk`, Linux에서는 `${XDG_CACHE_HOME:-~/.cache}/claude-code-ghcp-sdk`에 둡니다. 브리지는 자신을 시작한 프로젝트가 아니라 이 디렉터리에서 실행됩니다.

### 체크아웃을 업데이트한 뒤

실행 중인 브리지는 처음 읽은 코드를 계속 씁니다. 체크아웃을 업데이트하면 다음 실행이 새 브리지를 시작하고, 기존 브리지는 이미 열린 세션을 계속 처리합니다(너무 오래된 브리지는 예외입니다. [백그라운드 브리지](#백그라운드-브리지)를 참고하세요). 대화를 새 코드로 옮기려면 Claude Code를 종료한 뒤, 같은 프로젝트 디렉터리에서 같은 모델로 대화를 재개하세요.

```bash
./bin/claude-ghcp --ghcp-model gpt-6-astra --continue
```

다른 저장된 대화를 고르려면 `--resume`을 쓰세요. 재개해도 Claude Code의 대화 기록은 그대로이고 사용자 설정도 바뀌지 않습니다. 바뀐 `/model` 목록을 불러오려면 세션을 다시 시작하세요.

### 긴 대화

대화를 언제 압축할지는 평소처럼 Claude Code가 정합니다. GPT-6 Astra를 뺀 모든 모델은 Copilot의 입력 한도가 Claude Code의 자동 압축 기준보다 낮아서, 긴 대화는 Copilot의 한도에 먼저 닿습니다.

- Copilot이 스스로 대화 기록을 압축하거나 버리려고 하면, 브리지는 메시지가 `prompt is too long`으로 시작하는 400 `invalid_request_error`로 턴을 끝냅니다. 그러면 Claude Code가 자신의 대화 기록을 압축하고 이어 갑니다. 이 넘겨주기는 [검증하지 않았습니다](#검증하지-않은-것).
- Copilot이 컨텍스트 한도 오류를 직접 보고하면, 브리지는 Claude Code가 압축을 시작하는 `prompt is too long` 오류가 아니라 500 `api_error`를 반환합니다. 긴 대화가 이렇게 계속 실패하면 `/compact`를 실행하세요.
- 더 큰 창을 얻으려고 자동 압축을 끄지 마세요.
- 캐시된 입력은 한 번만 세므로 Claude Code의 컨텍스트 표시가 부풀지 않습니다.

모델별 입력 한도는 [아키텍처](docs/ARCHITECTURE_KO.md#모델-탐색과-컨텍스트)를 참고하세요.

### 요청 한도와 타임아웃

Copilot이 요청 한도에 걸리거나 업스트림이 실패하면, Copilot 런타임이 먼저 스스로 재시도하고 `retry-after`가 있으면 그만큼 기다립니다. 기다리는 동안에는 아무것도 스트리밍되지 않으므로, 턴이 1분 넘게 아무 출력 없이 멈춰 보일 수 있습니다. 재시도가 모두 실패하면 브리지는 429 `rate_limit_error`(요청 한도나 할당량) 또는 529 `overloaded_error`(업스트림 5xx)를 반환하고, Claude Code가 자체 백오프로 다시 시도합니다.

모델 진행이 5분 동안 없거나(`TURN_IDLE_TIMEOUT_MS`) 턴이 모두 30분을 넘기면(`TURN_MAX_DURATION_MS`) 턴은 500 `api_error`로 실패합니다. Copilot이 429나 5xx 재시도를 기다리는 중에 둘 중 하나에 걸리면 턴은 대신 429나 529로 실패하므로, Claude Code가 다시 시도합니다.

상주 브리지는 실패한 Messages 요청마다(`bridge.request_failed`), 끝난 턴마다(`bridge.turn_completed`, 요청한 모델과 실제 응답한 모델, 토큰 수 포함) 내용이 담기지 않은 한 줄을 `bridge.log`에 씁니다. 모든 상태 코드는 [업스트림 오류](docs/ARCHITECTURE_KO.md#업스트림-오류), 모든 로그 이벤트는 [로그](docs/ARCHITECTURE_KO.md#로그)를 참고하세요.

## LiteLLM (선택)

가상 키나 요청 로그 때문에 LiteLLM 게이트웨이를 거쳐 Copilot 모델을 써야 할 때만 고르세요. LiteLLM은 이 브리지 앞에 놓일 뿐 브리지를 대신하지 않습니다. 게이트웨이를 거친 모든 요청은 누가 보냈든 브리지 운영자의 Copilot 좌석 하나와 그 조직 정책으로 실행됩니다. 클라이언트에는 이 체크아웃과 Node.js가 필요하지만 `npm install`과 `copilot login`은 필요 없습니다. 6개 모델의 `/model` 목록과 1M 컨텍스트 창은 쓸 수 없고, 이 경로는 [검증하지 않았습니다](#검증하지-않은-것).

```bash
export LITELLM_BASE_URL="https://litellm.example.com"
export LITELLM_API_KEY="<scoped-virtual-key>"
export LITELLM_MODEL="claude-sonnet-5"
./bin/claude-litellm
```

연결 방법, 게이트웨이 운영, Direct SDK와 다른 점은 [LiteLLM 가이드](docs/LITELLM_KO.md)를 참고하세요.

## 명령과 설정

### 명령

| 용도 | 명령 |
|---|---|
| Copilot 모델로 Claude Code 실행 (Direct SDK) | `./bin/claude-ghcp` 또는 `./bin/claude` |
| 계정에서 쓸 수 있는 Copilot 모델 보기 | `./bin/ghcp-models` |
| 환경 점검 | `./bin/ghcp-doctor` |
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
| `GHCP_DAEMON_DIR` | [백그라운드 브리지](#백그라운드-브리지) 참고 | 상주 브리지의 디렉터리 |
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

테마, 권한, 훅, 플러그인, 스킬, MCP 서버, 프로젝트 설정은 모두 그대로 불러옵니다. Claude Code에서 관리형(조직) 설정은 명령줄 설정보다 우선하므로, 강제된 공급자 선택, `availableModels` 목록, MCP 도구 검색 설정은 그대로 적용됩니다. 이 저장소는 이 부분을 테스트하지 않습니다.

print 모드와 `claude-litellm`은 끝날 때 이 파일을 지웁니다. 다른 Direct 실행은 파일을 브리지 디렉터리에 남겨 둡니다. Claude Code가 나중에 `/background` 작업을 이 파일로 다시 시작하기 때문입니다. 남겨 둔 파일을 언제 지우는지는 [브리지가 남기는 파일](docs/ARCHITECTURE_KO.md#브리지가-남기는-파일)을 참고하세요.

브리지는 Copilot CLI 자체의 MCP 서버(`~/.copilot/mcp-config.json`, 작업 공간 파일, 설치된 Copilot 플러그인에 등록된 서버와 기본 제공 `github-mcp-server`)가 자기 세션에서 시작되지 않게 막습니다. 그 설정 자체는 바꾸지 않고, Claude Code의 MCP 서버에도 영향이 없습니다. 자세한 내용은 [Copilot 런타임 MCP 서버](docs/ARCHITECTURE_KO.md#copilot-런타임-mcp-서버)를 참고하세요.

## 되는 것과 안 되는 것

### 검증한 것

마지막 전체 매트릭스 실행은 2026-09-23(KST)에 커밋 `bed30ce`, Claude Code 2.1.280으로 6개 모델 × 11개 시나리오를 돌려 **66개 슬롯을 모두 통과했습니다.** 슬롯은 모델 하나가 시나리오 하나를 실행하는 단위입니다. 시나리오별 결과는 [검증 결과](docs/VERIFICATION_KO.md)에 있습니다.

통과가 보여 주는 것은 다음과 같습니다.

- 각 슬롯은 실제 Claude Code 실행 파일로 브리지, Copilot SDK, 실제 Copilot 모델을 거쳤습니다. 모의 객체는 쓰지 않았습니다.
- 슬롯마다 작업 공간과 Claude Code 설정 디렉터리를 따로 썼습니다.
- 판정은 디스크의 파일, git 기록, 훅 로그, 어떤 도구가 실행됐는지에 대한 Claude Code의 기록으로 했습니다. 모델의 답에서는 테스트 데이터에 심어 둔 값을 확인했고, 그 밖에 두 가지를 더 봤습니다. 여러 단계 시나리오에서는 모든 단계를 마쳤다는 답이 파일과 맞아야 하고, 훅 시나리오에서는 명령이 차단됐다고 답해야 합니다.
- 11개 시나리오는 저장소 검색, plan 모드 턴 뒤의 정확한 Edit와 새 파일 생성, 테스트 수정 반복, 백그라운드 셸 프로세스와 git 커밋·worktree, 소스·텍스트·마크다운·노트북 파일을 고친 뒤 PDF와 이미지를 읽는 4단계 계획, 프로젝트 서브에이전트, Playwright MCP 서버, CLAUDE.md 규칙과 훅·명령·스킬·플러그인·예약 작업, 세션 재개와 포크, 긴 컨텍스트 검색, 런처와 상주 브리지와 백그라운드 에이전트를 다룹니다.

통과한 실행은 기본 설정이 아니었습니다. `--timeout-scale 2`(기본 1), 모델 작업자 3개 × 시나리오 작업자 2개(기본 6 × 2), `PENDING_TOOL_WAIT_MS=30000`을 썼습니다. 이 변수는 Copilot이 도구 호출을 등록할 때까지 브리지가 기다리는 시간입니다. 브리지 기본값은 10000이고, 30000은 그 실행이 시작한 모든 브리지에 전달됐습니다.

`bed30ce` 이후에는 매트릭스를 다시 실행하지 않았습니다. 아래 코드 변경은 그 뒤에 들어왔습니다. 모두 `npm test`로 확인했고, 서브에이전트 모델과 업스트림 429·503 처리는 [검증 이력](docs/VERIFICATION_HISTORY_KO.md)에 기록한 일회성 실측으로도 확인했습니다. 매트릭스로 확인한 것은 없습니다.

- 대화형 세션이 상주 브리지를 쓰고, 교체된 브리지가 열린 세션을 계속 처리합니다(`ceecc8e`).
- Copilot의 요청 한도와 장애를 429/529로 바꿉니다(`9c68f01`). Copilot의 재시도 대기 중에 끊긴 턴도 포함합니다(`9f1649a`).
- 모델을 지정하지 않은 서브에이전트와 Explore가 시작 모델을 유지합니다(`f6c1827`).
- 스트리밍의 각 콘텐츠 블록을 다음 블록이 시작되기 전에 닫습니다(`279caa6`).
- 도구 결과 옆에 온 사용자 텍스트를 그 도구 결과에 합칩니다(`b53208d`).
- 브리지가 받지만 적용하지 않는 요청 필드를 `bridge.degraded_controls`와 `GET /health`에 표시합니다(`7775be6`).
- 끝난 턴마다 내용이 담기지 않은 로그 한 줄을 씁니다(`24989f1`).
- 브리지 자격 증명을 상수 시간 비교로 확인합니다(`9adbc28`).
- macOS의 `/tmp`처럼 심볼릭 링크 디렉터리를 거쳐 이 체크아웃에 접근해도 브리지가 시작됩니다(`909fbc1`).

### 검증하지 않은 것

다음은 매트릭스가 다루지 않으므로 확인되지 않은 것으로 보세요.

- 자동 압축과, 긴 대화를 자동 압축으로 넘기는 컨텍스트 한도 오류. 6개 중 5개 모델은 긴 대화에서 이 경로에 의존합니다.
- Copilot의 요청 한도와 장애 처리(429/529). 오류를 주입한 `npm test`와 일회성 실측만 있습니다.
- `/rewind`와 Esc 취소를 포함한 대화형 터미널 세션. 모든 슬롯은 Claude Code를 대화형 UI 없이 실행합니다. print 모드(`-p`)로 실행하고, 런처 시나리오는 여기에 `--background`와 `agents --json --all`을 더합니다.
- 권한 확인 프롬프트. 여기에 답하는 슬롯이 없습니다. plan 모드 턴 하나와 `acceptEdits`를 쓰는 런처 시나리오를 빼면, 모든 슬롯이 권한 확인을 건너뛰고 실행합니다.
- 실제로 어떤 Copilot 모델이 턴에 응답했는지. 검사는 Claude Code가 요청한 모델 이름을 읽을 뿐, `bridge.turn_completed`에 Copilot이 보고한 모델을 읽지 않습니다.
- WebFetch, 그리고 서브에이전트를 여럿 띄우는 동적 워크플로. 서브에이전트 시나리오는 서브에이전트 하나에만 작업을 넘깁니다.
- 스킬, 플러그인 명령, 예약 작업의 실제 실행. 검사는 이들이 불러와지거나 만들어지는지만 확인합니다.
- 세션 도중의 브리지 재시작. 재개 시나리오는 세 프로세스 내내 브리지 하나를 계속 띄워 둡니다.
- LiteLLM 경로.
- [모델](#모델) 표의 6개 밖의 모델.
- 다른 컴퓨터와 Linux. 실행은 macOS(darwin arm64) 컴퓨터 한 대에서 했습니다.

생성된 목록은 [이 실행으로 검증하지 않은 것](docs/VERIFICATION_KO.md#이-실행으로-검증하지-않은-것)에 있습니다.

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
| Claude Code UI에서 Copilot 모델로 코딩 | 검증한 시나리오에서는 동작합니다. 필요한 도구 조합을 먼저 확인하세요 |
| 긴 세션과 무인 자동화 | 아직 이릅니다. 압축, 요청 한도 복구, 대화형 세션을 끝까지 검증하지 않았습니다 |
| 팀이 함께 쓰는 게이트웨이 | 부적합. 모든 요청이 한 사람의 Copilot 좌석으로 실행됩니다 |
| 공식 지원이나 SLA가 필요한 작업 | 부적합 |

## 검증 실행

```bash
# 단위 테스트와 구조 테스트. 모델을 호출하지 않으며 비용이 없습니다.
npm test

# 마지막으로 통과한 실행과 같은 설정으로 전체 실측 매트릭스 실행.
# 실제 GitHub Copilot AI Credits를 씁니다. 통과한 실행은 479초 걸렸습니다.
PENDING_TOOL_WAIT_MS=30000 npm run verify -- \
  --timeout-scale 2 --model-concurrency 3 --scenario-concurrency 2
```

옵션 없이 `npm run verify`를 실행하면 기본값인 모델 작업자 6개, `--timeout-scale 1`, `PENDING_TOOL_WAIT_MS` 10000을 씁니다. 이 기본값으로 6개 모델 전체 실행이 통과한 적은 없습니다. 다른 옵션, 부분 실행, 판정 방식, `docs/VERIFICATION_KO.md` 생성 방법은 [검증 범위](docs/ARCHITECTURE_KO.md#검증-범위)를 참고하세요.

## 문서 안내

| 알고 싶은 것 | 문서 |
|---|---|
| 브리지 동작 방식, 보안 경계, 검증 방법 | [아키텍처](docs/ARCHITECTURE_KO.md) |
| 특정 Claude Code 기능이 되는지 | [호환성](docs/COMPATIBILITY_KO.md) |
| 마지막 전체 실행의 시나리오별 결과 | [검증 결과](docs/VERIFICATION_KO.md) |
| 이전 실행과 일회성 실측 | [검증 이력](docs/VERIFICATION_HISTORY_KO.md) |
| LiteLLM 게이트웨이 사용과 운영 | [LiteLLM 가이드](docs/LITELLM_KO.md) |
| 모든 환경 변수와 기본값 | [`.env.example`](.env.example) |
