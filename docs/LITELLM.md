# LiteLLM 가이드

## 먼저 확인할 점

LiteLLM 경로는 direct GitHub Copilot SDK adapter와 별개입니다.

```text
Direct:  Claude Code -> local bridge -> @github/copilot-sdk -> Copilot model
LiteLLM: Claude Code -> LiteLLM -> LiteLLM에 구성된 provider
```

GitHub Copilot 제공 모델을 LiteLLM으로 사용하려면 LiteLLM model이
`github_copilot/claude-*` backend로 구성돼 있어야 합니다.

이 repository에서 GPT-5.6 Sol, Terra, Luna는 direct `claude-ghcp` 경로로 검증했습니다.
LiteLLM의 Anthropic `/v1/messages`용 `github_copilot/` mapping은 Claude model을 대상으로
하므로 세 GPT model은 direct SDK 경로를 사용합니다.

## 이미 운영 중인 LiteLLM 사용

### Gateway에서 받을 정보

- Anthropic-compatible base URL
- 사용자 또는 team 범위의 virtual key
- Claude Code에 공개된 model alias

Local LiteLLM, Python runtime과 local Copilot OAuth는 설치하지 않습니다.

### Client 설정

```bash
export LITELLM_BASE_URL="https://litellm.example.com"
export LITELLM_API_KEY="<scoped-virtual-key>"
export LITELLM_MODEL="claude-sonnet-4-6"
```

Base URL에는 `/v1`을 붙이지 않습니다. Master key 대신 scoped virtual key를 사용하고 raw
key를 repository나 shell profile에 저장하지 않습니다.

Gateway 연결 확인:

```bash
curl --fail \
  -H "Authorization: Bearer $LITELLM_API_KEY" \
  "$LITELLM_BASE_URL/health/liveliness"

curl --fail \
  -H "Authorization: Bearer $LITELLM_API_KEY" \
  "$LITELLM_BASE_URL/v1/models"
```

두 번째 응답에 `LITELLM_MODEL`과 같은 alias가 있어야 합니다.

실행:

```bash
claude-litellm
claude-litellm --litellm-model claude-haiku-4-5
```

Repository `bin`이 PATH에 없다면 `./bin/claude-litellm`을 사용합니다.

## 이 machine에 local LiteLLM 설치

### 준비 사항

- Claude Code
- Node.js 20 이상
- Git
- `uv`와 Python 3.13
- GitHub Copilot 사용 권한

### 1. Runtime 준비

```bash
npm run litellm:setup
```

다음 항목을 gitignored `.runtime/`에 생성합니다.

- LiteLLM `v1.97.0` source
- Python virtual environment
- FastAPI `0.139.0` pin
- Mode `0600` random local master key

### 2. Gateway 시작과 OAuth

```bash
npm run litellm:start
```

첫 실행에서 terminal에 표시되는 GitHub device code를 60초 안에 승인합니다. 이 인증은
Copilot CLI의 `copilot login`과 별도이며 기본적으로
`~/.config/litellm/github_copilot`에 저장됩니다.

`Application startup complete`가 출력된 terminal을 열어 둡니다.

### 3. 다른 terminal에서 Claude Code 실행

```bash
cd <clone-path>/claude-code-ghcp-sdk
export LITELLM_BASE_URL="http://127.0.0.1:4000"
export LITELLM_API_KEY="$(tr -d '\n' < .runtime/litellm-master-key)"
export LITELLM_MODEL="claude-sonnet-4-6"

claude-litellm
```

### 4. E2E 확인

```bash
npm run test:e2e:litellm
```

Health, model discovery, token counting, text response, Claude Code native `Read` tool loop와 기존
Claude settings 불변을 확인합니다.

## GitHub Copilot backend 설정

검증된 최소 mapping은 `examples/litellm-github-copilot.yaml`에 있습니다.

```yaml
model_list:
  - model_name: claude-sonnet-4-6
    litellm_params:
      model: github_copilot/claude-sonnet-4.6

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
```

Claude Code에는 hyphen version alias(`claude-sonnet-4-6`)를 공개하고 LiteLLM backend에는
Copilot dot version(`github_copilot/claude-sonnet-4.6`)을 지정합니다.

다른 provider를 사용하면 `litellm_params.model`만 해당 provider model ID로 변경합니다.
이 경우 Claude Code 사용법은 같지만 GitHub Copilot 제공 모델을 사용하는 경로는 아닙니다.

## Model family mapping

Gateway가 family별 alias를 제공하면 다음 값을 설정합니다.

```bash
export LITELLM_OPUS_MODEL="corp-claude-opus"
export LITELLM_SONNET_MODEL="corp-claude-sonnet"
export LITELLM_HAIKU_MODEL="corp-claude-haiku"
export LITELLM_FABLE_MODEL="corp-claude-sonnet"
```

설정하지 않은 family는 `LITELLM_MODEL` 하나로 routing됩니다.

1M context가 지원되면 launcher option에 suffix를 사용합니다.

```bash
claude-litellm --litellm-model 'claude-sonnet-4-6[1m]'
```

LiteLLM `model_name`에는 `[1m]`을 넣지 않습니다.

## 인증과 multi-user 주의사항

일반적인 enterprise 구성:

| 구간 | 인증 |
|---|---|
| 사용자 -> LiteLLM | 사용자별 virtual key, JWT 또는 SSO |
| LiteLLM -> provider | Secret manager에 저장된 provider credential |

GitHub Copilot OAuth는 사용자 seat와 policy에 연결됩니다. 중앙 LiteLLM에서 한 사용자의 개인
Copilot OAuth를 여러 사용자에게 공유하지 않습니다. Per-user OAuth를 지원하는 gateway
구성, 사용자별 LiteLLM instance 또는 direct GitHub Copilot SDK 경로를 사용합니다.

## 확인된 제약

- LiteLLM `1.97.0`은 FastAPI `0.140.13`과 `0.141.1`에서
  `get_flat_dependant` import 오류가 발생했습니다. Local setup은 검증된 `0.139.0`을
  pin합니다.
- GitHub Copilot model mapping이 LiteLLM built-in cost map에 없어 dashboard의 USD/cache
  비용은 0 또는 부정확할 수 있습니다. 실제 사용량은 GitHub Copilot AIC 기준으로
  확인합니다.
- GitHub Copilot backend의 server-side web search는 native 지원이 아닙니다.
- Provider별 tool use, thinking, prompt caching과 multimodal 호환성은 LiteLLM compatibility
  matrix와 고객 환경에서 확인해야 합니다.

## Troubleshooting

### `401` 또는 `403`

- Client의 `LITELLM_API_KEY`가 scoped virtual key인지 확인합니다.
- Local GitHub Copilot backend는 LiteLLM device OAuth가 완료됐는지 확인합니다.
- Organization policy에서 model이 허용됐는지 확인합니다.

### `model not found`

- `LITELLM_MODEL`이 `/v1/models`에 표시되는지 확인합니다.
- Claude Code alias와 LiteLLM `model_name`이 정확히 같은지 확인합니다.
- Copilot backend ID의 dot version과 client alias의 hyphen version을 구분합니다.

### Gateway가 응답하지 않음

```bash
npm run litellm:start
```

Port `4000`이 이미 사용 중인지 확인하고 local gateway는 `127.0.0.1`에만 노출합니다.

## 공식 문서

- [LiteLLM Claude Code quickstart](https://docs.litellm.ai/docs/tutorials/claude_responses_api)
- [LiteLLM Anthropic Messages endpoint](https://docs.litellm.ai/docs/anthropic_unified)
- [LiteLLM GitHub Copilot provider](https://docs.litellm.ai/docs/providers/github_copilot)
- [LiteLLM Claude Code compatibility matrix](https://docs.litellm.ai/docs/claude_code_compatibility)
