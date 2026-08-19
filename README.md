# Claude Code + GitHub Copilot Models

Claude Code의 terminal UI, permissions, hooks, MCP, skills와 native tool 실행은 그대로
유지하면서 model 호출을 GitHub Copilot이 제공하는 model로 연결하는 compatibility
adapter입니다.

## 어떤 경로를 사용해야 하나

| 환경 | Model 경로 | 시작 명령 |
|---|---|---|
| LiteLLM 없음 | Claude Code -> 이 repository의 bridge -> GitHub Copilot SDK -> Copilot model | `claude` 또는 `claude-ghcp` |
| 기존 LiteLLM 있음 | Claude Code -> LiteLLM -> LiteLLM에 구성된 backend | `claude-litellm` |
| 이 machine에 LiteLLM 설치 | Claude Code -> local LiteLLM -> GitHub Copilot | `npm run litellm:start`, 이후 `claude-litellm` |
| 기존 Claude Code provider 유지 | Claude Code -> 기존 settings의 provider | `claude-current` |

**이 repository의 핵심 경로는 LiteLLM이 없는 첫 번째 경우입니다.** `claude-ghcp`가
loopback Anthropic-compatible bridge를 시작하고 `@github/copilot-sdk`에 model 요청을
전달합니다. LiteLLM 경로는 별도 선택지이며 local Node.js bridge와 Copilot SDK adapter를
통과하지 않습니다.

설치 조건까지 비교하려면 [환경별 설치 및 실행 가이드](docs/SETUP-GUIDE.md)를 참고하세요.

## 빠른 시작: LiteLLM 없이 GitHub Copilot SDK 사용

### 준비 사항

- Claude Code가 설치되어 있고 `claude` 명령을 사용할 수 있어야 합니다.
- GitHub Copilot 사용 권한과 organization에서 허용된 model이 필요합니다.
- Node.js 20 이상이 필요합니다.

### 1. 설치 및 GitHub Copilot 인증

```bash
cd ~/GitHub/claude-code-ghcp-sdk
npm install
npx copilot login
```

`npm install`은 GitHub Copilot SDK와 repository-local Copilot CLI를 설치합니다. 별도의
Anthropic API key는 필요하지 않습니다.

### 2. 인증과 사용 가능한 Claude model 확인

```bash
./bin/ghcp-doctor
./bin/ghcp-models
```

### 3. Claude Code 실행

```bash
# 기본 backend: GitHub Copilot의 Claude Sonnet 4.6
./bin/claude-ghcp

# 다른 허용 model 선택
./bin/claude-ghcp --ghcp-model claude-haiku-4.5

# 단일 prompt
./bin/claude-ghcp \
  --ghcp-model claude-haiku-4.5 \
  -p "이 repository의 구조를 설명해줘"
```

실행 중에는 다음 경로가 사용됩니다.

```text
Claude Code
  -> 임시 loopback bridge
  -> @github/copilot-sdk
  -> copilot login 사용자의 GitHub Copilot model
```

Claude Code가 local tool을 실행하고 bridge는 model의 `tool_use`와 Claude Code의
`tool_result`를 중계합니다.

## `claude` 명령을 GHCP SDK 경로로 사용

다음 PATH 설정을 한 번 추가하면 어느 working directory에서도 `claude`가
`claude-ghcp`와 같은 경로를 사용합니다.

```bash
echo 'export PATH="$HOME/GitHub/claude-code-ghcp-sdk/bin:$PATH"' >> ~/.zshrc
exec zsh

command -v claude
# /Users/<user>/GitHub/claude-code-ghcp-sdk/bin/claude
```

```bash
claude
claude --ghcp-model claude-haiku-4.5
```

기본 Copilot model은 `GHCP_MODEL`로 바꿀 수 있습니다.

```bash
export GHCP_MODEL=claude-haiku-4.5
claude
```

원래 `claude` 명령으로 되돌리려면 `~/.zshrc`에서
`claude-code-ghcp-sdk/bin` PATH 줄을 제거하고 새 shell을 시작합니다.

## LiteLLM을 사용하는 경우

### 고객사가 이미 LiteLLM을 운영

Local LiteLLM이나 local Copilot OAuth를 설치하지 않습니다. Gateway 관리자가 제공한 URL,
scoped virtual key, model alias를 설정한 뒤 `claude-litellm`을 실행합니다.

GitHub Copilot 제공 모델을 사용하려면 gateway의 alias가
`github_copilot/claude-*` backend로 연결돼 있어야 합니다. Anthropic이나 다른 provider로
연결된 alias라면 Claude Code 사용법은 같지만 GitHub Copilot 모델 경로는 아닙니다.

```bash
export LITELLM_BASE_URL="https://litellm.example.com"
export LITELLM_API_KEY="<scoped-virtual-key>"
export LITELLM_MODEL="claude-sonnet-4-6"
claude-litellm
```

### 이 machine에 local LiteLLM 설치

```bash
npm run litellm:setup
npm run litellm:start
```

첫 실행에서 LiteLLM의 별도 GitHub device OAuth를 완료한 뒤, 다른 terminal에서 local key와
`claude-litellm`을 사용합니다. 상세 절차는
[LiteLLM 연결 가이드](docs/LITELLM.md#local-gateway-최초-구성)를 참고하세요.

## 명령 요약

| 목적 | 명령 |
|---|---|
| Direct GitHub Copilot SDK | `claude` 또는 `claude-ghcp` |
| 사용 가능한 Copilot Claude model 조회 | `ghcp-models` |
| GHCP 환경 진단 | `ghcp-doctor` |
| 기존/customer LiteLLM | `claude-litellm` |
| 기존 Claude Code provider | `claude-current` |

GHCP 및 LiteLLM launcher는 원래 Claude Code와 같은 fullscreen renderer를 유지합니다.
실제 Claude Code executable을 자동으로 찾지 못하면
`CLAUDE_CODE_BIN=/absolute/path/to/claude`를 지정할 수 있습니다.

## 기존 설정을 보존하는 방법

Claude Code의 settings precedence에서 command-line settings가 user settings보다 높습니다.
Launcher는 실행 중에만 provider override를 담은 임시 settings 파일을 전달합니다.

```text
claude --settings /tmp/.../settings.json --model <frontend-model>
```

Direct GHCP SDK launcher는 프로세스가 끝나면 local bridge와 임시 credential/settings를
삭제합니다. LiteLLM launcher도 임시 settings를 삭제합니다. 기존 user, project, local,
managed settings와 plugins, hooks, permissions는 계속 로드됩니다.

## Direct GHCP SDK architecture

```text
Claude Code
  └─ Anthropic Messages API
       └─ loopback bridge
            └─ GitHub Copilot SDK mode="empty"
                 └─ GitHub Copilot model

Copilot tool request
  → Anthropic tool_use
  → Claude Code가 native tool 실행
  → Anthropic tool_result
  → Copilot SDK handlePendingToolCall
```

자세한 내용은 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)를 참고하세요.

## Validation

```bash
npm test

# 실제 Copilot AI Credits를 사용하는 opt-in test
npm run test:e2e

# local LiteLLM gateway가 실행 중일 때
npm run test:e2e:litellm
```

E2E test는 text response와 Claude Code native `Read` tool loop를 확인하고, 전후
`~/.claude/settings.json` hash가 동일한지 검증합니다. LiteLLM local runtime이 설치된
환경에서는 `npm run litellm:start`로 gateway를 실행할 수 있습니다.

## 현재 경계

이 repository는 검증된 working prototype입니다. GitHub와 Anthropic이 공동 지원하는 GA integration은 아닙니다. Copilot SDK의 pending external-tool RPC는 experimental이며, production 전에는 true token streaming, context reconciliation, retry/idempotency, full multimodal/extended-thinking semantics와 enterprise policy 검증이 필요합니다.

자세한 내용은 [docs/LIMITATIONS.md](docs/LIMITATIONS.md)를 참고하세요.

공식 근거는 [docs/REFERENCES.md](docs/REFERENCES.md)에 정리했습니다.
