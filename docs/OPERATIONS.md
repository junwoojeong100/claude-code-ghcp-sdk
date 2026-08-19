# Operations

환경에 LiteLLM gateway가 있는지에 따라 처음부터 선택하려면
[환경별 설치 및 실행 가이드](SETUP-GUIDE.md)를 참고합니다.

## Install

```bash
cd ~/GitHub/claude-code-ghcp-sdk
npm install
copilot login

# zsh
echo 'export PATH="$HOME/GitHub/claude-code-ghcp-sdk/bin:$PATH"' >> ~/.zshrc
exec zsh
```

## Preflight

```bash
./bin/ghcp-doctor
./bin/ghcp-models
```

## Run interactively

```bash
claude --ghcp-model claude-sonnet-4.6
```

현재 working directory를 그대로 유지하므로 실제 repository에서 launcher를 호출할 수 있습니다.

```bash
cd ~/GitHub/my-project
claude --ghcp-model claude-sonnet-4.6
```

## Run non-interactively

```bash
claude \
  --ghcp-model claude-haiku-4.5 \
  -p "이 변경을 검토해줘"
```

## Keep using the existing provider

```bash
claude-current
```

## Run through local LiteLLM

최초 한 번 local runtime과 random gateway key를 준비합니다.

```bash
npm run litellm:setup
```

Gateway를 foreground로 시작하고 terminal에 표시되는 GitHub device code를 60초 안에
승인합니다.

```bash
npm run litellm:start
```

다른 terminal에서 key를 shell에 로드하고 Claude Code를 실행합니다.

```bash
export LITELLM_BASE_URL="http://127.0.0.1:4000"
export LITELLM_API_KEY="$(tr -d '\n' < .runtime/litellm-master-key)"
export LITELLM_MODEL="claude-sonnet-4-6"
claude-litellm
```

전체 text 및 `Read` tool E2E:

```bash
npm run test:e2e:litellm
```

## Run through a customer LiteLLM gateway

Local runtime 설치는 필요하지 않습니다. Gateway 관리자가 발급한 URL, scoped virtual key,
model alias를 사용합니다.

```bash
export LITELLM_BASE_URL="https://litellm.example.com"
export LITELLM_API_KEY="<scoped-virtual-key>"
export LITELLM_MODEL="<gateway-model-alias>"
claude-litellm
```

PATH를 변경하지 않은 shell에서는 `./bin/claude-ghcp`, `./bin/claude-litellm`,
`./bin/claude-current`를 직접 호출할 수 있습니다. Wrapper가 실제 Claude Code executable을
찾지 못하면 `CLAUDE_CODE_BIN=/absolute/path/to/claude`를 지정합니다.

## Terminal UI

`claude-ghcp`와 `claude-litellm`은 provider용 command-line settings를 전달하면서도 원래
Claude Code와 같은 fullscreen renderer를 유지합니다. Launcher는 사용자가
`CLAUDE_CODE_NO_FLICKER`를 별도로 지정하지 않은 경우에만 값을 `1`로 설정합니다.

## Troubleshooting

### Model unavailable

```bash
./bin/ghcp-models
```

Copilot plan과 organization model policy에 따라 목록이 다릅니다.

### Copilot authentication failure

```bash
copilot login
./bin/ghcp-doctor
```

### Bridge startup failure

Launcher는 startup failure 시 bridge log의 첫 부분을 stderr에 출력합니다. Prompt와 credential은 log에 기록하지 않습니다.

### Claude Code shows a different frontend model name

Claude Code와 Copilot model ID의 punctuation이 달라 launcher가 frontend model을 변환합니다. 실제 backend model은 bridge가 선택한 `--ghcp-model`입니다.
