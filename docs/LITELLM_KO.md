# LiteLLM 설정 가이드

> **언어 / Language:** [English](LITELLM.md) | 한국어

이 문서는 **이 저장소의 bridge를 LiteLLM proxy 뒤에 두는** 구성을 설명합니다. LiteLLM
client가 `src/server.mjs`를 거쳐 GitHub Copilot 모델에 도달하는 경로입니다. Claude Code만
bridge에 연결하면 되는 경우에는 [README](../README_KO.md#direct-sdk-빠른-시작)를 따릅니다.
LiteLLM은 기능을 추가하지 않고 hop만 하나 더합니다.

## 토폴로지

```text
Direct:  Claude Code -> bridge (src/server.mjs) -> @github/copilot-sdk -> Copilot model
LiteLLM: any client  -> LiteLLM -> bridge (src/server.mjs) -> @github/copilot-sdk -> Copilot model
```

LiteLLM은 자체 `anthropic/*` provider와 bridge root를 가리키는 `api_base`로 구성합니다.
LiteLLM 자체의 `github_copilot/*` provider를 사용하는 구성이 **아닙니다**. 그 provider는
자체 GitHub device-OAuth flow를 실행하고 `~/.config/litellm/github_copilot`에 자체
credential을 보관하며, 이 저장소나 `@github/copilot-sdk`를 전혀 거치지 않습니다. 이
문서의 어떤 구성도 그 provider를 사용하지 않습니다.

Hop을 추가하는 이유는 다음과 같습니다. Bridge는 credential 하나로 loopback caller
하나에게 Anthropic Messages API만 제공하지만, 그 앞에 LiteLLM을 두면 virtual key, budget,
request logging과 OpenAI 형식 surface를 얻습니다.

## 검증 범위

LiteLLM은 이 저장소의 검증 범위 밖입니다. `npm run verify` matrix(6 모델 x 11 시나리오 = 66 슬롯)는 `src/server.mjs`를 직접 실행하며 LiteLLM을 기동하지 않습니다. 이 문서의 구성은 검증된 경로가 아니라 구성 참고 자료입니다.

아래에서 LiteLLM 자체의 wire 동작을 다루는 서술은 `npm run litellm:setup`이 **pin**하는
`v1.97.0`(commit `ef84494`, `scripts/setup-litellm.sh`)을 기준으로 작성한 것으로, 시험
결과가 아니라 pin일 뿐입니다. LiteLLM 버전이 다르면 덧붙이는 경로, 전달하는 header 집합,
거부하는 model 문자열이 달라질 수 있습니다. `src/`에 관한 서술은 성격이 다릅니다. 이
저장소의 소스에서 직접 읽어 파일 단위로 인용합니다. 검증 대상 범위는
[검증 범위](ARCHITECTURE_KO.md#검증-범위)를 참고합니다.

## Bridge가 노출하는 surface

LiteLLM에 지정하는 `api_base`는 매우 좁은 surface에 맞아야 하며, 이 surface는 모두
`src/server.mjs`에 있습니다.

| Method와 경로 | 인증 | 비고 |
|---|---|---|
| `POST /v1/messages` | 필요 | 유일한 inference route |
| `POST /v1/messages/count_tokens` | 필요 | LiteLLM은 호출하지 않습니다 — 알려진 제약 참고 |
| `GET /health` | 없음 | Liveness probe에 사용 가능 |
| `HEAD /api/hello` | 없음 | 인증 gate 앞에서 응답하며 body가 빈 `200` |
| `GET /v1/models` | 필요 | Model catalogue |
| 그 외 | 필요 | `not_found_error`를 담은 `404`. 단 인증 gate가 먼저 실행되므로 credential이 틀리면 `401`입니다 |

인증은 `Authorization: Bearer <token>` **또는** `x-api-key: <token>` 중 **아무 쪽이나**
받습니다. Bridge는 `ALLOW_NON_LOOPBACK=1`을 설정하지 않는 한 loopback에만 bind합니다.

## 준비 사항

- macOS 또는 Linux
- Bash, `curl`, Git
- Node.js `^20.19.0` 또는 `>=22.12.0`
- 로컬 LiteLLM을 실행하려면 `uv`와 Python 3.13
- Bridge 자체를 위한 정상 동작하는 Copilot CLI 로그인 (`copilot login`)

```bash
git clone https://github.com/junwoojeong100/claude-code-ghcp-sdk.git
cd claude-code-ghcp-sdk
npm install
```

이후 모든 명령은 저장소 루트에서 실행합니다.

## 1. 상시 bridge 실행

`bin/claude-ghcp`는 Claude Code와 함께 종료되는 ephemeral bridge를 실행합니다. LiteLLM
에는 실행 한 번보다 오래 유지되는 base URL과 token이 필요하므로 daemon을 사용하고
**port를 고정합니다**. 고정하지 않은 daemon은 비어 있는 port를 임의로 선택합니다.

```bash
export GHCP_BRIDGE_PORT=4142
node src/bridge-daemon.mjs ensure claude-sonnet-5 "$GHCP_BRIDGE_PORT"
```

`ensure`는 registry 전체를 JSON으로 stdout에 출력합니다.

```json
{"createdAt":"...","configFingerprint":"...","instanceId":"...","model":"claude-sonnet-5","pid":12345,"port":4142,"token":"<48-hex-characters>","version":1,"logPath":"...","settingsPath":"..."}
```

여기서 의미 있는 값은 `port`와 `token`뿐입니다. `logPath`는 daemon이 log를 기록하는
경로이고, `settingsPath`는 `ensure`가 호출될 때마다 새로 할당하는 실행별 Claude Code
settings 파일로 LiteLLM 운영자는 무시하면 됩니다.

LiteLLM에 필요한 두 값을 export합니다. URL에 **`/v1`이 없다는 점**에 유의합니다.

```bash
export GHCP_BRIDGE_URL="http://127.0.0.1:$GHCP_BRIDGE_PORT"

# registry를 먼저 받아 두고 파싱합니다. `ensure`는 실패를 stderr로 알리고 stdout을 비운 채
# 0이 아닌 코드로 종료하므로, 곧바로 parser에 pipe하면 실제 메시지가
# `SyntaxError: Unexpected end of JSON input`에 묻힙니다.
GHCP_REGISTRY="$(node src/bridge-daemon.mjs ensure claude-sonnet-5 "$GHCP_BRIDGE_PORT")"
if [ -n "$GHCP_REGISTRY" ]; then
  export GHCP_BRIDGE_TOKEN="$(printf '%s' "$GHCP_REGISTRY" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).token))')"
else
  # Fail-closed로 처리합니다. 이전 실행에서 export한 token은 이 실패를 그대로 살아남아
  # 이미 사라진 bridge를 가리키며, 이후의 검사는 모두 "비어 있지 않은가"만 보므로
  # 오래된 값이 그 검사를 전부 통과합니다.
  unset GHCP_BRIDGE_TOKEN
  echo "ensure가 실패했습니다. 위의 메시지를 확인합니다. GHCP_BRIDGE_TOKEN을 unset했습니다." >&2
  false
fi
```

`else` 분기는 세 가지 일을 하며 각각이 중요합니다. 먼저 `GHCP_BRIDGE_TOKEN`을 그대로 두지
않고 **unset**합니다. 이전 실행에서 export한 token은 `ensure` 실패와 무관하게 살아남지만
이미 사라진 bridge를 가리키고, 이후의 검사는
[`../scripts/start-litellm.sh`](../scripts/start-litellm.sh)의 검사를 포함해 모두 변수가
비어 있지 않은지만 확인합니다. 따라서 살아남은 오래된 token은 gateway를 정상적으로
기동시킨 뒤 startup이 아니라 첫 요청에서 실패하게 만듭니다. 다음으로 안내를 stderr로
출력합니다. 마지막으로 `false`로 끝나므로 `if` 전체가 0이 아닌 상태를 반환하고, 이 블록을
`set -e`로 실행한 script는 여기서 멈춥니다. `exit`을 쓰지 않은 것은 의도적입니다. 블록을
대화형으로 붙여넣으면 shell이 닫히고, source하면 호출한 쪽까지 중단되기 때문입니다.

성공 분기에는 같은 보호가 필요하지 않습니다. `ensure`가 registry JSON이 아닌 무언가를
출력했다면 parser가 stdout을 비운 채 0이 아닌 코드로 종료하고,
`export GHCP_BRIDGE_TOKEN=""`가 기존 값을 빈 값으로 덮어써서 동일한 검사에 걸립니다.

다른 구성을 진행하기 전에 bridge가 살아 있는지 확인합니다.

```bash
curl --silent --show-error --fail "$GHCP_BRIDGE_URL/health"

curl --silent --show-error --fail \
  -H "x-api-key: $GHCP_BRIDGE_TOKEN" \
  "$GHCP_BRIDGE_URL/v1/models"
```

### 나중에 token 복구하기

`./bin/claude-ghcp-status`는 의도적으로 `{model, pid, port, running}`만 출력하며 token은
절대 출력하지 않습니다. Token을 복구하려면 `ensure`를 다시 실행하거나 registry 파일을
직접 읽습니다.

`ensure`는 daemon이 정상이고 fingerprint가 그대로면 기존 registry를 반환합니다. 다만 그
경로에서도 먼저 `modelAvailable()`을 호출하며, 지정한 model이 daemon의
`/v1/models?all=true`에 없으면 `GitHub Copilot model is unavailable: <model>`을
throw합니다(`src/bridge-daemon.mjs`). 따라서 token 복구만을 위한 실행도 그대로 실패할 수
있습니다. 파일을 직접 읽는 경로에는 이런 실패가 없습니다.

| 위치 | 경로 |
|---|---|
| `GHCP_DAEMON_DIR`가 설정된 경우 | `$GHCP_DAEMON_DIR/bridge.json` |
| macOS 기본값 | `~/Library/Caches/claude-code-ghcp-sdk/bridge.json` |
| Linux 기본값 | `${XDG_CACHE_HOME:-~/.cache}/claude-code-ghcp-sdk/bridge.json` |

디렉터리는 `0700`, registry 파일은 `0600`입니다. Token은 password처럼 취급합니다. 이
token을 가진 caller는 사용자의 GitHub Copilot seat를 사용하게 됩니다. Daemon 정지는
`./bin/claude-ghcp-stop`입니다.

### `GHCP_BRIDGE_PORT` 함정

`bin/claude-ghcp`는 `GHCP_BRIDGE_PORT`를 bridge port로 사용하지만, 비어 있는 port를
스스로 선택하는 것은 ephemeral mode뿐입니다. Persistent mode, 즉 `--background`, `--bg`
또는 `agents` subcommand에서 `GHCP_BRIDGE_PORT`가 설정돼 있지 않으면 요청 port **없이**
`ensure`를 호출합니다.

요청 port는 daemon의 configuration fingerprint(`src/bridge-daemon.mjs`의
`daemonConfigFingerprint`)에 포함됩니다. 따라서 LiteLLM용으로
`ensure claude-sonnet-5 4142`를 실행한 뒤 다른 shell에서 이 변수 없이
`claude-ghcp --background`를 실행하면 fingerprint가 어긋납니다. Launcher가 기존 daemon을
정지하고 **새 token**과 함께 새 random port에서 daemon을 시작하므로, LiteLLM은 `4142`에서
connection refused를 받습니다.

`GHCP_BRIDGE_PORT=4142`를 **양쪽** shell에서, 즉 `ensure` 앞과 launcher 앞에서 모두
export하면 fingerprint가 일치합니다.

### Daemon은 실행 디렉터리를 상속합니다

`ensureDaemon`은 `cwd` 옵션 없이 `src/server.mjs`를 spawn하므로 daemon은 `ensure`를
실행한 쪽의 작업 디렉터리를 상속합니다. 이 디렉터리는 Copilot data 디렉터리가
*아닙니다*. `src/session-manager.mjs`는 `CopilotClient`를 `mode`, `baseDirectory`,
`logLevel`만으로 생성하고, `baseDirectory`는
`resolveCopilotHome(process.env.COPILOT_HOME)`, 즉 기본값 `~/.copilot`이며 cwd가 아닙니다.
`sessionOptions`도 `workingDirectory`를 설정하지 않는데, `@github/copilot-sdk`의
`types.d.ts`에 따르면 이 경우 runtime process가 caller의 cwd를 그대로 상속합니다. 즉
상속된 디렉터리는 daemon이 살아 있는 동안 계속 따라다니므로, `ensure`는 그보다 오래
남을 위치에서 실행합니다.

Session 생성이 실패할 때 SDK가 무엇을 raise하든 `src/server.mjs`는 `error.message`를
그대로 전달하며 자체 prefix를 붙이지 않습니다. Non-streaming 요청에는
`type: "api_error"`를 담은 `500`, streaming 요청에는 같은 `api_error`를 담은
`event: error` frame입니다(`src/anthropic.mjs`의 `writeSseError`). 고정된 문자열로
matching하지 말고 message 자체를 읽습니다. 실행 디렉터리가 원인이라면
`./bin/claude-ghcp-stop`을 실행하고 남아 있는 디렉터리에서 `ensure`를 다시 실행합니다.

## 2. Bridge backend mapping

예제 구성은
[`../examples/litellm-github-copilot.yaml`](../examples/litellm-github-copilot.yaml)에
있습니다.

```yaml
model_list:
  - model_name: claude-sonnet-5
    litellm_params:
      model: anthropic/claude-sonnet-5
      api_base: os.environ/GHCP_BRIDGE_URL      # bridge root, no /v1
      api_key: os.environ/GHCP_BRIDGE_TOKEN

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
  forward_client_headers_to_llm_api: true
```

| 항목 | 역할 | 이렇게 작성하는 이유 |
|---|---|---|
| `model_name` | Client가 요청하는 alias | 자유 형식입니다. `LITELLM_MODEL`과 `--litellm-model`이 일치시켜야 하는 값이며 LiteLLM의 `/v1/models`가 반환하는 값입니다 |
| `model: anthropic/<id>` | LiteLLM의 Anthropic provider 선택 | `anthropic/` 뒤 문자열이 그대로 upstream request body의 `model`로 전송되므로 bridge가 resolve하는 ID여야 합니다 |
| `api_base` | Upstream base URL | LiteLLM이 `/v1/messages`를 직접 덧붙이므로 **경로 없는** bridge root를 지정합니다 |
| `api_key` | Upstream credential | `x-api-key` header로 전송되며 bridge가 이를 받습니다 |
| `forward_client_headers_to_llm_api: true` | Client의 `x-*` header를 upstream으로 전달 | Bridge는 Claude session과 subagent마다 Copilot SDK session을 하나씩 유지하기 위해 `x-claude-code-session-id`와 `x-claude-code-agent-id`가 필요합니다. 이 설정이 없으면 모든 요청이 하나의 anonymous session family로 합쳐집니다 |

이 저장소의 예제 파일은 primary matrix의 모델마다 alias를 하나씩 공개합니다.
`PRIMARY_MODELS`(`src/model-map.mjs`, `scripts/verify/scenarios.mjs`에서 재공개)의 여섯
모델인 `claude-opus-5.5`, `claude-sonnet-5`, `claude-haiku-4.5`, `gpt-6-astra`,
`gpt-6-sol`, `gpt-6-luna`입니다. 여섯 개 모두 같은 bridge를 가리킵니다.

### `api_base`는 `/v1`로 끝나면 안 됩니다

LiteLLM은 지정한 `api_base`가 무엇이든 그 뒤에 `/v1/messages`를 덧붙입니다.

| `api_base` | LiteLLM이 실제로 보내는 요청 | 결과 |
|---|---|---|
| `http://127.0.0.1:4142` | `POST http://127.0.0.1:4142/v1/messages` | 정상 |
| `http://127.0.0.1:4142/v1` | `POST http://127.0.0.1:4142/v1/v1/messages` | Credential이 올바른 경우 bridge에서 `404` `not_found_error`. 틀렸다면 인증 gate가 먼저 `401`로 응답합니다 |

`scripts/start-litellm.sh`는 LiteLLM 기동 전에 `/v1`로 끝나는 `GHCP_BRIDGE_URL`을
거부하므로, 이 실수는 runtime `404`가 아니라 기동 오류로 드러납니다.
(`/v1/messages`까지 포함한 전체 URL을 지정할 이유는 `LITELLM_ANTHROPIC_DISABLE_URL_SUFFIX=true`
뿐이며 이 문서는 사용하지 않습니다.)

### `[1m]` context suffix

Bridge는 model을 resolve하기 전에 `[1m]`이나 `[NNNk]` suffix를 제거하며, suffix가 더 큰
backend tier를 선택하지도 않습니다. Claude 모델은 SDK 기본 tier를 유지하고, GPT-6(과
GPT-5.6) 모델은 suffix와 관계없이 long-context tier를 사용합니다
(`src/model-map.mjs`의 `stripContextSuffix`). 따라서 `anthropic/<id>[1m]` backend
문자열은 받아들여지지만 `anthropic/<id>`와 똑같이 동작합니다. LiteLLM은 suffix를
제거하지 않으므로 대괄호가 붙은 alias는 LiteLLM이 찾지 못하고 upstream에서
`400 Invalid model name`으로 거부합니다. 이는 이 저장소가 검증하지 않는 LiteLLM 자체
동작입니다. 대괄호는 `model_name`이나 `--litellm-model`에 넣지 않습니다.

Claude Code는 설정된 모델 이름으로 context window를 정하며, 이 경로에서는 대괄호 없는
alias이므로 기본 window를 유지합니다. `src/write-litellm-settings.mjs`는 context 재정의를
설정하지 않고, Direct 쪽 writer도 상속된 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`를 비울 뿐입니다.
GPT-6 Astra, Sol, Luna에서 1M window를 쓰려면 [README](../README_KO.md#direct-sdk-빠른-시작)의
Direct 경로를 사용합니다. 모델별 `github-copilot/claude-<id>[1m]` launch·picker ID가 그
window를 전달합니다. Claude 행에는 두 경로 모두 1M window를 제공하지 않습니다.

## 3. LiteLLM 실행

```bash
npm run litellm:setup   # once: LiteLLM v1.97.0 source, venv, FastAPI pin, master key
npm run litellm:start
```

`scripts/start-litellm.sh`는 `GHCP_BRIDGE_URL`과 `GHCP_BRIDGE_TOKEN`이 export돼 있지
않으면 실행을 거부합니다. YAML이 두 값을 load 시점에 `os.environ/`로 resolve하므로, 그대로
두면 LiteLLM이 routing 불가능한 model로 기동하기 때문입니다. Config 파일은
`LITELLM_CONFIG`, bind address는 `LITELLM_HOST`, port는 `LITELLM_PORT`로 각각 변경합니다.

`Application startup complete`가 출력된 터미널은 계속 실행해 둡니다.

## 4. Client를 LiteLLM에 연결

Claude Code는 다른 터미널에서 launcher로 실행합니다.

```bash
export LITELLM_BASE_URL="http://127.0.0.1:4000"
export LITELLM_API_KEY="$(tr -d '\n' < .runtime/litellm-master-key)"
export LITELLM_MODEL="claude-sonnet-5"

./bin/claude-litellm
```

`LITELLM_MODEL`에는 config의 `model_name`을 지정하며 `anthropic/...` backend 문자열을
넣지 않습니다. `LITELLM_BASE_URL`도 `/v1`로 끝나면 안 됩니다. Claude Code가 LiteLLM과
같은 방식으로 `/v1/messages`를 덧붙이며 `src/write-litellm-settings.mjs`가 이를
거부합니다. Launcher는 provider settings를 mode `0600` 임시 파일에 기록하고 Claude Code가
종료될 때 삭제합니다.

로컬 단일 사용자 구성에서는 master key를 client key로 그대로 사용합니다. 공유
gateway에서는 사용자별 virtual key를 발급하고 master key는 배포하지 않습니다.

원격 gateway는 실행 전에 확인합니다.

```bash
curl --silent --show-error --fail \
  -H "Authorization: Bearer $LITELLM_API_KEY" \
  "$LITELLM_BASE_URL/health/liveliness"

curl --silent --show-error --fail \
  -H "Authorization: Bearer $LITELLM_API_KEY" \
  "$LITELLM_BASE_URL/v1/models"
```

Gateway가 여러 모델을 공개한다면 family alias를 선택적으로 설정합니다.

```bash
export LITELLM_OPUS_MODEL="claude-opus-5.5"
export LITELLM_SONNET_MODEL="claude-sonnet-5"
export LITELLM_HAIKU_MODEL="claude-haiku-4.5"
```

Alias를 설정하지 않은 family는 `LITELLM_MODEL`로 routing합니다.

## 알려진 제약

- **Bridge는 loopback 전용입니다.** `ALLOW_NON_LOOPBACK=1`을 설정하지 않는 한 LiteLLM은
  같은 host에서 실행해야 하며, 원격 공유 gateway는 bridge에 도달할 수 없습니다. 이 flag를
  켜면 한 사람의 GitHub Copilot seat가 network port에 공개됩니다. LiteLLM이 전달하는 모든
  요청은 보낸 사람과 무관하게 그 seat에 과금되고 그 사용자의 organization policy를
  따릅니다. 여러 사람이 gateway를 사용해야 한다면 사용자마다 bridge와 LiteLLM을 하나씩
  실행하거나 Direct SDK 경로를 사용합니다.
- **Token과 port는 교체됩니다.** `daemonConfigFingerprint`는 관련 환경 변수, clone
  자체의 절대 경로(`implementation.update(rootDir)`), `package.json`,
  `package-lock.json`, 모든 `src/*.mjs` 파일, 요청 port를 hash합니다. 이 중 하나라도
  바뀌면 `ensure`가 기존 daemon을 정지하고 새 random token으로 새 daemon을 시작하며,
  port를 고정하지 않았다면 port도 바뀝니다. 따라서 `src/` 아래를 수정하면 LiteLLM이
  보유한 token이 무효화되며, **clone을 옮기거나 이름을 바꾸는 것**도 마찬가지입니다.
  코드는 그대로여도 두 값이 모두 교체됩니다. Daemon이 재시작될 때마다 `GHCP_BRIDGE_TOKEN`을
  다시 export하고 LiteLLM을 재시작합니다.
- **`count_tokens`는 bridge에 도달하지 않습니다.** LiteLLM이
  `POST /v1/messages/count_tokens`를 로컬 추정값으로 직접 응답하므로, bridge의
  `x-ghcp-token-count-method: estimated` route는 LiteLLM 뒤에서 도달할 수 없습니다. 두
  값은 일치하지 않을 것으로 예상합니다.
- **Model discovery는 Direct 경로 기능입니다.** LiteLLM의 `/v1/models`는 자체 alias를
  반환합니다. Bridge의 gateway discovery row(`backend_id`, `display_name`,
  `capabilities`)는 전달되지 않으므로 Claude Code model picker에 표시되지 않습니다.
- **비용 추적은 구조적으로 부정확합니다.** Copilot model ID가 LiteLLM built-in cost map에
  없어 dashboard 비용이 0이거나 부정확합니다. Dashboard가 아니라 GitHub Copilot AI
  Credits를 기준으로 확인합니다.
- **Sampling control은 무시됩니다.** `temperature`, `top_p`, `max_tokens`,
  `stop_sequences`는 Copilot SDK가 노출하지 않습니다. `GET /health`가 이를
  `unsupportedNativeControls`로 보고하며, bridge는 어느 front end가 보내든 degraded
  control로 기록하고 무시합니다. LiteLLM은 이 값들을 그대로 받아 전달합니다. 그 밖에
  bridge가 받기만 하고 쓰지 않는 필드(`thinking`, `top_k`, `metadata` 등)는
  `ignoredRequestFields`로 보고하고, control 옆에 `ignoredFields`로 기록합니다.
- **`forward_llm_provider_auth_headers`는 설정하지 않습니다.**
  `forward_client_headers_to_llm_api`와는 다른 설정으로, client 자신의 `x-api-key`를
  전달해 구성된 bridge key를 덮어씁니다.
- **로컬 setup은 FastAPI `0.139.0`을 pin합니다.** `scripts/setup-litellm.sh`는
  `litellm[proxy]`를 설치한 뒤 두 번째 `pip install`로 그때 결정된 FastAPI를 덮어씁니다.
  이 pin의 근거는 스크립트에 적혀 있지 않고, 이 저장소에는 LiteLLM `v1.97.0`을 다른
  FastAPI 버전과 함께 시험한 기록도 없습니다. 따라서 이 문서가 설명하는 조합은 pin된
  이 쌍뿐입니다.

## 문제 해결

### Bridge에서 `404` `not_found_error`

`api_base`에 경로가 붙어 있습니다. Scheme, host, port만 지정해야 하며 `/v1/messages`는
LiteLLM이 덧붙입니다. 위에 나열한 다섯 route 외의 요청은 `404`가 되지만, 인증을 통과한
뒤의 이야기입니다. `src/server.mjs`는 `404` fallthrough보다 인증 gate를 먼저 실행하므로,
credential이 없거나 틀린 상태로 보낸 미지의 경로는 `401` `authentication_error`로
돌아옵니다.

### LiteLLM에서 `Connection refused`

LiteLLM에 구성된 port에서 daemon이 listen하고 있지 않습니다. 대부분
`GHCP_BRIDGE_PORT` 함정이 원인이며, 다른 shell에서 실행한 `claude-ghcp --background`가
고정 daemon을 비고정 daemon으로 교체한 경우입니다. `./bin/claude-ghcp-status`로 확인한 뒤
양쪽 shell에 port를 export하고 `ensure`를 다시 실행합니다.

### Bridge에서 `401`

- Daemon이 재시작하면서 token이 교체됐습니다. `ensure`를 다시 실행하고
  `GHCP_BRIDGE_TOKEN`을 다시 export한 뒤 LiteLLM을 재시작합니다.
- LiteLLM 기동 전에 `GHCP_BRIDGE_TOKEN`을 export하지 않았습니다. `os.environ/`는 load
  시점에 resolve합니다.

### `400 Invalid model name`

요청한 model에 `[1m]`이나 `[NNNk]` suffix가 들어 있습니다. LiteLLM은 suffix를 제거하지
않으므로 이는 bridge가 아니라 LiteLLM 쪽의 거부입니다. `model_name`은 대괄호 없이 쓰고
suffix는 `anthropic/` 뒤에 둡니다.

### Bridge에서 오는 `api_error`

어떤 형태로 오는지는 요청이 streaming이었는지에 따라 갈립니다. LiteLLM은 streaming을
사용하므로 평소에 마주치는 쪽은 streaming 열입니다.

| 요청 경로에서 발생한 오류 | Non-streaming | Streaming |
|---|---|---|
| `BridgeRequestError`, `ModelUnavailableError`, `ReasoningEffortUnavailableError` | `400` `invalid_request_error` | `api_error`를 담은 `event: error` |
| 그 외 전부 | `500` `api_error` | `api_error`를 담은 `event: error` |

Non-streaming 경로에서는 `src/server.mjs`가 오류를 분류하며, 위 세 가지는 —
`BridgeRequestError`도 여기 포함됩니다 — `400` `invalid_request_error`가 되고 나머지는
모두 `500` `api_error`가 됩니다.

Streaming 경로에서는 그 분류가 아예 실행되지 않습니다. `src/server.mjs`가 분류에 닿기
전에 `writeSseError`로 빠져나가며 return하고, `src/anthropic.mjs`의 `writeSseError`는
`type: "api_error"`를 고정으로 씁니다. HTTP status는 SSE preamble에서 이미 `200`으로
나갔으므로 `500`도 없습니다. 실패는 오직 `event: error` frame으로만 전달됩니다. 따라서
거부된 model 이름도 LiteLLM에는 `api_error`로 도착하며, non-streaming이었다면 나왔을
`400` `invalid_request_error`로 오지 않습니다.

두 경로 모두 `message`는 원래 오류의 message를 그대로 전달한 것입니다. 따라서 type이나
고정된 문자열로 matching하지 말고 message를 읽습니다. LiteLLM 뒤에서 자주 나오는 원인
하나는 daemon의 실행 디렉터리가 이후 삭제된 경우입니다.
[Daemon은 실행 디렉터리를 상속합니다](#daemon은-실행-디렉터리를-상속합니다)를
참고합니다.

### 모든 대화가 서로 간섭함

`forward_client_headers_to_llm_api`가 없거나 `false`여서 `x-claude-code-session-id`와
`x-claude-code-agent-id`가 bridge에 도달하지 못하고 모든 caller가 하나의 session family를
공유합니다.

### `model not found`

- Alias가 LiteLLM의 `/v1/models` 응답에 있어야 합니다.
- `anthropic/` 뒤 문자열은 bridge가 resolve하는 model이어야 합니다. Bridge의
  `GET /v1/models`로 확인합니다.

### Gateway가 응답하지 않음

```bash
LITELLM_PORT=4001 npm run litellm:start
export LITELLM_BASE_URL="http://127.0.0.1:4001"
```

로컬 gateway의 기본 bind address는 `127.0.0.1`입니다.

## 공식 문서

- [LiteLLM Anthropic provider](https://docs.litellm.ai/docs/providers/anthropic)
- [LiteLLM Anthropic Messages endpoint](https://docs.litellm.ai/docs/anthropic_unified)
- [LiteLLM Claude Code quickstart](https://docs.litellm.ai/docs/tutorials/claude_responses_api)
- [LiteLLM Claude Code compatibility matrix](https://docs.litellm.ai/docs/claude_code_compatibility)
