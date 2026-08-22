# LiteLLM 설정 가이드

이 문서는 LiteLLM client 연결, 로컬 gateway 설치, 공유 gateway 운영을 설명합니다.
Direct SDK만 사용하려면 [README](../README.md#direct-sdk-빠른-시작)를 따릅니다.

## 구성 선택

LiteLLM은 Direct GitHub Copilot SDK와 별도 경로입니다.

```text
Direct:  Claude Code -> 로컬 bridge -> @github/copilot-sdk -> Copilot model
LiteLLM: Claude Code -> LiteLLM -> LiteLLM에 구성된 provider
```

GitHub Copilot 제공 모델을 LiteLLM으로 사용하려면 LiteLLM model이
`github_copilot/claude-*` backend로 구성돼 있어야 합니다.

이 저장소의 LiteLLM mapping과 E2E는 Claude Sonnet 5만 검증했습니다. GPT-5.6 Sol, Terra,
Luna를 사용하려면 검증된 Direct `claude-ghcp` 경로를 선택합니다.

사용 환경에 맞는 절차 하나만 수행합니다.

| 상황 | 진행할 절차 |
|---|---|
| 조직이나 팀의 gateway가 있음 | [기존 gateway에 연결](#기존-litellm-gateway에-연결) |
| 이 컴퓨터에 개인용 gateway가 필요함 | [로컬 gateway 설치](#로컬-litellm-설치) |

## 공통 준비

- macOS 또는 Linux
- Bash와 `curl`
- Claude Code
- Node.js `^20.19.0` 또는 `>=22.12.0`
- Git

두 절차 모두 이 저장소의 `claude-litellm` 실행 스크립트를 사용합니다.

```bash
git clone https://github.com/junwoojeong100/claude-code-ghcp-sdk.git
cd claude-code-ghcp-sdk
```

이후 모든 명령은 별도 안내가 없으면 저장소 루트에서 실행합니다.

## 기존 LiteLLM gateway에 연결

이 절차에는 gateway 설치, Python, `uv`, `npm install`, 로컬 Copilot OAuth가 필요하지
않습니다.

### 1. 연결 정보 확인

- Anthropic-compatible base URL
- 사용자 또는 팀 범위의 virtual key
- Claude Code에 공개된 model alias

### 2. 환경 변수 설정

```bash
export LITELLM_BASE_URL="https://litellm.example.com"
export LITELLM_API_KEY="<scoped-virtual-key>"
export LITELLM_MODEL="claude-sonnet-5"
```

Base URL 끝에는 `/v1`을 붙이지 않습니다. 공유 gateway에서는 master key가 아닌 scoped
virtual key를 사용합니다. Key를 저장소나 셸 설정 파일에 저장하지 않습니다.

### 3. 연결 확인

```bash
curl --fail \
  -H "Authorization: Bearer $LITELLM_API_KEY" \
  "$LITELLM_BASE_URL/health/liveliness"

curl --fail \
  -H "Authorization: Bearer $LITELLM_API_KEY" \
  "$LITELLM_BASE_URL/v1/models"
```

위 `******`는 실제 실행 시 `Bearer $LITELLM_API_KEY`로 바꿉니다.

`/v1/models` 응답에 `LITELLM_MODEL`과 같은 alias가 있어야 합니다.

### 4. Claude Code 실행

```bash
./bin/claude-litellm
```

다른 모델을 사용하려면 `/v1/models` 응답에 있는 alias를 지정합니다.

```bash
./bin/claude-litellm --litellm-model "<gateway-model-alias>"
```

`bin`이 PATH에 있다면 `./bin/`을 생략할 수 있습니다.

## 로컬 LiteLLM 설치

개인용 gateway를 현재 컴퓨터에서 실행하는 절차입니다.

### 추가 준비 사항

- `uv`와 Python 3.13
- GitHub Copilot 사용 권한

### 1. Runtime 설치

```bash
npm run litellm:setup
```

Git 추적에서 제외된 `.runtime/` 디렉터리에 다음 항목을 생성합니다.

- LiteLLM `v1.97.0` source
- Python virtual environment
- FastAPI `0.139.0` pin
- 권한이 `0600`인 임의의 로컬 master key

### 2. Gateway 실행

```bash
npm run litellm:start
```

`Application startup complete`가 출력된 터미널은 계속 실행해 둡니다.

### 3. 다른 터미널에서 Claude Code 실행

```bash
cd <clone-path>/claude-code-ghcp-sdk
export LITELLM_BASE_URL="http://127.0.0.1:4000"
export LITELLM_API_KEY="$(tr -d '\n' < .runtime/litellm-master-key)"
export LITELLM_MODEL="claude-sonnet-5"

./bin/claude-litellm
```

로컬 단일 사용자 구성에서는 setup이 생성한 master key를 client key로 사용합니다.

저장된 LiteLLM Copilot token이 없으면 첫 모델 요청 때 gateway 터미널에 GitHub device
code가 표시됩니다. 60초 안에 승인합니다. 이 인증은 Copilot CLI의 `copilot login`과
별개이며 기본 저장 위치는 `~/.config/litellm/github_copilot`입니다.

### 4. 선택: E2E 실행

```bash
npm run test:e2e:litellm
```

실제 GitHub Copilot AI Credits를 사용합니다. 검증 범위는
[아키텍처 문서의 검증 범위](ARCHITECTURE.md#검증-범위)를 참고합니다.

## Gateway 관리자 설정

공유 gateway를 운영하지 않는다면 이 절은 건너뜁니다.

### GitHub Copilot backend mapping

검증된 최소 구성은 `examples/litellm-github-copilot.yaml`에 있습니다.

```yaml
model_list:
  - model_name: claude-sonnet-5
    litellm_params:
      model: github_copilot/claude-sonnet-5

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
```

Client에는 `claude-sonnet-5` alias를 공개하고 backend는
`github_copilot/claude-sonnet-5`를 연결합니다.

다른 provider는 `litellm_params.model`을 해당 provider model ID로 변경합니다. Client
사용법은 같지만 GitHub Copilot 모델을 사용하는 구성은 아닙니다.

### 선택: Model family mapping

Gateway가 family별 alias를 제공하면 다음 값을 설정합니다.

```bash
export LITELLM_OPUS_MODEL="corp-claude-opus"
export LITELLM_SONNET_MODEL="corp-claude-sonnet"
export LITELLM_HAIKU_MODEL="corp-claude-haiku"
```

설정하지 않은 family는 `LITELLM_MODEL`로 routing합니다.

1M context가 지원되면 실행 옵션에 suffix를 사용합니다.

```bash
./bin/claude-litellm --litellm-model 'claude-sonnet-5[1m]'
```

LiteLLM의 `model_name`에는 `[1m]`을 넣지 않습니다.

### 인증과 multi-user 운영

권장 enterprise 구성은 다음과 같습니다.

| 구간 | 인증 |
|---|---|
| 사용자 -> LiteLLM | 사용자별 virtual key, JWT 또는 SSO |
| LiteLLM -> provider | Secret manager에 저장된 provider credential |

GitHub Copilot OAuth는 사용자 seat와 policy에 연결됩니다. 한 사용자의 OAuth를 여러
사용자와 공유하지 마십시오. Per-user OAuth gateway, 사용자별 LiteLLM instance 또는
Direct SDK를 사용합니다.

공유 gateway에서는 로컬 setup의 master key를 배포하지 말고 사용자별 virtual key를
발급합니다.

## 알려진 제약

- 이 저장소의 LiteLLM `1.97.0` 로컬 setup은 FastAPI `0.140.13`과 `0.141.1`에서
  `get_flat_dependant` import 오류가 확인돼 검증된 `0.139.0`을 pin합니다.
- GitHub Copilot 모델은 LiteLLM built-in cost map에 없을 수 있습니다. Dashboard 비용이
  0이거나 부정확하면 GitHub Copilot AI Credits를 기준으로 확인합니다.
- GitHub Copilot backend의 server-side web search는 native 지원이 아닙니다.
- Provider별 tool use, thinking, prompt caching과 multimodal 호환성은 LiteLLM compatibility
  matrix와 고객 환경에서 확인해야 합니다.

## 문제 해결

### `401` 또는 `403`

- `LITELLM_API_KEY`가 scoped virtual key인지 확인합니다.
- 로컬 GitHub Copilot backend는 LiteLLM device OAuth가 완료됐는지 확인합니다.
- Organization policy에서 model이 허용됐는지 확인합니다.

### `model not found`

- `LITELLM_MODEL`이 `/v1/models`에 표시되는지 확인합니다.
- Claude Code alias와 LiteLLM `model_name`이 정확히 같은지 확인합니다.
- Copilot backend ID의 dot version과 client alias의 hyphen version을 구분합니다.

### Gateway가 응답하지 않음

```bash
npm run litellm:start
```

Port `4000`이 이미 사용 중이면 다른 port로 시작하고 client에도 같은 값을 설정합니다.

```bash
LITELLM_PORT=4001 npm run litellm:start
export LITELLM_BASE_URL="http://127.0.0.1:4001"
```

로컬 gateway의 기본 bind address는 `127.0.0.1`입니다.

## 공식 문서

- [LiteLLM Claude Code quickstart](https://docs.litellm.ai/docs/tutorials/claude_responses_api)
- [LiteLLM Anthropic Messages endpoint](https://docs.litellm.ai/docs/anthropic_unified)
- [LiteLLM GitHub Copilot provider](https://docs.litellm.ai/docs/providers/github_copilot)
- [LiteLLM Claude Code compatibility matrix](https://docs.litellm.ai/docs/claude_code_compatibility)
