# LiteLLM Gateway 연결

## 결론

고객사가 중앙 LiteLLM gateway를 운영한다면 Claude Code를 LiteLLM의 Anthropic-compatible
`/v1/messages` endpoint에 직접 연결하는 구성이 적합합니다.

```text
Claude Code
  └─ LiteLLM /v1/messages
       └─ GitHub Copilot, Anthropic, Bedrock, Vertex AI, Azure 등의 provider
```

이 경로에서는 이 repository의 local GHCP SDK bridge를 사용하지 않습니다. 기존 경로는
그대로 유지되므로 실행 명령으로 provider를 분리할 수 있습니다.

| 경로 | 명령 | Model credential |
|---|---|---|
| Local GHCP SDK bridge | `claude` 또는 `claude-ghcp` | 기존 `copilot login` |
| Customer LiteLLM gateway | `claude-litellm` | LiteLLM virtual key |
| 기존 user provider | `claude-current` | 기존 Claude settings |

## 어떤 가이드를 사용해야 하나

설치 여부부터 판단해야 한다면 [환경별 설치 및 실행 가이드](SETUP-GUIDE.md)를 먼저
참고합니다.

| Case | 필요한 작업 | 이 문서의 위치 |
|---|---|---|
| 고객사가 이미 LiteLLM을 운영 | URL, virtual key, model alias만 설정 | [운영 중인 고객 gateway 사용](#운영-중인-고객-gateway-사용) |
| 이 machine에서 LiteLLM까지 실행 | Local runtime 설치, OAuth, gateway 시작 | [Local gateway 최초 구성](#local-gateway-최초-구성) |
| LiteLLM 없이 GHCP SDK 직접 사용 | `claude` 또는 `claude-ghcp` 실행 | [README](../README.md#빠른-시작) |
| 원래 Azure Databricks 설정 사용 | `claude-current` 실행 | [Operations](OPERATIONS.md#keep-using-databricks) |

## 운영 중인 고객 gateway 사용

Gateway 관리자로부터 base URL, virtual key, Claude Code에 공개한 model alias를 받습니다.
Master key 대신 사용자 또는 team 범위의 virtual key를 사용하세요.

```bash
export LITELLM_BASE_URL="https://litellm.example.com"
export LITELLM_API_KEY="sk-customer-virtual-key"
export LITELLM_MODEL="claude-sonnet-4-6"

claude-litellm
```

Repository의 `bin`이 PATH에 없다면 `claude-litellm` 대신
`./bin/claude-litellm`을 사용합니다.

`LITELLM_BASE_URL`에는 `/v1`을 붙이지 않습니다. Claude Code가 `/v1/messages`를 자동으로
추가하므로 `https://litellm.example.com/v1`을 지정하면 launcher가 명시적으로 거부합니다.

일회성 model 변경은 다음처럼 실행합니다.

```bash
claude-litellm --litellm-model claude-haiku-4-5
```

`LITELLM_API_KEY`는 command-line option으로 받지 않습니다. Shell history와 process argument에
credential이 남는 것을 방지하기 위한 동작입니다. Launcher는 gateway 설정을 mode `0600`
임시 파일로 만들고 Claude Code 종료 시 삭제합니다. 기존 `~/.claude/settings.json`은
수정하지 않습니다.

고객 환경에서 `claude` 자체를 LiteLLM 경로로 고정하려면 shell alias를 추가할 수 있습니다.

```bash
echo 'alias claude=claude-litellm' >> ~/.zshrc
exec zsh
```

이 경우에도 `claude-current`는 기존 provider, `claude-ghcp`는 local GHCP SDK bridge를
명시적으로 실행합니다.

## Model alias와 family mapping

`--litellm-model` 값은 LiteLLM `config.yaml`의 `model_name`과 정확히 같아야 합니다.
Claude Code의 `/model` family 선택도 gateway alias에 맞추려면 다음 값을 설정합니다.
설정하지 않은 family는 안전하게 `LITELLM_MODEL` 하나로 routing됩니다.

```bash
export LITELLM_OPUS_MODEL="corp-claude-opus"
export LITELLM_SONNET_MODEL="corp-claude-sonnet"
export LITELLM_HAIKU_MODEL="corp-claude-haiku"
export LITELLM_FABLE_MODEL="corp-claude-sonnet"
```

1M context를 지원하는 backend에서는 shell의 `--model`이 아니라 launcher model option에
suffix를 붙입니다.

```bash
claude-litellm --litellm-model 'claude-sonnet-4-6[1m]'
```

LiteLLM `model_name`에는 `[1m]`을 넣지 않습니다. Claude Code가 suffix를 제거하고
`anthropic-beta` header를 전송합니다.

## LiteLLM 관리자 설정

### 이미 운영 중인 gateway

Claude Code에는 unified endpoint를 사용합니다.

```text
ANTHROPIC_BASE_URL=https://litellm.example.com
```

`/anthropic` pass-through endpoint는 Anthropic API를 그대로 중계할 때만 사용합니다. GitHub
Copilot, Bedrock, Azure 등 여러 provider를 alias와 fallback으로 routing하려면 unified
`/v1/messages` endpoint가 필요합니다.

Gateway에는 Claude Code가 요청할 이름과 동일한 `model_name`을 등록합니다.

```yaml
model_list:
  - model_name: claude-sonnet-4-6
    litellm_params:
      model: anthropic/claude-sonnet-4-6
      api_key: os.environ/ANTHROPIC_API_KEY

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
```

Anthropic 외 provider를 사용할 때는 LiteLLM의 provider-specific model ID로
`litellm_params.model`만 바꿉니다. 배포 전에는 LiteLLM의 매일 갱신되는 Claude Code
compatibility matrix에서 tool use, streaming, prompt caching, thinking 등 필요한 기능을
확인해야 합니다.

### GitHub Copilot을 LiteLLM backend로 사용

LiteLLM 1.97 계열에는 GitHub Copilot Claude model의 native Anthropic Messages routing이
포함되어 있습니다. Production에서는 조직이 검증한 stable 1.97 이상 버전과 dependency
lock을 고정하고 upgrade 전에 회귀 테스트를 실행하세요.

## Local gateway 최초 구성

이 repository에서 검증한 version, dependency pin, random local master key를 한 번에
준비합니다. 모든 runtime 파일과 key는 gitignored `.runtime/` 아래에 생성됩니다.

```bash
npm run litellm:setup
npm run litellm:start
```

`examples/litellm-github-copilot.yaml`의 핵심 mapping은 다음과 같습니다.

```yaml
model_list:
  - model_name: claude-sonnet-4-6
    litellm_params:
      model: github_copilot/claude-sonnet-4.6
```

LiteLLM version과 startup probe 설정에 따라 proxy 기동 중 또는 첫 model 요청 시 LiteLLM
자체의 GitHub OAuth device flow를 완료해야 합니다. 이 인증은 Copilot CLI의
`copilot login`과 별도이며 기본 token directory는
`~/.config/litellm/github_copilot`입니다. Container 배포에서는 이 directory를 암호화된
persistent volume으로 관리하고 file permission을 제한합니다.

LiteLLM 1.97.0의 device polling은 code당 60초입니다. Code를 받은 뒤 60초 안에 승인해야
하며, 생성된 `access-token`과 `api-key.json`은 permission을 `0600`으로 제한합니다.
첫 실행에서 terminal에 표시되는 URL과 code로 OAuth를 승인합니다. `Application startup
complete`가 출력되면 다른 terminal에서 아래 검증을 실행합니다.

설정 후 Anthropic Messages endpoint를 먼저 확인합니다.

```bash
export LITELLM_MASTER_KEY="$(tr -d '\n' < .runtime/litellm-master-key)"

curl "http://127.0.0.1:4000/v1/messages" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 64,
    "messages": [{"role": "user", "content": "Reply with OK"}]
  }'
```

개발자에게는 master key가 아니라 model 및 budget scope가 적용된 virtual key를 발급합니다.

### LiteLLM 1.97.0의 FastAPI 호환 오류

LiteLLM 1.97.0 stable을 설치할 때 dependency resolver가 선택한 FastAPI 0.140.13과
0.141.1에서는 다음 import 오류로 proxy가 기동되지 않았습니다.

```text
ImportError: cannot import name 'get_flat_dependant'
```

FastAPI 0.139.0으로 고정하면 CLI와 proxy가 정상 기동됐습니다.

```bash
.runtime/litellm-venv/bin/python -m pip install 'fastapi==0.139.0'
```

새 LiteLLM release나 공식 container image가 이 문제를 수정하면 해당 release의 lock을
우선합니다.

## Local GHCP bridge를 LiteLLM 뒤에 두지 않는 이유

다음 구조는 현재 구현에서 권장하지 않습니다.

```text
Claude Code → central LiteLLM → local GHCP bridge → Copilot SDK
```

- GHCP bridge는 launcher가 매 실행마다 random port와 credential로 생성합니다.
- 기본적으로 loopback에만 bind하며 한 사용자 process lifecycle을 전제로 합니다.
- `ALLOW_NON_LOOPBACK=1`로 중앙 gateway에 노출하면 Copilot identity와 tool/session state의
  보안 경계가 바뀝니다.
- LiteLLM이 GitHub Copilot `/v1/messages`를 직접 지원하므로 별도 bridge hop이 필요하지
  않습니다.

따라서 중앙 gateway에서는 LiteLLM의 `github_copilot/` provider를 사용하고, SDK mode가
반드시 필요한 실험이나 비교 검증에만 기존 `claude-ghcp` 경로를 별도로 유지합니다.

## 현재 local 상태

2026-08-19 기준 다음 상태로 구성되어 있습니다.

| 항목 | 상태 |
|---|---|
| LiteLLM source | `.runtime/litellm-src`, tag `v1.97.0` |
| Python runtime | `.runtime/litellm-venv`, Python 3.13 |
| FastAPI | `0.139.0` |
| Local gateway | `http://127.0.0.1:4000`, 실행 중 |
| Gateway key | `.runtime/litellm-master-key`, mode `0600` |
| GitHub OAuth | 완료, `~/.config/litellm/github_copilot` |
| OAuth file mode | `0600` |
| Exposed model | `claude-sonnet-4-6` |

Gateway를 다시 시작할 때는 repository root에서 foreground process로 실행합니다.

```bash
npm run litellm:start
```

다른 terminal에서 local gateway를 사용하는 방법은 다음과 같습니다.

```bash
export LITELLM_BASE_URL="http://127.0.0.1:4000"
export LITELLM_API_KEY="$(tr -d '\n' < .runtime/litellm-master-key)"
export LITELLM_MODEL="claude-sonnet-4-6"
claude-litellm
```

현재 local E2E 결과는 모두 PASS입니다.

| Check | Result |
|---|---|
| `GET /health/liveliness` | PASS |
| `GET /v1/models` | PASS |
| `POST /v1/messages/count_tokens` | PASS |
| Non-streaming `POST /v1/messages` | PASS |
| Streaming `POST /v1/messages` | PASS |
| Claude Code text response via `claude-litellm` | PASS |
| Claude Code native `Read` tool loop via `claude-litellm` | PASS |
| `~/.claude/settings.json` unchanged | PASS |

전체 Claude Code E2E는 gateway가 실행 중일 때 재현할 수 있습니다.

```bash
npm run test:e2e:litellm
```

LiteLLM 1.97.0은 이 GitHub Copilot model mapping을 built-in cost map에서 찾지 못한다는
warning을 출력합니다. Model 호출과 AIC 과금은 정상 동작하지만 LiteLLM dashboard의
USD/cache 비용은 0 또는 부정확할 수 있습니다. 검증된 AIC 가격 mapping을 별도로 구성하기
전에는 GitHub Copilot의 usage 정보를 과금 기준으로 사용합니다.

## 운영 점검

1. `GET /health/liveliness`, `GET /v1/models`, `POST /v1/messages`,
   `POST /v1/messages/count_tokens`가 virtual key로 성공하는지 확인합니다.
2. Text response뿐 아니라 Claude Code의 `Read` 같은 native tool loop를 검증합니다.
3. Streaming, parallel tools, image/document input, thinking, prompt caching을 사용하는 만큼
   compatibility matrix와 실제 provider에서 테스트합니다.
4. LiteLLM logging에서 prompt와 tool result가 저장되는지 확인하고 고객사의 data retention,
   redaction, audit 정책을 적용합니다.
5. Timeout, retry, fallback이 tool call을 중복 실행하지 않도록 non-idempotent tool 시나리오를
   검증합니다.

## Troubleshooting

### `401` 또는 `403`

- Claude Code에는 LiteLLM virtual key를 `LITELLM_API_KEY`로 전달합니다.
- GitHub Copilot backend라면 LiteLLM server의 device flow가 완료됐는지 확인합니다.
- Organization Copilot model policy에서 선택한 Claude model이 허용됐는지 확인합니다.

### `model not found`

- `LITELLM_MODEL` 또는 `--litellm-model`이 `config.yaml`의 `model_name`과 정확히 같은지
  확인합니다.
- GitHub Copilot backend ID는 `github_copilot/claude-sonnet-4.6`처럼 dot version을 쓰고,
  Claude Code에 공개하는 alias는 `claude-sonnet-4-6`처럼 hyphen version을 사용합니다.

### Tool 또는 beta feature 오류

- LiteLLM stable version과 Claude Code compatibility matrix를 확인합니다.
- Bedrock Invoke를 사용할 때는 LiteLLM 공식 가이드의
  `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` 필요 여부를 확인합니다.
- GitHub Copilot backend의 server-side web search는 native 지원이 아니므로 필요하면
  LiteLLM web-search interception provider를 별도로 구성합니다.
