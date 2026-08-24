# Claude Code with GitHub Copilot Models

> **언어 / Language:** [English](README.md) | 한국어

Claude Code의 UI와 도구 실행은 그대로 두고, 모델 호출만 GitHub Copilot SDK 또는
LiteLLM으로 연결합니다. 기존 permissions, hooks, MCP, skills도 계속 사용합니다.

## 실행 경로 선택

| 상황 | 경로 | 실행 명령 |
|---|---|---|
| 내 GitHub Copilot 계정과 조직의 모델 정책을 그대로 사용 | **Direct SDK** | `./bin/claude-ghcp` |
| 기존 gateway, virtual key 또는 다른 provider를 사용 | **LiteLLM** | `./bin/claude-litellm` |

**대부분의 사용자는 Direct SDK를 선택하면 됩니다.** 조직에서 이미 LiteLLM gateway를
운영하거나 다른 provider가 필요할 때만 LiteLLM을 선택합니다. 두 경로를 함께 설정할
필요는 없습니다.

## 문서 안내

| 목적 | 문서 |
|---|---|
| 처음 설치하고 실행 | 이 README의 [Direct SDK 빠른 시작](#direct-sdk-빠른-시작) |
| LiteLLM client 또는 gateway 구성 | [LiteLLM 설정 가이드](docs/LITELLM_KO.md) |
| 구현, 보안 경계, 검증 범위 확인 | [아키텍처](docs/ARCHITECTURE_KO.md) |
| 구현 가능한 공백과 구조적 한계 구분 | [호환성](docs/COMPATIBILITY_KO.md) |
| 기능별 근거와 커버리지 비율 확인 | [기능 커버리지](docs/FEATURE_COVERAGE_KO.md) |

## 가능 여부와 공식 지원 경계

**Claude Code에서 GitHub Copilot 모델을 사용하는 것은 가능하지만, Copilot SDK를
Claude Code의 model provider로 직접 등록하는 방식은 아닙니다.** Claude Code는
`ANTHROPIC_BASE_URL`에 Anthropic Messages 형식으로 요청하고, Copilot SDK는 Copilot CLI
server와 JSON-RPC로 통신합니다. 따라서 두 프로토콜 사이에서 message, SSE와 tool call을
변환하는 이 저장소의 bridge가 필요합니다.

Claude Code는 호환 API 형식의 LLM gateway 연결을 문서화하지만, Anthropic은 gateway를
통한 non-Claude model routing을 지원하지 않는다고 명시합니다. GitHub Copilot SDK
자체는 현재 GA이지만, 이 저장소는 필요한 API가 포함된
`@github/copilot-sdk@1.0.10-preview.0`을 고정해 사용합니다. 따라서 이 조합은 기술적으로
동작하는 비공식 integration이며, Anthropic 또는 GitHub의 공동 지원 대상이 아닙니다.
자세한 변환 경계는 [아키텍처](docs/ARCHITECTURE_KO.md#통합-가능-근거와-경계)를 참고합니다.

## Direct SDK 빠른 시작

```text
Claude Code
  -> 이 저장소의 로컬 bridge
  -> @github/copilot-sdk
  -> GitHub Copilot 모델
```

### 준비 사항

- macOS 또는 Linux
- Claude Code의 `claude` 명령
- Node.js `^20.19.0` 또는 `>=22.12.0`
- Git
- GitHub Copilot 사용 권한
- 조직의 Copilot 모델 정책에서 허용된 모델

Windows 기본 셸은 지원하지 않습니다. Ultracode를 사용하려면 Claude Code 2.1.203
이상이 필요합니다.

### 1. 설치

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

### 3. 환경과 모델 확인

```bash
./bin/ghcp-doctor
./bin/ghcp-models
```

두 명령이 성공하고 `ghcp-models` 출력에 사용할 모델이 표시되는지 확인합니다.

### 4. Claude Code 실행

```bash
# 기본 모델: GitHub Copilot의 Claude Sonnet 5
./bin/claude-ghcp

# 다른 모델 선택
./bin/claude-ghcp --ghcp-model claude-haiku-4.5

# 비대화형 프롬프트
./bin/claude-ghcp \
  --ghcp-model claude-haiku-4.5 \
  -p "이 저장소의 구조를 설명해줘"
```

계정과 조직 정책에서 허용한다면 다음 GPT-5.6 모델도 사용할 수 있습니다.

```bash
./bin/claude-ghcp --ghcp-model gpt-5.6-sol
./bin/claude-ghcp --ghcp-model gpt-5.6-terra
./bin/claude-ghcp --ghcp-model gpt-5.6-luna
```

세 모델은 Copilot catalog 기준 1,050,000 토큰 컨텍스트로 설정됩니다.

Live test로 보증하는 범위는 `claude-opus-5`, `claude-sonnet-5`,
`claude-haiku-4.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`
6종입니다. 다른 catalog 모델은 live test matrix에 추가되기 전까지 보증하지 않습니다.

### 5. 선택: `claude` 명령을 PATH에 추가

어느 디렉터리에서나 실행하려면 저장소 루트에서 `bin`을 PATH에 추가합니다. Zsh 예시:

```bash
echo "export PATH=\"$PWD/bin:\$PATH\"" >> ~/.zshrc
exec zsh
```

다른 셸에서는 같은 값을 해당 셸의 설정 파일에 추가합니다.

설정을 확인합니다.

```bash
command -v claude
# <clone-path>/claude-code-ghcp-sdk/bin/claude
```

이후 `claude`는 이 저장소의 Direct SDK 실행 스크립트를 사용합니다.

```bash
claude
claude --ghcp-model claude-haiku-4.5
```

기본 모델 변경:

```bash
export GHCP_MODEL=claude-haiku-4.5
claude
```

기존 Claude Code provider로 실행:

```bash
claude-current
```

### 모델과 reasoning effort

현재 계정에서 사용할 수 있는 모델과 지원 기능을 확인한 뒤 reasoning effort를
지정할 수 있습니다.

```bash
./bin/ghcp-models --json

./bin/claude-ghcp --ghcp-model gpt-5.6-sol --effort high
./bin/claude-ghcp --ghcp-model gpt-5.6-sol --effort ultracode
```

`/effort`와 `--effort`는 Copilot SDK로 전달됩니다. 선택한 모델이 해당 값을 지원하지
않으면 가장 가까운 하위 레벨로 조정합니다. Reasoning effort를 지원하지 않는 모델에는
값을 전달하지 않습니다. GPT-5.6 Sol, Terra, Luna는 현재 `none`, `low`, `medium`,
`high`, `xhigh`, `max`를 지원합니다.

Ultracode는 `xhigh` 지원 모델에서만 사용할 수 있으며 일반 호출보다 AI Credit을 더
사용할 수 있습니다. `/model` picker와 effort 변환 방식은
[아키텍처 문서](docs/ARCHITECTURE_KO.md#모델-discovery와-context)를 참고합니다.

일반 세션에서는 subagent와 dynamic workflow를 사용할 수 있습니다. `--background`와
`agents` view는 persistent loopback bridge를 자동 사용합니다. 상태 확인과 종료는
`claude-ghcp-status`, `claude-ghcp-stop`을 사용합니다.

## LiteLLM 빠른 시작

LiteLLM은 로컬 Node.js bridge와 `@github/copilot-sdk`를 사용하지 않는 별도
경로입니다.

```text
Claude Code
  -> LiteLLM /v1/messages
  -> LiteLLM에 구성된 provider
```

기존 LiteLLM gateway에 연결할 때는 저장소만 복제합니다. `npm install`과
`copilot login`은 필요하지 않습니다.

```bash
git clone https://github.com/junwoojeong100/claude-code-ghcp-sdk.git
cd claude-code-ghcp-sdk
```

관리자가 제공한 base URL, scoped virtual key, model alias를 설정합니다.

```bash
export LITELLM_BASE_URL="https://litellm.example.com"
export LITELLM_API_KEY="<scoped-virtual-key>"
export LITELLM_MODEL="claude-sonnet-5"

./bin/claude-litellm
```

GitHub Copilot 모델을 사용하려면 model alias가 `github_copilot/claude-*` backend에
연결돼 있어야 합니다. 다른 provider에 연결된 alias는 GitHub Copilot을 사용하지
않습니다.

로컬 gateway 설치, GitHub device OAuth, model mapping, multi-user 인증과 문제 해결은
[LiteLLM 가이드](docs/LITELLM_KO.md)를 따릅니다.

## 명령 요약

| 목적 | 명령 |
|---|---|
| GitHub Copilot SDK 직접 사용 | `./bin/claude` 또는 `./bin/claude-ghcp` |
| 허용된 Copilot 모델 조회 | `./bin/ghcp-models` |
| GHCP 환경 진단 | `./bin/ghcp-doctor` |
| Persistent bridge 상태 확인 | `./bin/claude-ghcp-status` |
| Persistent bridge 종료 | `./bin/claude-ghcp-stop` |
| LiteLLM gateway 사용 | `./bin/claude-litellm` |
| 기존 Claude Code provider 사용 | `./bin/claude-current` |

`claude-ghcp`에서는 `--model` 대신 `--ghcp-model`을 사용합니다. 나머지 Claude Code
옵션과 프롬프트는 그대로 전달됩니다. `bin`을 PATH에 추가했다면 `./bin/`을 생략할 수
있습니다.

### 설정 입력

실행 옵션이 환경 변수보다 우선합니다. 이 저장소는 `.env` 파일을 자동으로 읽지
않으므로 값을 현재 셸에서 `export`하거나 명령 앞에 지정합니다. `.env.example`은 사용
가능한 환경 변수의 참고 목록입니다.

| 경로 | 필수 설정 | 선택 설정 |
|---|---|---|
| Direct SDK | 없음 | `--ghcp-model` / `GHCP_MODEL`, `--bridge-port` / `GHCP_BRIDGE_PORT` |
| LiteLLM | `LITELLM_BASE_URL`, `LITELLM_API_KEY` | `--litellm-model` / `LITELLM_MODEL` |

## 설정과 지원 범위

### 설정 보존

실행 스크립트는 `~/.claude/settings.json`을 수정하지 않습니다. 권한이 `0600`인 임시
settings 파일에는 gateway routing에 필요한 값만 기록합니다. 기존 theme, permissions,
hooks, plugins, skills, MCP, project settings는 계속 불러옵니다.

종료할 때 Direct 경로는 로컬 bridge와 임시 credential/settings를 삭제하고, LiteLLM
경로는 임시 settings를 삭제합니다.

Managed settings는 실행 스크립트의 임시 settings보다 우선합니다. 조직 정책이 provider
selector, `availableModels`, MCP tool search를 강제하면 실행 스크립트는 이를 우회하지
않습니다.

### 지원 범위

다음 표는 Direct SDK 경로의 현재 상태입니다.

| 기능 | 상태 |
|---|---|
| Terminal UI, permissions, user/project settings | Claude Code가 담당 |
| Text, native `Read` tool | 실제 모델 E2E 확인 |
| SSE, Anthropic Messages 변환 | 단위 테스트 확인 |
| Reasoning effort, Ultracode `xhigh` routing | 단위 테스트와 로컬 프로토콜 확인 |
| `Edit`, `Write`, `NotebookEdit`, `Bash`, hooks, plugins, skills, local MCP | Feature E2E 확인 |
| Image/document 변환 | Image와 유효 PDF live E2E 확인 |
| Root/subagent 세션 분리 | Unit test와 6모델 Agent→`Read` E2E 확인 |
| SDK resume | Resume/fork와 history 축소 reconciliation 구현; in-flight crash recovery는 best-effort |
| Token counting | Call 이후 실제 SDK usage; `/count_tokens` preflight는 명시적 추정 |
| Sampling과 생성 제어 | 미지원 native control은 진단으로 노출; `tool_choice`는 bounded filtering/prompt emulation |
| MCP tool search | Native search 미지원; 35개 MCP tool의 안전한 full-schema fallback 검증 |
| `--json-schema` structured output | Claude Code validator/retry를 bridge 경유 live E2E로 확인 |
| Remote Control | Custom `ANTHROPIC_BASE_URL`에서 Claude Code가 비활성화 |
| `--background`/agent view | Private persistent bridge daemon으로 지원 |
| Claude web/cloud, `--cloud`, `--teleport`, cloud ultrareview | 로컬 실행 경로 밖이므로 GHCP bridge를 사용하지 않음 |
| Reasoning text/signature, citations, prompt-cache metadata | 완전한 round-trip은 미지원 |

VS Code나 JetBrains의 통합 터미널에서 실행 스크립트를 직접 실행하면 같은 경로를
사용합니다. IDE extension, Claude Desktop, cloud session이 시작한 Claude Code 프로세스에는
자동으로 적용되지 않습니다.

## 검증

```bash
# 단위 테스트
npm test

# Direct SDK E2E: text + Read tool
npm run test:e2e

# GPT-5.6 Sol, Terra, Luna E2E
npm run test:e2e:gpt-5.6

# 실행 중인 로컬 LiteLLM E2E
npm run test:e2e:litellm
```

E2E는 실제 GitHub Copilot AI Credits를 사용합니다. 실행 전후
`~/.claude/settings.json`의 존재 여부나 content hash가 달라지면 실패합니다.

각 명령이 확인하는 정확한 범위는
[아키텍처 문서의 검증 범위](docs/ARCHITECTURE_KO.md#검증-범위)를 참고합니다.

## 지원 상태

이 프로젝트는 검증된 working prototype이며 GitHub와 Anthropic이 공동 지원하는 공식
integration이 아닙니다. Copilot SDK upstream은 GA이지만 이 프로젝트가 pin한 package는
preview release입니다.

구현 범위, 보안, production 제약은 [아키텍처 문서](docs/ARCHITECTURE_KO.md)를 참고합니다.

| 사용 목적 | 권장 수준 |
|---|---|
| 개인 실험·연구 | 적합 |
| Claude Code UI에서 Copilot 모델 사용 | 핵심 경로 사용 가능 |
| 일반 코딩 작업 | 필요한 tool 조합을 E2E 확인한 뒤 사용 |
| 업무 핵심·장시간 자동화 | 복구, 세션 정리와 기능별 검증을 보강한 뒤 사용 |
| 공식 지원 또는 SLA가 필요한 환경 | 부적합 |
