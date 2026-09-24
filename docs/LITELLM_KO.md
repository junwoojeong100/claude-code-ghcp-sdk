# LiteLLM 설정 가이드

> **언어 / Language:** [English](LITELLM.md) | 한국어

이 문서는 이 저장소의 브리지 앞에 LiteLLM 프록시를 둡니다. 그러면
`./bin/claude-litellm`으로 실행한 Claude Code를 비롯한 LiteLLM 클라이언트가 GitHub
Copilot 모델을 씁니다.

브리지 하나는 GitHub Copilot 좌석(seat) 하나입니다. 게이트웨이를 거치는 모든 요청은 어느
가상 키로 보냈든 운영자의 좌석으로 과금되고, 운영자 조직의 정책을 따릅니다.

LiteLLM은 가상 키와 요청 로그를 더합니다. 대신 Direct 경로에 있는 세 가지를 잃습니다.
Claude Code의 1M 컨텍스트 창, `/model` 목록에 나오는 브리지의 모델 목록, 브리지 자체의
토큰 계산입니다. LiteLLM의 비용 추적과 예산은 Copilot 모델에서 맞지 않습니다. 자세한
내용은 [Direct 경로와 다른 점](#direct-경로와-다른-점)을 보세요.

이 경로는 처음부터 끝까지 검증하지 않았습니다. [검증하지 않은 것](#검증하지-않은-것)을
보세요. Claude Code에서 Copilot 모델만 쓰면 된다면
[Direct 경로](../README_KO.md#빠른-시작-direct-sdk)를 쓰세요.

```text
Claude Code 또는 다른 클라이언트 -> LiteLLM -> 브리지 (src/server.mjs) -> @github/copilot-sdk -> GitHub Copilot
```

LiteLLM은 `anthropic/*` 공급자로 브리지에 연결하며, `api_base`는 브리지 루트입니다.
LiteLLM 자체의 `github_copilot/*` 공급자는 이 저장소를 쓰지 않는 별개의 연동입니다.

## 기존 게이트웨이에 연결

다른 사람이 운영하는 게이트웨이의 URL과 키를 받았다면 이 절을 따르세요. Claude Code,
Node.js, Git, `curl`이 필요합니다. 브리지는 운영자의 컴퓨터에서 실행되므로 `npm install`과
`copilot login`은 필요하지 않습니다.

```bash
git clone https://github.com/junwoojeong100/claude-code-ghcp-sdk.git
cd claude-code-ghcp-sdk

export LITELLM_BASE_URL="https://litellm.example.com"   # /v1 없음
export LITELLM_API_KEY="<받은 가상 키>"

curl --silent --show-error --fail \
  -H "Authorization: Bearer $LITELLM_API_KEY" \
  "$LITELLM_BASE_URL/v1/models"
```

목록의 `id` 값이 게이트웨이가 제공하는 별칭입니다. 이 값이 `LITELLM_MODEL`에 넣을 수 있는
값입니다. `LITELLM_MODEL`의 기본값은 `claude-sonnet-5`이므로, 게이트웨이에 그 이름의
별칭이 없으면 실패합니다.

```bash
export LITELLM_MODEL="claude-sonnet-5"
./bin/claude-litellm
```

규칙은 두 가지입니다.

- `LITELLM_BASE_URL`에는 `/v1`을 붙이지 않습니다. Claude Code가 `/v1/messages`를
  덧붙이며, `claude-litellm`은 `/v1`로 끝나는 URL을 거부합니다.
- 별칭에는 `[1m]`이나 `[NNNk]` 접미사를 붙이지 않습니다. LiteLLM은 대괄호가 붙은 이름을
  `400 Invalid model name`으로 거부합니다.

Claude Code는 Opus, Sonnet, Haiku 선택을 계열 별칭 세 개에 연결하고, 작은 백그라운드
호출은 Haiku 별칭으로 보냅니다. 게이트웨이가 모델을 여러 개 제공하면 다음처럼 설정하세요.

```bash
export LITELLM_OPUS_MODEL="claude-opus-5.5"
export LITELLM_SONNET_MODEL="claude-sonnet-5"
export LITELLM_HAIKU_MODEL="claude-haiku-4.5"
```

설정하지 않은 계열 별칭은 기본 별칭(`LITELLM_MODEL`)을 씁니다. `--litellm-base-url`과
`--litellm-model` 옵션은 환경 변수보다 우선합니다. `claude-litellm`은 `--model`,
`--settings`, `--ghcp-model`을 거부합니다. Claude Code용 공급자 설정은 권한이 `0600`인
임시 파일에 쓰고, Claude Code가 끝나면 지웁니다.

## 게이트웨이 운영

브리지와 LiteLLM을 직접 운영할 때 이 절을 따르세요. `ensure`로 시작한 브리지는 언제나
`127.0.0.1`에서만 요청을 받으므로, LiteLLM은 브리지와 같은 컴퓨터에서 실행해야 합니다.
`ALLOW_NON_LOOPBACK`을 설정해도 달라지지 않습니다.

[README 준비 사항](../README_KO.md#준비-사항),
[Direct 빠른 시작](../README_KO.md#빠른-시작-direct-sdk)의 1단계와 2단계(`npm install`,
`copilot login`), 그리고 `uv`가 필요합니다. `uv`는 설치 스크립트가 Python 3.13 환경을
만들 때 씁니다. 모든 명령은 저장소 루트에서 실행하세요.

### 1. 셸 프로필에 브리지 포트 고정

이 컴퓨터에서 실행하는 `claude`와 `claude-ghcp`는 print 모드 실행(`--background`나
`agents` 없이 쓴 `-p`)을 빼고 모두 공유 백그라운드 브리지 하나를 씁니다
([백그라운드 브리지](../README_KO.md#백그라운드-브리지)). 다른 포트를 요청하거나 포트를
지정하지 않은 실행은 게이트웨이의 브리지를 교체합니다. 이 체크아웃의 `bin/`이 PATH에 있으면
그냥 `claude`로 실행해도 마찬가지입니다. 다음 줄을 셸 프로필(예: `~/.zshrc`)에 추가하고 새
셸을 여세요.

```bash
export GHCP_BRIDGE_PORT=4142
```

`GHCP_BRIDGE_PORT`가 설정되어 있으면 print 모드 실행은 전용 브리지를 같은 포트에 띄웁니다.
게이트웨이의 브리지가 그 포트를 쓰고 있으면 이 실행은
`GitHub Copilot model is unavailable: <model>` 오류로 실패합니다. print 모드에서는 이
변수를 비우세요.

```bash
GHCP_BRIDGE_PORT= ./bin/claude-ghcp -p "..."
```

다른 `--bridge-port`를 지정해도 됩니다.

### 2. 브리지를 시작하고 토큰 받기

다른 터미널과 환경이 같은 평범한 셸에서 실행하세요. 이 셸의 브리지 변수가 다른 터미널과
다르면, 다음에 `claude`를 실행할 때 이 브리지가 교체됩니다
([브리지가 교체될 때](#브리지가-교체될-때)).

```bash
export GHCP_BRIDGE_URL="http://127.0.0.1:$GHCP_BRIDGE_PORT"   # 브리지 루트, /v1 없음
GHCP_BRIDGE_TOKEN="$(node src/bridge-daemon.mjs ensure claude-sonnet-5 "$GHCP_BRIDGE_PORT" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).token')" \
  && export GHCP_BRIDGE_TOKEN || unset GHCP_BRIDGE_TOKEN
```

`ensure`는 브리지를 시작하거나, 설정이 같은 브리지가 이미 실행 중이면 그것을 다시 쓰고,
JSON 한 줄을 출력합니다. 그 안의 `token` 필드가 브리지 자격 증명입니다. `ensure`가
실패하면 이유를 출력하고, `GHCP_BRIDGE_TOKEN`은 설정되지 않은 상태로 남습니다.

모델 인자에는 Copilot 계정으로 쓸 수 있는 모델을 넣어야 하며, `ensure`가 이를 확인합니다.
이 인자는 LiteLLM이 제공할 수 있는 별칭을 제한하지 않습니다.

브리지를 확인하세요.

```bash
curl --silent --show-error --fail "$GHCP_BRIDGE_URL/health"

curl --silent --show-error --fail \
  -H "x-api-key: $GHCP_BRIDGE_TOKEN" \
  "$GHCP_BRIDGE_URL/v1/models?all=true"
```

두 번째 호출은 Copilot 카탈로그에 있는 모델 ID를 모두 보여 줍니다. LiteLLM 설정 파일에서
`anthropic/` 뒤에 쓰는 값이 이 ID입니다. `./bin/ghcp-models`는 브리지를 거치지 않고 같은
ID를 출력하며, `claude-fable-*`만 빠집니다. `?all=true`가 없는 `/v1/models`는 Claude
Code의 `/model` 탐색이 쓰는 GPT-6 행을 최대 세 개만 보여 주므로, 모델 확인에 쓰지 마세요.

`GET /health`와 `HEAD /api/hello`를 뺀 모든 브리지 경로는 토큰이 필요하며, 토큰은
`x-api-key`나 `Authorization: Bearer`로 보냅니다. 토큰이 있으면 누구나 사용자의 Copilot
좌석을 쓸 수 있으므로 비밀번호처럼 다루세요([보안 경계](ARCHITECTURE_KO.md#보안-경계)).

### 3. LiteLLM 설치와 시작

2단계와 같은 셸에서 실행하세요.

```bash
npm run litellm:setup   # 최초 1회: LiteLLM v1.97.0을 .runtime/에 설치하고 마스터 키 생성
npm run litellm:start
```

`litellm:start`는 이 셸의 `GHCP_BRIDGE_URL`과 `GHCP_BRIDGE_TOKEN`을 읽습니다. 둘 중
하나라도 없거나 `GHCP_BRIDGE_URL`이 `/v1`로 끝나면 시작하지 않습니다. 기본 설정 파일은
[`examples/litellm-github-copilot.yaml`](../examples/litellm-github-copilot.yaml)이며,
고칠 필요가 없습니다. 이 파일에는 모두 브리지를 가리키는 별칭 여섯 개가 있습니다.
`claude-opus-5.5`, `claude-sonnet-5`, `claude-haiku-4.5`, `gpt-6-astra`, `gpt-6-sol`,
`gpt-6-luna`입니다.

LiteLLM은 `127.0.0.1:4000`에서 요청을 받습니다. 주소는 `LITELLM_HOST`와
`LITELLM_PORT`로, 설정 파일은 `LITELLM_CONFIG`로 바꿉니다. 이 터미널은 열어 두세요.
LiteLLM이 준비되면 `Application startup complete`를 출력합니다.

LiteLLM은 시작할 때 토큰을 한 번만 읽습니다. 브리지가 교체될 때마다 새 토큰으로 LiteLLM을
다시 시작하세요(Ctrl-C 후 `npm run litellm:start`).
[브리지가 교체될 때](#브리지가-교체될-때)를 보세요.

### 4. Claude Code 연결

두 번째 터미널에서 실행하세요.

```bash
export LITELLM_BASE_URL="http://127.0.0.1:4000"
export LITELLM_API_KEY="$(tr -d '\n' < .runtime/litellm-master-key)"
export LITELLM_MODEL="claude-sonnet-5"

./bin/claude-litellm
```

[기존 게이트웨이에 연결](#기존-게이트웨이에-연결)의 내용이 모두 그대로 적용됩니다. URL은
로컬 주소를, 키는 마스터 키를 씁니다.

마스터 키는 게이트웨이 전체를 제어하므로, 다른 사람에게는
[가상 키](https://docs.litellm.ai/docs/proxy/virtual_keys)를 발급하세요. `LITELLM_HOST`를
네트워크 주소로 설정해야만 다른 사람이 게이트웨이에 접속할 수 있습니다. 그렇게 하면 그들이
보내는 모든 요청이 사용자의 Copilot 좌석을 씁니다.

### 5. 선택: 설정 파일 변경

별칭을 추가하거나 이름을 바꾸거나 지우려면 예제 파일을 복사해 사본을 고치고,
`LITELLM_CONFIG=<사본> npm run litellm:start`로 LiteLLM을 시작하세요. 다음은 여섯 항목 중
하나와 전역 설정입니다.

```yaml
model_list:
  - model_name: claude-sonnet-5
    litellm_params:
      model: anthropic/claude-sonnet-5
      api_base: os.environ/GHCP_BRIDGE_URL
      api_key: os.environ/GHCP_BRIDGE_TOKEN

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
  forward_client_headers_to_llm_api: true
```

| 필드 | 넣을 값 | 이유 |
|---|---|---|
| `model_name` | `[1m]`, `[NNNk]`가 없는 아무 이름 | 클라이언트가 요청하는 별칭(`LITELLM_MODEL`)입니다. LiteLLM은 대괄호가 붙은 이름을 거부합니다. |
| `model: anthropic/<id>` | `./bin/ghcp-models`에 나오는 Copilot 모델 ID | LiteLLM은 `anthropic/` 뒤의 문자열을 요청의 `model`로 그대로 보냅니다. 여기에 붙은 `[1m]` 접미사는 브리지가 떼어 내며, Copilot 컨텍스트 등급은 모델에 따라 정해집니다([자세히](ARCHITECTURE_KO.md#모델-탐색과-컨텍스트)). |
| `api_base` | 경로가 없는 브리지 루트 | LiteLLM이 `/v1/messages`를 덧붙입니다. `litellm:start`는 `/v1`로 끝나는 `GHCP_BRIDGE_URL`을 거부하지만, 직접 만든 파일에 적은 `api_base` 값은 검사하지 않습니다. 그런 값은 `404 not_found_error`를 받습니다. |
| `api_key` | `os.environ/GHCP_BRIDGE_TOKEN` | LiteLLM은 이 값을 `x-api-key`로 보내며, 브리지는 이 헤더를 받아들입니다. |
| `forward_client_headers_to_llm_api` | `true` | Claude Code의 `x-claude-code-session-id`와 `x-claude-code-agent-id` 헤더를 브리지로 전달합니다. 브리지는 이 헤더로 대화와 서브에이전트마다 Copilot 세션을 따로 둡니다. |
| `forward_llm_provider_auth_headers` | 설정하지 않음 | 클라이언트 자신의 `x-api-key`를 전달해 `api_key`를 덮어씁니다. |

### 6. 중지

LiteLLM 터미널에서 Ctrl-C를 누르세요. `./bin/claude-ghcp-stop`은 브리지와 아직 실행 중인
교체된 브리지를 모두 중지하고 `bridge.log`를 지웁니다. 이 브리지들을 쓰던 이 컴퓨터의 모든
`claude`, `claude-ghcp` 세션(print 모드 실행 제외)은 연결이 끊깁니다. 재부팅한 뒤 브리지와
LiteLLM은 스스로 다시 시작하지 않으므로 2단계와 3단계를 다시 하세요.

## 브리지가 교체될 때

포트 4142의 브리지가 사라지거나 새 토큰을 받으면 게이트웨이가 멈춥니다. LiteLLM은 시작할
때 읽은 토큰을 계속 쓰므로, 어느 경우든 마지막에 LiteLLM을 다시 시작해야 합니다.

| 원인 | LiteLLM이 받는 것 | 해결 |
|---|---|---|
| `GHCP_BRIDGE_PORT=4142` 없이, 또는 다른 `--bridge-port`로 실행한 `claude`나 `claude-ghcp`(`-p` 제외). 이 체크아웃의 `bin/`이 PATH에 있으면 그냥 실행한 `claude`도 해당합니다. | 처음에는 아무 일도 없습니다. 그 실행은 다른 포트에 새 브리지를 띄우고, 이전 브리지는 계속 LiteLLM에 응답합니다. 이전 브리지는 그 브리지에서 시작한 런처가 모두 끝나고 `RETIRED_IDLE_MS`(기본 1시간) 동안 요청이 없으면 종료합니다. LiteLLM의 요청도 요청으로 치므로, LiteLLM이 그만큼 쉬고 난 뒤에 종료합니다. 그때부터 포트 4142로 가는 LiteLLM의 연결은 거부됩니다. | 게이트웨이 셸에서 2단계를 다시 실행하고 LiteLLM을 다시 시작하세요. 같은 일이 생기지 않도록 1단계를 하세요. |
| 브리지 설정이 바뀐 뒤 포트 4142로 실행한 런처나 `ensure`. 코드를 고치거나 `git pull`로 `src/*.mjs`, `package.json`, `package-lock.json`이 바뀐 경우, 옮기거나 이름을 바꾼 체크아웃 또는 두 번째 체크아웃에서 실행한 경우, `LOG_LEVEL`, `COPILOT_*`, `HOME` 같은 브리지 변수를 새로 설정하거나 지우거나 값을 바꾼 경우입니다. | 곧바로 `401 authentication_error`와 `Invalid bridge credential.` 메시지를 받습니다. 이전 브리지는 중지되고, 포트 4142의 새 브리지는 토큰이 다릅니다. | 아래 `bridge.json`에서 새 토큰을 읽어 `GHCP_BRIDGE_TOKEN`에 넣고(`export`) LiteLLM을 다시 시작하세요. |
| `./bin/claude-ghcp-stop` 실행 또는 재부팅 | 포트 4142로 가는 연결이 거부됩니다. | 2단계를 다시 실행하고 LiteLLM을 다시 시작하세요. |

`./bin/claude-ghcp-status`로 어느 경우인지 구분할 수 있습니다. `port`가 4142가 아니면 첫
번째 경우이고, `"running": false`이면 세 번째 경우입니다. 이 명령은 토큰을 출력하지
않습니다.

토큰은 브리지 데몬 디렉터리의 `bridge.json`에 있습니다.

| 조건 | 경로 |
|---|---|
| `GHCP_DAEMON_DIR`를 설정한 경우 | `$GHCP_DAEMON_DIR/bridge.json` |
| macOS | `~/Library/Caches/claude-code-ghcp-sdk/bridge.json` |
| Linux | `${XDG_CACHE_HOME:-~/.cache}/claude-code-ghcp-sdk/bridge.json` |

```bash
# macOS 경로입니다. 다른 시스템에서는 위 표의 경로를 쓰세요.
export GHCP_BRIDGE_TOKEN="$(node -pe \
  'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).token' \
  ~/Library/Caches/claude-code-ghcp-sdk/bridge.json)"
```

두 번째 경우에는 2단계를 다시 실행하지 말고 파일을 읽으세요. `ensure`는 호출한 셸의
브리지 변수가 실행 중인 브리지와 같을 때만 그 브리지의 토큰을 돌려줍니다. 브리지 변수가 다른
셸에서 실행하면 브리지를 다시 교체해 또 다른 새 토큰을 만들고, 이전 브리지를 쓰던 세션은
연결이 끊깁니다. 설정 변경으로 치는 항목의 전체 목록은
[상주 브리지와 교체](ARCHITECTURE_KO.md#상주-브리지와-교체)에 있습니다.

## Direct 경로와 다른 점

- **컨텍스트 창.** 별칭에는 Claude Code에 1M 창을 알려 주는 `[1m]` 표시를 붙일 수
  없으므로, Claude Code는 모든 별칭에 기본 창인 200K를 씁니다. `claude-litellm`도 컨텍스트
  크기를 따로 지정하지 않습니다. Claude Code에서 1M 창이 필요하면 Direct 경로를 쓰세요
  ([모델](../README_KO.md#모델)).
- **`/model` 목록.** Opus, Sonnet, Haiku 행이 `LiteLLM · <별칭>`이라는 이름으로 나오고,
  `LITELLM_MODEL`이 그 셋 중 하나가 아니면 그 별칭이 한 줄 더 나옵니다. 브리지의 GitHub
  Copilot 모델 목록은 나오지 않습니다.
- **토큰 계산.** Claude Code의 `/v1/messages/count_tokens` 요청에는 LiteLLM이 자체
  추정값으로 답합니다. 이 요청은 브리지까지 가지 않습니다.
- **비용과 예산.** LiteLLM은 GitHub Copilot이 실제로 청구하는 금액이 아니라 자체 가격표로
  요청 비용을 계산합니다. 그래서 비용 대시보드와 지출 예산은 이 모델들에 맞지 않습니다.
  사용량은 GitHub Copilot AI Credits로 확인하세요.
- **샘플링 설정.** `temperature`, `top_p`, `max_tokens`, `stop_sequences`는 두 경로
  모두에서 효과가 없습니다. [적용하지 않는 요청 값](COMPATIBILITY_KO.md#적용하지-않는-요청-값)을
  보세요.
- **오류.** 브리지는 Direct 경로와 같은 상태 코드를 돌려줍니다.
  [업스트림 오류](ARCHITECTURE_KO.md#업스트림-오류)와
  [요청 한도와 타임아웃](../README_KO.md#요청-한도와-타임아웃)을 보세요. 스트리밍 요청이
  첫 텍스트, 추론, 도구 호출 조각을 보내기 전에 실패하면 그 HTTP 상태 코드를 받습니다.
  그 뒤에 실패하면 상태 코드가 이미 `200`인 응답 안에서 같은 오류 유형의 `event: error`
  프레임을 받습니다. 실패한 `/v1/messages` 요청마다 데몬 디렉터리의 `bridge.log`에
  `bridge.request_failed` 줄이 남습니다([로그](ARCHITECTURE_KO.md#로그)).

## 검증하지 않은 것

`npm run verify`는 LiteLLM을 시작하지 않고, Claude Code를 브리지에 직접 연결해 실행합니다.
`npm test`는 가짜 Claude Code 실행 파일을 써서 `claude-litellm` 런처와 이 런처가 쓰는 설정
파일만 검사합니다. `npm run litellm:setup`, `npm run litellm:start`, 예제 설정 파일을
다루는 테스트는 없습니다. 이 문서가 LiteLLM 자체의 동작(만드는 URL, 전달하는 헤더, 거부하는
이름, `count_tokens` 응답 방식, 비용 계산 방식)에 관해 쓴 내용은 `npm run litellm:setup`이
설치하는 v1.97.0 기준이며 검증하지 않았습니다. LiteLLM이 브리지의 `429`나 `529`를
클라이언트에 그대로 넘기는지, 먼저 재시도하는지도 검증하지 않았습니다. 매트릭스가 검증하는
범위는 [되는 것과 안 되는 것](../README_KO.md#되는-것과-안-되는-것)을 보세요.

## 문제 해결

### `GHCP_BRIDGE_URL is required: the bridge root, with no /v1 suffix.`

`npm run litellm:start`를 [2단계](#2-브리지를-시작하고-토큰-받기)의 변수가 없는 셸에서
실행했습니다. 2단계를 실행한 셸에서 다시 실행하세요.

### `GHCP_BRIDGE_TOKEN is required: the token printed by bridge-daemon ensure.`

`npm run litellm:start`를 다른 셸에서 실행했거나, 2단계의 `ensure`가 실패해 토큰이 비어
있습니다. 2단계를 실행한 셸에서 다시 실행하세요. 그 셸에도 토큰이 없다면
[2단계](#2-브리지를-시작하고-토큰-받기)를 다시 실행하고 `ensure`가 출력하는 이유를
확인하세요.

### `GHCP_BRIDGE_URL must not end in /v1; LiteLLM appends /v1/messages.`

`GHCP_BRIDGE_URL`을 브리지 루트인 `http://127.0.0.1:4142`로 설정하세요.

### `Invalid LiteLLM base URL: URL must not end in /v1; Claude Code appends /v1/messages`

`LITELLM_BASE_URL`이나 `--litellm-base-url`에서 `/v1`을 빼세요.

### LiteLLM이 브리지에 연결하지 못함

LiteLLM이 쓰는 포트에서 요청을 받는 브리지가 없어 연결이 거부됩니다.
`./bin/claude-ghcp-status`를 실행하세요. `port`가 4142가 아니면 `GHCP_BRIDGE_PORT` 없이
실행한 런처가 게이트웨이의 브리지를 교체한 것입니다. `"running": false`이면 브리지가
중지되었거나 컴퓨터가 재부팅된 것입니다. 두 경우의 해결 방법은
[브리지가 교체될 때](#브리지가-교체될-때)에 있습니다.

### `401` `authentication_error`: `Invalid bridge credential.`

LiteLLM이 이전 토큰을 쓰고 있습니다. 포트 4142의 브리지가 교체되었거나, 다른 셸에서
설정한 토큰으로 LiteLLM을 시작한 경우입니다. `bridge.json`에서 현재 토큰을 읽어
`GHCP_BRIDGE_TOKEN`에 넣고 LiteLLM을 다시 시작하세요.
[브리지가 교체될 때](#브리지가-교체될-때)를 보세요.

### LiteLLM이 보낸 `400 Invalid model name`

클라이언트가 요청한 별칭이 오타나 `[1m]`, `[NNNk]` 접미사 때문에 LiteLLM 설정 파일의
`model_name`과 맞지 않습니다. 이 요청은 브리지까지 가지 않습니다. LiteLLM `/v1/models`에
나오는 `id`를 쓰세요. `claude-litellm`에서는 `LITELLM_MODEL`, `--litellm-model`, 계열 별칭
세 개를 확인하세요.

### `GitHub Copilot model "<id>" is unavailable. Available adapter models: …`

브리지가 `400 invalid_request_error`로 보내는 오류입니다. 설정 파일에서 `anthropic/` 뒤에
쓴 문자열을 브리지가 모델로 해석하지 못했습니다. 메시지에 쓸 수 있는 ID가 나오며,
`./bin/ghcp-models`도 같은 목록을 출력합니다.

### `GitHub Copilot model is unavailable: <model>`

2단계에서 나왔다면 `ensure`에 넘긴 모델을 Copilot 계정으로 쓸 수 없는 것입니다.
`./bin/ghcp-models`에서 모델을 고르세요.

게이트웨이 컴퓨터에서 실행한 `claude -p`나 `claude-ghcp -p`에서 `HTTP 401` 줄 바로 다음에
나왔다면, print 모드의 전용 브리지가 게이트웨이의 포트를 쓰려 한 것입니다.
`GHCP_BRIDGE_PORT=`로 변수를 비운 채 print 모드를 실행하세요.
[1단계](#1-셸-프로필에-브리지-포트-고정)를 보세요.

### `404` `not_found_error`: `Not found.`

직접 만든 설정 파일의 `api_base`에 경로(대개 `/v1`)가 있습니다. 프로토콜, 호스트, 포트만
쓰세요.

### 다른 대화의 요청이 서로를 기다림

설정 파일에 `forward_client_headers_to_llm_api: true`가 없습니다. 예제 파일에는 이 설정이
있습니다. 이 설정이 없으면 브리지가 대화와 서브에이전트를 구분하지 못해, 모든 요청을 하나의
대화처럼 한 번에 하나씩 처리합니다.

### 포트 4000이 이미 사용 중이라 LiteLLM이 시작하지 않음

다른 포트로 LiteLLM을 시작하고, 클라이언트가 그 포트를 쓰게 하세요.

```bash
LITELLM_PORT=4001 npm run litellm:start
export LITELLM_BASE_URL="http://127.0.0.1:4001"
```

## 공식 문서

- [LiteLLM Anthropic 공급자](https://docs.litellm.ai/docs/providers/anthropic)
- [LiteLLM Anthropic Messages 엔드포인트](https://docs.litellm.ai/docs/anthropic_unified)
- [LiteLLM 가상 키](https://docs.litellm.ai/docs/proxy/virtual_keys)
- [LiteLLM Claude Code 빠른 시작](https://docs.litellm.ai/docs/tutorials/claude_responses_api)
- [LiteLLM Claude Code 호환성 표](https://docs.litellm.ai/docs/claude_code_compatibility)
