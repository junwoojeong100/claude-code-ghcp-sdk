# Claude Code + GitHub Copilot SDK

Claude Code의 사용자 경험과 tool loop를 유지하면서, 모델 호출만 GitHub Copilot SDK를 통해 GitHub Copilot model catalog로 전환하는 local compatibility adapter입니다.

## 결론

- repository의 `bin`을 PATH 앞에 추가하면 `claude` 명령이 GHCP SDK 경로를 사용합니다.
- `claude-current`는 기존 Azure Databricks Claude 설정을 그대로 사용합니다.
- PATH를 바꾸지 않은 환경에서는 `./bin/claude-ghcp`로 동일하게 실행할 수 있습니다.
- `~/.claude/settings.json`과 저장된 Databricks token은 수정하거나 복사하지 않습니다.
- Claude Code가 tool을 실행하고, bridge는 Copilot model의 `tool_use`와 Claude Code의 `tool_result`를 중계합니다.

LiteLLM 중개기 존재 여부에 따라 설치 경로를 선택하려면
[환경별 설치 및 실행 가이드](docs/SETUP-GUIDE.md)를 먼저 참고하세요.

## 빠른 시작

```bash
cd ~/GitHub/claude-code-ghcp-sdk
npm install

./bin/ghcp-doctor
./bin/ghcp-models

# zsh에서 이 repository의 claude wrapper를 우선 사용
echo 'export PATH="$HOME/GitHub/claude-code-ghcp-sdk/bin:$PATH"' >> ~/.zshrc
exec zsh

# GitHub Copilot의 Claude Sonnet 4.6 경로 (기본값)
claude

# 단일 prompt
claude \
  --ghcp-model claude-haiku-4.5 \
  -p "이 repository의 구조를 설명해줘"

# 기존 Azure Databricks 경로
claude-current
```

`copilot login`이 완료되어 있어야 하며, 선택한 model은 사용자 또는 organization의 Copilot model policy에서 허용되어야 합니다.

## `claude` 명령으로 계속 사용하기

다음 PATH 설정을 `~/.zshrc`에 한 번 추가하면 새 terminal에서도 `claude`가 이
repository의 GHCP launcher를 가리킵니다.

```bash
echo 'export PATH="$HOME/GitHub/claude-code-ghcp-sdk/bin:$PATH"' >> ~/.zshrc
exec zsh
```

설정이 적용됐는지는 다음 명령으로 확인합니다.

```bash
command -v claude
# /Users/<user>/GitHub/claude-code-ghcp-sdk/bin/claude
```

이후 어느 working directory에서든 다음처럼 사용합니다.

```bash
# 기본 GHCP model: claude-sonnet-4.6
claude

# 다른 GHCP model 선택
claude --ghcp-model claude-haiku-4.5

# 기존 Claude Code provider 사용
claude-current
```

기본 GHCP model을 shell 환경에서 바꾸려면 `GHCP_MODEL`을 함께 설정할 수 있습니다.

```bash
export GHCP_MODEL=claude-haiku-4.5
claude
```

원래 `claude` 명령으로 되돌리려면 `~/.zshrc`에서
`claude-code-ghcp-sdk/bin`을 추가한 PATH 줄을 제거한 뒤 새 shell을 시작합니다.

## Provider 전환

| 목적 | 명령 |
|---|---|
| GHCP Claude model | `claude` 또는 `claude --ghcp-model claude-sonnet-4.6` |
| 운영 중인 고객 LiteLLM gateway | 환경 변수 설정 후 `claude-litellm --litellm-model <alias>` |
| 이 machine의 local LiteLLM | 최초 `npm run litellm:setup`, 이후 `npm run litellm:start` 후 `claude-litellm` |
| 현재 Azure Databricks 설정 | `claude-current` |
| 허용된 GHCP Claude model 조회 | `./bin/ghcp-models` |
| 환경 진단 | `./bin/ghcp-doctor` |

PATH를 변경하지 않으려면 기존처럼 `./bin/claude-ghcp`를 사용하면 됩니다. `claude`와
`claude-ghcp`는 `--model` 대신 `--ghcp-model`을 사용합니다. 나머지 Claude Code option과
prompt는 그대로 전달됩니다. 실제 Claude Code 실행 파일을 자동으로 찾을 수 없는 환경에서는
`CLAUDE_CODE_BIN=/absolute/path/to/claude`를 지정할 수 있습니다.

GHCP 및 LiteLLM launcher는 임시 `--settings` 사용 시 사라지는 Claude Code의 native
fullscreen renderer를 `CLAUDE_CODE_NO_FLICKER=1`로 복원합니다. 따라서 원래 `claude`
명령처럼 시작 패널과 입력 영역이 안정적으로 유지되며 provider 전환은 TUI 동작을 바꾸지
않습니다.

LiteLLM을 중앙 gateway로 사용하는 고객 환경은 [LiteLLM 연결 가이드](docs/LITELLM.md)를
참고하세요. `claude-litellm`은 외부 gateway로 직접 연결하며, 기존 `claude`의 local GHCP
SDK bridge 경로와 기존 user settings는 변경하지 않습니다.

## 기존 설정을 보존하는 방법

Claude Code의 settings precedence에서 command-line settings가 user settings보다 높습니다. Launcher는 실행 중에만 다음 값을 담은 임시 settings 파일을 전달합니다.

```text
claude --settings /tmp/.../settings.json --model <frontend-model>
```

프로세스가 끝나면 local bridge와 임시 credential/settings를 삭제합니다. 기존 user, project, local, managed settings와 plugins, hooks, permissions는 계속 로드됩니다.

## Architecture

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
