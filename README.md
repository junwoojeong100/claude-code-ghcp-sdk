# Claude Code with GitHub Copilot Models

기존 Claude Code의 UI, permissions, hooks, MCP, skills와 tool 실행은 그대로 유지하면서 model
호출만 GitHub Copilot SDK를 통해 GitHub Copilot이 제공하는 model로 연결합니다.

## 가장 일반적인 설치: LiteLLM 없음

이 경로가 repository의 기본 사용법입니다.

```text
Claude Code
  -> 이 repository의 local bridge
  -> @github/copilot-sdk
  -> GitHub Copilot model
```

### 준비 사항

- `claude` 명령이 설치되어 있어야 합니다.
- Node.js 20 이상이 필요합니다.
- 사용자에게 GitHub Copilot 권한이 있어야 합니다.
- 사용할 model이 organization의 Copilot model policy에서 허용돼야 합니다.

### 1. Repository 설치

```bash
git clone https://github.com/junwoojeong100/claude-code-ghcp-sdk.git
cd claude-code-ghcp-sdk
npm install
```

### 2. GitHub Copilot 로그인

```bash
npx copilot login
```

별도의 Anthropic API key는 필요하지 않습니다.

### 3. 환경과 model 확인

```bash
./bin/ghcp-doctor
./bin/ghcp-models
```

`ghcp-models`에 사용할 Claude model이 표시돼야 합니다.

### 4. Claude Code 실행

```bash
# 기본 model: GitHub Copilot의 Claude Sonnet 4.6
./bin/claude-ghcp

# 다른 model 선택
./bin/claude-ghcp --ghcp-model claude-haiku-4.5

# Non-interactive prompt
./bin/claude-ghcp \
  --ghcp-model claude-haiku-4.5 \
  -p "이 repository의 구조를 설명해줘"
```

### 5. `claude` 명령으로 계속 사용

Repository root에서 다음 명령을 한 번 실행합니다.

```bash
echo "export PATH=\"$PWD/bin:\$PATH\"" >> ~/.zshrc
exec zsh
```

설정을 확인합니다.

```bash
command -v claude
# <clone-path>/claude-code-ghcp-sdk/bin/claude
```

이후 어느 directory에서도 다음처럼 실행합니다.

```bash
claude
claude --ghcp-model claude-haiku-4.5
```

기본 model을 변경하려면:

```bash
export GHCP_MODEL=claude-haiku-4.5
claude
```

기존 Claude Code provider를 사용하려면:

```bash
claude-current
```

## LiteLLM을 사용하는 경우

LiteLLM 경로는 위의 local Node.js bridge와 `@github/copilot-sdk` adapter를 통과하지 않는
별도 경로입니다.

```text
Claude Code
  -> LiteLLM /v1/messages
  -> LiteLLM에 구성된 provider
```

### 이미 운영 중인 LiteLLM이 있음

Local LiteLLM 설치나 local Copilot login은 필요하지 않습니다. Gateway 관리자가 제공한
base URL, scoped virtual key, model alias를 설정합니다.

```bash
export LITELLM_BASE_URL="https://litellm.example.com"
export LITELLM_API_KEY="<scoped-virtual-key>"
export LITELLM_MODEL="claude-sonnet-4-6"

claude-litellm
```

GitHub Copilot 제공 모델이 목적이라면 LiteLLM의 model alias가
`github_copilot/claude-*` backend로 연결돼 있어야 합니다. 다른 provider에 연결된 alias는
GitHub Copilot model을 사용하지 않습니다.

### 이 machine에 LiteLLM도 설치

최초 한 번:

```bash
npm run litellm:setup
npm run litellm:start
```

첫 실행에서 terminal에 표시되는 GitHub device code를 60초 안에 승인합니다.
`npm run litellm:start` terminal은 gateway를 유지하도록 열어 둡니다.

다른 terminal에서:

```bash
cd <clone-path>/claude-code-ghcp-sdk
export LITELLM_BASE_URL="http://127.0.0.1:4000"
export LITELLM_API_KEY="$(tr -d '\n' < .runtime/litellm-master-key)"
export LITELLM_MODEL="claude-sonnet-4-6"

claude-litellm
```

상세한 gateway 구성과 multi-user 인증 주의사항은 [LiteLLM 가이드](docs/LITELLM.md)를
참고합니다.

## 명령 요약

| 목적 | 명령 |
|---|---|
| GitHub Copilot SDK 직접 사용 | `claude` 또는 `claude-ghcp` |
| 허용된 Copilot Claude model 조회 | `ghcp-models` |
| GHCP 환경 진단 | `ghcp-doctor` |
| LiteLLM gateway 사용 | `claude-litellm` |
| 기존 Claude Code provider 사용 | `claude-current` |

`claude-ghcp`는 Claude Code의 `--model` 대신 `--ghcp-model`을 사용합니다. 나머지 Claude
Code option과 prompt는 그대로 전달합니다.

## 기존 Claude Code 설정

`~/.claude/settings.json`을 수정하지 않습니다. Launcher가 실행 중에만 mode `0600` 임시
settings로 provider 값을 override하므로 기존 theme, permissions, hooks, plugins, skills,
MCP와 project settings는 계속 로드됩니다.

Direct GHCP SDK 경로는 종료 시 local bridge와 임시 credential/settings를 삭제합니다.
LiteLLM 경로도 임시 settings를 삭제합니다.

## 검증

```bash
# Unit tests
npm test

# Direct GHCP SDK E2E: text + Claude Code Read tool
npm run test:e2e

# 실행 중인 local LiteLLM 대상 E2E
npm run test:e2e:litellm
```

E2E test는 실제 GitHub Copilot AI Credits를 사용하고 전후
`~/.claude/settings.json` hash가 같은지 확인합니다.

## 지원 상태

검증된 working prototype이며 GitHub와 Anthropic이 공동 지원하는 공식 integration은
아닙니다. Copilot SDK external-tool handoff는 experimental입니다.

기술 구조, 구현 범위, 보안과 production 제약은 [Architecture](docs/ARCHITECTURE.md)를
참고합니다.
