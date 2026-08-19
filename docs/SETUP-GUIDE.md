# 환경별 설치 및 실행 가이드

## 먼저 선택할 경로

```text
LiteLLM gateway가 이미 있는가?
  ├─ Yes
  │   └─ Case B: 기존 LiteLLM gateway 사용
  └─ No
      ├─ LiteLLM이 필요 없음
      │   └─ Case A: GHCP SDK bridge 직접 사용
      └─ 이 machine에 LiteLLM을 설치할 것
          └─ Case C: Local LiteLLM gateway 구성
```

| Case | Model 경로 | Local LiteLLM 설치 | Client의 Copilot login |
|---|---|---|---|
| A. LiteLLM 없음 | Claude Code -> local GHCP SDK bridge -> Copilot | 불필요 | 필요 |
| B. 기존 LiteLLM 있음 | Claude Code -> customer LiteLLM -> configured backend | 불필요 | 일반적으로 불필요 |
| C. Local LiteLLM 설치 | Claude Code -> local LiteLLM -> Copilot | 필요 | LiteLLM용 별도 OAuth 필요 |
| D. 기존 provider 유지 | Claude Code -> 기존 Azure Databricks | 불필요 | 불필요 |

## 공통 준비

Claude Code와 Node.js 20 이상이 필요합니다.

```bash
cd ~/GitHub/claude-code-ghcp-sdk
npm install
```

어느 working directory에서도 repository launcher를 사용하려면 PATH를 한 번 설정합니다.

```bash
echo 'export PATH="$HOME/GitHub/claude-code-ghcp-sdk/bin:$PATH"' >> ~/.zshrc
exec zsh
```

## Case A: LiteLLM 없이 GHCP SDK bridge 직접 사용

### 필요한 것

- GitHub Copilot 사용 권한
- GitHub Copilot CLI
- `copilot login` 완료
- 이 repository의 npm dependency

### 최초 설정

```bash
copilot login
./bin/ghcp-doctor
./bin/ghcp-models
```

### 실행

```bash
# 기본 Claude Sonnet 4.6
claude

# 다른 Copilot model
claude --ghcp-model claude-haiku-4.5
```

이 경로는 매 실행마다 loopback bridge와 임시 credential/settings를 생성하고 종료 시
삭제합니다. `~/.claude/settings.json`은 수정하지 않습니다.

### 확인

```bash
npm run test:e2e
```

## Case B: 이미 운영 중인 LiteLLM gateway 사용

### Local에 설치하지 않는 것

- LiteLLM server runtime
- `.runtime/litellm-src`
- `.runtime/litellm-venv`
- Local LiteLLM GitHub OAuth

Client에는 이 repository의 `claude-litellm` launcher만 필요합니다. Gateway 관리자로부터
다음 세 값을 받아야 합니다.

| 값 | 예 |
|---|---|
| Anthropic-compatible base URL | `https://litellm.example.com` |
| Scoped virtual key | Secret manager에서 받은 key |
| Claude Code용 model alias | `claude-sonnet-4-6` |

Gateway는 `POST /v1/messages`와 `POST /v1/messages/count_tokens`를 지원해야 합니다.
Base URL에는 `/v1`을 붙이지 않습니다.

### Client 설정

```bash
export LITELLM_BASE_URL="https://litellm.example.com"
export LITELLM_API_KEY="<scoped-virtual-key>"
export LITELLM_MODEL="claude-sonnet-4-6"
```

Raw master key를 developer에게 배포하지 말고 model 및 budget scope가 적용된 virtual key를
사용합니다. Raw key를 shell profile이나 repository 파일에 기록하지 않습니다.

### Gateway 확인

```bash
curl --fail \
  -H "Authorization: Bearer $LITELLM_API_KEY" \
  "$LITELLM_BASE_URL/health/liveliness"

curl --fail \
  -H "Authorization: Bearer $LITELLM_API_KEY" \
  "$LITELLM_BASE_URL/v1/models"
```

두 번째 응답에 `LITELLM_MODEL`과 같은 alias가 있어야 합니다.

### 실행

```bash
claude-litellm

# 일회성 model alias 변경
claude-litellm --litellm-model claude-haiku-4-5
```

Gateway가 GitHub Copilot OAuth를 중앙에서 관리한다면 client의 `copilot login`은 필요하지
않습니다. 실제 요구 credential은 gateway backend 구성에 따라 달라집니다.

## Case C: 이 machine에 Local LiteLLM gateway 설치

### 필요한 것

- Claude Code, Node.js 20 이상, 이 repository
- `git`
- `uv`
- Python 3.13을 설치할 수 있는 환경
- GitHub Copilot 사용 권한

이 경로의 model 인증은 LiteLLM 자체 OAuth를 사용하므로 Copilot CLI의 `copilot login`은
필요하지 않습니다.

### 최초 설치

다음 명령은 검증된 LiteLLM commit, Python venv, FastAPI pin, random local master key를
gitignored `.runtime/`에 준비합니다.

```bash
npm run litellm:setup
```

### Gateway 시작 및 OAuth

```bash
npm run litellm:start
```

첫 실행에서 terminal에 표시되는 GitHub device URL과 code를 60초 안에 승인합니다. 이
OAuth는 Copilot CLI의 `copilot login`과 별도이며
`~/.config/litellm/github_copilot`에 저장됩니다. `Application startup complete`가
출력된 terminal은 gateway를 유지하도록 열어 둡니다.

### 다른 terminal에서 실행

```bash
cd ~/GitHub/claude-code-ghcp-sdk
export LITELLM_BASE_URL="http://127.0.0.1:4000"
export LITELLM_API_KEY="$(tr -d '\n' < .runtime/litellm-master-key)"
export LITELLM_MODEL="claude-sonnet-4-6"
claude-litellm
```

### 전체 확인

```bash
npm run test:e2e:litellm
```

이 검증은 health, model discovery, token counting, text response, Claude Code native `Read`
tool loop, 기존 Claude settings 불변을 확인합니다.

## Case D: 기존 Azure Databricks provider 유지

```bash
claude-current
```

이 명령은 GHCP SDK bridge와 LiteLLM을 모두 우회하고 기존 Claude Code settings를 그대로
사용합니다.

## 전환 명령 요약

| 원하는 경로 | 명령 |
|---|---|
| Direct GHCP SDK | `claude` 또는 `claude-ghcp` |
| Existing/customer LiteLLM | `claude-litellm` |
| Local LiteLLM | `npm run litellm:start`, 이후 `claude-litellm` |
| 기존 Azure Databricks | `claude-current` |

상세 LiteLLM 관리자 설정, model mapping, 운영 제한은
[LiteLLM Gateway 연결](LITELLM.md)을 참고합니다.
