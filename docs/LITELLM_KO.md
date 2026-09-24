# LiteLLM 설정 가이드

> **언어 / Language:** [English](LITELLM.md) | 한국어

이 가이드는 **이 저장소의 bridge를 LiteLLM proxy 뒤에 두어**, LiteLLM client가
`src/server.mjs`를 거쳐 GitHub Copilot 모델에 도달하게 합니다. Claude Code만 bridge에
연결하면 된다면 [README](../README_KO.md#direct-sdk-빠른-시작)를 따릅니다. LiteLLM은
기능이 아니라 hop만 하나 더합니다.

## 토폴로지

```text
Direct:  Claude Code -> bridge (src/server.mjs) -> @github/copilot-sdk -> Copilot model
LiteLLM: any client  -> LiteLLM -> bridge (src/server.mjs) -> @github/copilot-sdk -> Copilot model
```

LiteLLM은 자체 `anthropic/*` provider를 쓰고 `api_base`를 bridge root로 지정합니다. 이
문서는 LiteLLM 자체의 `github_copilot/*` provider를 **사용하지 않습니다**. 그 provider는
자체 GitHub device-OAuth flow를 실행하고 `~/.config/litellm/github_copilot`에 자체
credential을 보관하며, 이 저장소나 `@github/copilot-sdk`를 전혀 거치지 않습니다.

Bridge는 credential 하나로 loopback caller 하나에게 Anthropic Messages API만 제공합니다.
LiteLLM은 그 앞에 virtual key, budget, request logging과 OpenAI 형식 surface를 더합니다.

## 검증 범위

LiteLLM은 이 저장소의 검증 범위 밖입니다. `npm run verify` matrix(6 모델 x 11 시나리오 =
66 슬롯)는 `src/server.mjs`를 직접 실행하며 LiteLLM을 기동하지 않으므로, 이 문서는 검증된
경로가 아니라 구성 참고 자료입니다.

LiteLLM 자체 동작에 관한 서술은 `npm run litellm:setup`이 pin하는 `v1.97.0`(commit
`ef84494`, `scripts/setup-litellm.sh`)을 기준으로 썼습니다. 시험 결과가 아니라 pin입니다.
다른 버전은 덧붙이는 경로, 전달하는 header, 거부하는 model 문자열이 다를 수 있습니다.
`src/`에 관한 서술은 이 저장소의 소스에서 읽었으며 해당 파일을 밝힙니다. 검증 대상은
[검증 범위](ARCHITECTURE_KO.md#검증-범위)를 참고합니다.

## Bridge가 노출하는 surface

LiteLLM에 지정하는 `api_base`는 이 surface에 맞아야 하며, 모두 `src/server.mjs`에 있습니다.

| Method와 경로 | 인증 | 비고 |
|---|---|---|
| `POST /v1/messages` | 필요 | 유일한 inference route |
| `POST /v1/messages/count_tokens` | 필요 | LiteLLM은 호출하지 않습니다 — 알려진 제약 참고 |
| `GET /health` | 없음 | Liveness probe에 사용 가능 |
| `HEAD /api/hello` | 없음 | 인증 gate 앞에서 응답하며 body가 빈 `200` |
| `GET /v1/models` | 필요 | Model catalogue |
| 그 외 | 필요 | `not_found_error`를 담은 `404`. 단 인증 gate가 먼저 실행되므로 credential이 틀리면 `401`입니다 |

인증은 `Authorization: Bearer <token>`과 `x-api-key: <token>` 중 어느 쪽이든
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

## 1. Persistent bridge 실행

LiteLLM에는 Claude Code 실행 한 번보다 오래 유지되는 bridge URL과 token이 필요하므로
persistent bridge를 사용하고 **port를 고정합니다**. Port를 지정하지 않으면 비어 있는
port를 고릅니다. 이 bridge는 `-p`를 제외한 모든 `claude-ghcp` 실행이 함께 쓰는
bridge입니다. [Persistent bridge와 print mode](../README_KO.md#persistent-bridge와-print-mode)를
참고합니다.

```bash
export GHCP_BRIDGE_PORT=4142
export GHCP_BRIDGE_URL="http://127.0.0.1:$GHCP_BRIDGE_PORT"   # bridge root, /v1 없음

# 실패하면 ensure는 stderr에 메시지를 출력하고 stdout을 비워 둡니다.
GHCP_REGISTRY="$(node src/bridge-daemon.mjs ensure claude-sonnet-5 "$GHCP_BRIDGE_PORT")"
if [ -n "$GHCP_REGISTRY" ]; then
  export GHCP_BRIDGE_TOKEN="$(printf '%s' "$GHCP_REGISTRY" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).token))')"
else
  # Fail closed: 이전 실행에서 남은 token은 이미 사라진 bridge를 가리킵니다.
  unset GHCP_BRIDGE_TOKEN
  echo "ensure가 실패했습니다. 위의 메시지를 확인합니다. GHCP_BRIDGE_TOKEN을 unset했습니다." >&2
  false
fi
```

`ensure`는 bridge를 시작하거나, 같은 구성으로 이미 실행 중이면 그 bridge를 재사용하고,
registry를 JSON 한 줄로 출력합니다.

```json
{"createdAt":"...","configFingerprint":"...","instanceId":"...","model":"claude-sonnet-5","pid":12345,"port":4142,"token":"<48-hex-characters>","version":1,"leasePath":"...","logPath":"...","settingsPath":"..."}
```

LiteLLM에 필요한 값은 `port`와 `token`뿐입니다. `logPath`는 bridge log입니다.
`leasePath`와 `settingsPath`는 `claude-ghcp`용 실행별 경로이므로 무시합니다.

`else` 분기가 `GHCP_BRIDGE_TOKEN`을 unset하는 이유는
[`../scripts/start-litellm.sh`](../scripts/start-litellm.sh)를 포함한 이후의 모든 검사가
변수가 비어 있지 않은지만 보기 때문입니다. 오래된 token이 남아 있으면 gateway는 정상
기동한 뒤 첫 요청에서 실패합니다. `exit` 대신 `false`로 끝나므로 `set -e` script는 여기서
멈추고 대화형 shell은 닫히지 않습니다. `ensure`가 registry JSON이 아닌 것을 출력하면
parser가 실패해 token이 빈 값으로 export되고, 같은 검사가 이를 거부합니다.

다른 구성을 진행하기 전에 bridge가 살아 있는지 확인합니다.

```bash
curl --silent --show-error --fail "$GHCP_BRIDGE_URL/health"

curl --silent --show-error --fail \
  -H "x-api-key: $GHCP_BRIDGE_TOKEN" \
  "$GHCP_BRIDGE_URL/v1/models"
```

Bridge는 daemon 디렉터리(아래)에서 실행되므로 `ensure`를 어느 디렉터리에서 실행해도
상관없습니다.

### 나중에 token 복구하기

`./bin/claude-ghcp-status`는 `{model, pid, port, retired, running}`을 출력하며 token은
출력하지 않습니다. Token은 registry 파일에서 읽습니다.

| 위치 | 경로 |
|---|---|
| `GHCP_DAEMON_DIR`가 설정된 경우 | `$GHCP_DAEMON_DIR/bridge.json` |
| macOS 기본값 | `~/Library/Caches/claude-code-ghcp-sdk/bridge.json` |
| Linux 기본값 | `${XDG_CACHE_HOME:-~/.cache}/claude-code-ghcp-sdk/bridge.json` |

디렉터리는 `0700`, 파일은 `0600`입니다. Token은 password처럼 취급합니다. 이 token이
있으면 누구든 사용자의 GitHub Copilot seat를 사용할 수 있습니다.

`ensure`를 다시 실행해도 token을 받을 수 있지만, 파일을 읽을 때는 없는 실패가 생길 수
있습니다. 실행 중인 bridge를 반환하기 전에 지정한 model을 bridge의
`/v1/models?all=true`와 대조하고, 없으면 `GitHub Copilot model is unavailable: <model>`을
throw합니다(`src/bridge-daemon.mjs`).

`./bin/claude-ghcp-stop`은 이 bridge와 retire된 bridge를 모두 정지합니다. 실행 중인
`claude-ghcp` 세션들이 함께 쓰는 bridge도 여기에 포함됩니다.

### `GHCP_BRIDGE_PORT` 함정

`-p`를 제외한 모든 `claude-ghcp` 실행은 `GHCP_BRIDGE_PORT`(또는 `--bridge-port`)를 요청
port로 삼아 `ensure`를 호출하고, 둘 다 없으면 port 없이 호출합니다. 요청 port는
configuration fingerprint(`src/bridge-daemon.mjs`의 `daemonConfigFingerprint`)에
포함됩니다. 따라서 `GHCP_BRIDGE_PORT=4142`가 없는 shell에서 실행하면 고정한 bridge가
교체됩니다.

1. Launcher가 비어 있는 port에서 새 token으로 새 bridge를 시작합니다.
2. 고정한 bridge는 retire됩니다. Port와 token을 그대로 유지하고 LiteLLM 요청에 계속
   응답합니다.
3. `RETIRED_IDLE_MS`(기본 1시간) 동안 요청이 없고 그 bridge를 쓰던 launcher가 모두
   종료되면 bridge도 종료합니다. 그 뒤 LiteLLM은 connection refused를 받습니다.

`GHCP_BRIDGE_PORT=4142`를 양쪽 shell에서, 즉 `ensure` 앞과 launcher 앞에서 모두
export합니다. Fingerprint의 나머지도 같아야 합니다. 같은 clone과 같은 bridge 환경 변수를
써야 합니다([알려진 제약](#알려진-제약) 참고).

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

대괄호는 `model_name`과 `--litellm-model`에 넣지 않습니다. LiteLLM은 `[1m]`이나
`[NNNk]` suffix를 제거하지 않으므로 대괄호가 붙은 alias를 찾지 못하고
`400 Invalid model name`으로 요청을 거부합니다(이 저장소가 검증하지 않는 LiteLLM
동작입니다).

Bridge 쪽에서도 suffix는 아무 역할을 하지 않습니다. Bridge는 model을 resolve하기 전에
suffix를 제거하고(`src/model-map.mjs`의 `stripContextSuffix`), SDK tier는 모델로
정합니다. GPT-6 Astra, Sol, Luna, GPT-5.6, Claude Opus 5.5, 5, 4.8, 4.7, Claude Sonnet 5는
Copilot catalogue가 1M token 이상을 광고할 때 long-context tier를 받습니다
(`sdkContextOptionsFor`). 따라서 `anthropic/<id>[1m]`은 `anthropic/<id>`와 똑같이
동작합니다.

Claude Code는 설정된 모델 이름으로 자체 context window를 정합니다. 이 경로에서는 대괄호
없는 alias이므로, bridge가 1M tier로 서비스하더라도 Claude Code는 기본 window를
유지합니다. `src/write-litellm-settings.mjs`는 context 재정의를 설정하지 않습니다. Claude
Code에서 1M window를 쓰려면 launch·picker ID에 모델별 `[1m]` hint가 붙는 Direct 경로를
사용합니다. [Claude Code 실행](../README_KO.md#4-claude-code-실행)을 참고합니다.

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
- **구성이 바뀌면 token이 교체됩니다.** `daemonConfigFingerprint`는 bridge 환경
  변수(`COPILOT_*`, `MAX_*`, `RETIRED_IDLE_MS`, 그 밖의 timeout 변수, `GH_TOKEN`,
  `GITHUB_TOKEN`, proxy 변수, `HOME` 등 그곳에 나열된 변수), clone의 절대 경로,
  `package.json`, `package-lock.json`, 모든 `src/*.mjs` 파일, 요청 port를 hash합니다. 이 중
  하나라도 바뀌면 고정 port로 실행한 다음 `ensure`나 `claude-ghcp`가 bridge를 정지하고 같은
  port에서 새 token으로 새 bridge를 시작합니다. `src/` 아래 파일 수정, 새 commit pull,
  clone 이동이나 이름 변경 중 하나만으로도 충분합니다. 교체될 때마다
  `GHCP_BRIDGE_TOKEN`을 다시 export하고 LiteLLM을 재시작합니다.
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
- **Sampling control은 무시됩니다.** Copilot SDK는 `temperature`, `top_p`,
  `max_tokens`, `stop_sequences`를 노출하지 않습니다. LiteLLM은 이 값들을 전달하고,
  bridge는 어느 front end가 보내든 받아서 무시합니다. `GET /health`는 이를
  `unsupportedNativeControls`로 나열하며, 이 값을 보낸 요청은 `bridge.degraded_controls`
  줄을 남깁니다. 그 밖에 bridge가 받기만 하고 쓰지 않는 필드(`thinking`, `top_k`,
  `metadata` 등)는 `ignoredRequestFields`로 나열되고, 같은 줄에 `ignoredFields`로
  기록됩니다.
- **`forward_llm_provider_auth_headers`는 설정하지 않습니다.**
  `forward_client_headers_to_llm_api`와는 다른 설정으로, client 자신의 `x-api-key`를
  전달해 구성된 bridge key를 덮어씁니다.
- **로컬 setup은 FastAPI `0.139.0`을 pin합니다.** `scripts/setup-litellm.sh`는
  `litellm[proxy]`를 설치한 뒤 FastAPI를 `0.139.0`으로 덮어씁니다. Script에는 pin의
  이유가 없으며, 이 문서는 이 조합만 설명합니다.

## 문제 해결

### Bridge에서 `404` `not_found_error`

`api_base`에 경로가 붙어 있습니다. Scheme, host, port만 지정합니다. `/v1/messages`는
LiteLLM이 덧붙입니다. Bridge는 위 route 밖의 경로에 `404`로 응답하지만, 인증을 통과한
뒤의 일입니다. Credential이 없거나 틀리면 같은 요청이 `401` `authentication_error`를
받습니다.

### LiteLLM에서 `Connection refused`

LiteLLM의 port에서 listen하는 bridge가 없습니다. 대부분 `GHCP_BRIDGE_PORT` 없이 실행한
`claude-ghcp`가 고정한 bridge를 retire시켰고, 그 bridge가 이후 종료한 경우입니다
([`GHCP_BRIDGE_PORT` 함정](#ghcp_bridge_port-함정) 참고). `claude-ghcp-stop`으로 정지한
경우일 수도 있습니다. `./bin/claude-ghcp-status`로 확인하고, 양쪽 shell에 port를
export한 뒤 [`ensure` 블록](#1-persistent-bridge-실행)을 다시 실행하고, 새 token으로
LiteLLM을 재시작합니다.

### Bridge에서 `401`

- 그 port의 bridge가 교체되어 token이 바뀌었습니다([알려진 제약](#알려진-제약) 참고).
  `ensure`를 다시 실행하고 `GHCP_BRIDGE_TOKEN`을 다시 export한 뒤 LiteLLM을
  재시작합니다.
- LiteLLM 기동 전에 `GHCP_BRIDGE_TOKEN`을 export하지 않았습니다. `os.environ/`는 load
  시점에 resolve합니다.

### `400 Invalid model name`

요청한 model에 `[1m]`이나 `[NNNk]` suffix가 붙어 있습니다. Bridge가 아니라 LiteLLM이
거부합니다. `model_name`과 `--litellm-model`은 대괄호 없이 씁니다.
[`[1m]` context suffix](#1m-context-suffix)를 참고합니다.

### Bridge에서 `429`, `529` 또는 다른 오류

`src/server.mjs`의 `errorResponse`는
[README](../README_KO.md#rate-limit과-upstream-오류)에 적힌 대로 실패를 매핑합니다.

| 실패 | Status와 type |
|---|---|
| Copilot `rate_limit`이나 `quota` 오류, 또는 upstream HTTP 429 | `429` `rate_limit_error` |
| Upstream HTTP 5xx | `529` `overloaded_error` |
| `BridgeRequestError`(context-limit 오류 포함), `ModelUnavailableError`, `ReasoningEffortUnavailableError` | `400` `invalid_request_error` |
| 그 밖의 오류 | `500` `api_error` |

LiteLLM은 streaming을 사용합니다. Bridge는 모델의 첫 text, reasoning 또는 tool-call
delta에서 streaming 응답을 시작합니다. 그 전에 난 실패는 위 status를 받습니다. 그 뒤의
실패는 status가 이미 `200`인 응답에 같은 type의 `event: error` frame으로 도착합니다
(`src/anthropic.mjs`의 `writeSseError`). SDK가 retry 시간을 알려 주지 않으므로 bridge는
`retry-after` header를 보내지 않습니다. LiteLLM이 이를 자기 client에 어떻게 전달하는지는
이 저장소가 검증하지 않는 LiteLLM 동작입니다.

`message`는 원래 오류의 message를 그대로 전달한 것이므로, 고정된 문자열로 matching하지
말고 message를 읽습니다. 실패마다 status와 type을 담은 content-free
`bridge.request_failed` 줄이 daemon 디렉터리의 `bridge.log`에 기록됩니다.

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
