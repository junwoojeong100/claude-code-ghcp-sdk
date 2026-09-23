# Claude Code with GitHub Copilot Models

> **언어 / Language:** [English](README.md) | 한국어

Claude Code의 UI와 도구 실행은 그대로 두고, 모델 호출만 GitHub Copilot SDK로
연결합니다. 같은 bridge 앞에 LiteLLM proxy를 두는 경로도 지원합니다. 기존
permissions, hooks, MCP, skills도 계속 사용합니다.

## 실행 경로 선택

| 상황 | 경로 | 실행 명령 |
|---|---|---|
| 내 GitHub Copilot 계정과 조직의 모델 정책을 그대로 사용 | **Direct SDK** | `./bin/claude-ghcp` |
| 기존 gateway, virtual key, budget, request logging을 bridge 앞에 배치 | **LiteLLM** | `./bin/claude-litellm` |

**대부분의 사용자는 Direct SDK를 선택하면 됩니다.** 조직에서 이미 LiteLLM gateway를
운영하거나 virtual key, budget, request logging이 필요할 때만 LiteLLM을
선택합니다. LiteLLM은 같은 bridge 앞에 놓이며 기능이 아니라 hop 하나를
더합니다. 두 경로를 함께 설정할 필요는 없습니다.

## 문서 안내

| 목적 | 문서 |
|---|---|
| 처음 설치하고 실행 | 이 README의 [Direct SDK 빠른 시작](#direct-sdk-빠른-시작) |
| bridge 앞에 LiteLLM proxy 배치 | [LiteLLM 설정 가이드](docs/LITELLM_KO.md) |
| 구현, 보안 경계, 검증 범위 확인 | [아키텍처](docs/ARCHITECTURE_KO.md) |
| 구현 가능한 공백과 구조적 한계 구분 | [호환성](docs/COMPATIBILITY_KO.md) |
| 기능별 근거와 커버리지 비율 확인 | [검증 결과](docs/VERIFICATION_KO.md) |

## 가능 여부와 공식 지원 경계

**Claude Code에서 GitHub Copilot 모델을 사용하는 것은 가능하지만, Copilot SDK를
Claude Code의 model provider로 직접 등록하는 방식은 아닙니다.** Claude Code는
`ANTHROPIC_BASE_URL`에 Anthropic Messages 형식으로 요청하고, Copilot SDK는 Copilot CLI
server와 JSON-RPC로 통신합니다. 따라서 두 프로토콜 사이에서 message, SSE와 tool call을
변환하는 이 저장소의 bridge가 필요합니다.

Claude Code는 호환 API 형식의 LLM gateway 연결을 문서화하지만, Anthropic은 gateway를
통한 non-Claude model routing을 지원하지 않는다고 명시합니다. 이 저장소는 정식
`@github/copilot-sdk@1.0.14`를 고정해 사용합니다. 이 조합은 여전히 기술적으로
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
- 로그인과 launcher 확인에 사용할 GitHub Copilot CLI의 `copilot` 명령
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

Copilot CLI가 아직 설치되지 않았다면 먼저 설치합니다.

```bash
npm install -g @github/copilot
```

```bash
copilot login
```

별도의 Anthropic API key는 필요하지 않습니다.

SDK 1.0.14는 플랫폼별 Copilot runtime(1.0.85)을 포함하며, 더 이상
`@github/copilot` CLI package를 의존성으로 설치하지 않습니다. PATH에 `copilot`이
없다면 CLI를 별도로 설치해야 합니다. Bridge는 SDK 내장 runtime을 기본 사용하고,
`COPILOT_CLI_PATH`로 기존 CLI 설치본을 명시적으로 선택할 수 있습니다. Runtime을
바꾸면 호환성 검증도 다시 수행해야 합니다.

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

계정과 조직 정책에서 허용한다면 다음 GPT-6 모델도 사용할 수 있습니다.

```bash
./bin/claude-ghcp --ghcp-model gpt-6-astra
./bin/claude-ghcp --ghcp-model gpt-6-sol
./bin/claude-ghcp --ghcp-model gpt-6-luna
```

Copilot catalog의 한도는 GPT-6 Astra 1,050,000 토큰, GPT-6 Sol과 Luna
1,000,000 토큰(그중 prompt 872,000 토큰)입니다. 런처는 이 세 모델과 Claude Opus
5.5, Claude Sonnet 5에 프로세스 전체 한도 재정의 대신 Claude Code의 **모델별 1M
컨텍스트 힌트**를 사용합니다. Gateway 뒤에서 Claude Code는 힌트가 없는
`claude-opus-5-5`나 `claude-sonnet-5`를 200K로 잡습니다. 모델을
바꿔도 시작할 때의 한도가 다른 모델에 남지 않으며, native의 더 작은 한도와 자동
압축은 유지됩니다.

Direct SDK의 `/model` 피커는 **아래 주요 6개 모델**로 고정되며, Claude Code가 항상
유지하는 `Default` 행만 함께 표시됩니다. 임시 `modelPicker` 설정으로 기본·discovery
목록을 대체하므로 구형 모델이나 새로 발견된 catalog 항목이 추가 선택지로 다시
나타나지 않습니다. 이는 피커 정리이지 권한 allowlist가 아닙니다. `ghcp-models`의
전체 catalog 조회와 명시적인 `--ghcp-model` 라우팅은 유지하며, 모델 사용 권한은
계정 정책이 결정합니다. 새 피커를 적용하려면 실행 중인 세션을 다시 시작합니다.

| 피커 행 | Copilot 모델 | Claude Code window |
|---|---|---|
| GitHub Copilot · Claude Opus 5.5 | `claude-opus-5.5` | 1M (모델별 힌트) |
| GitHub Copilot · Claude Sonnet 5 | `claude-sonnet-5` | 1M (모델별 힌트) |
| GitHub Copilot · Claude Haiku 4.5 | `claude-haiku-4.5` | 200K (native gateway window) |
| GitHub Copilot · GPT-6 Astra | `gpt-6-astra` | 1M (모델별 힌트) |
| GitHub Copilot · GPT-6 Sol | `gpt-6-sol` | 1M (모델별 힌트) |
| GitHub Copilot · GPT-6 Luna | `gpt-6-luna` | 1M (모델별 힌트) |

Claude Code 2.1.280에서 `Default` 행은 Opus 5.5 행과 같은 ID인
`claude-opus-5-5[1m]`로 해석되므로, 두 행은 같은 1M 예산과 같은 long-context
backend를 씁니다. [긴 대화와 기존 세션](#긴-대화와-기존-세션)을 참고합니다.

현재 전체 기능 검증 대상은 정확히 `claude-opus-5.5`, `claude-sonnet-5`,
`claude-haiku-4.5`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`의 6종입니다. 새
실행의 증거로만 호환성을 판단합니다. 6종 모두 동일한 11개 시나리오를 받으며,
축소된 smoke test 등급을 두는 모델은 없습니다.
[검증 결과](docs/VERIFICATION_KO.md)를 참고합니다. 이전 주요 모델(`claude-opus-5`,
`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`), `gpt-5.5`와 다른 catalog 모델은 이
검증에 포함하지 않으며, 정책이 허용하면 `--ghcp-model`로 계속 사용할 수 있습니다.
Catalog에 표시된다는 것만으로 모든 모델의 tool, image, reasoning 등 기능 호환성을
보증하지 않습니다.

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

./bin/claude-ghcp --ghcp-model gpt-6-sol --effort high
./bin/claude-ghcp --ghcp-model gpt-6-sol --effort ultracode
```

`/effort`와 `--effort`는 Copilot SDK로 전달됩니다. 선택한 모델이 해당 값을 지원하지
않으면 가장 가까운 하위 레벨로 조정합니다. Reasoning effort를 지원하지 않는 모델에는
값을 전달하지 않습니다. 현재 catalog 기준 GPT-6 Sol과 Luna는 `none`, `low`,
`medium`, `high`, `xhigh`, `max`를, GPT-6 Astra·Claude Opus 5.5·Claude Sonnet 5는
`low`부터 `max`까지를 지원하며, Claude Haiku 4.5는 reasoning effort를 받지 않습니다.

Ultracode는 `xhigh` 지원 모델에서만 사용할 수 있으며 일반 호출보다 AI Credit을 더
사용할 수 있습니다. `/model` picker와 effort 변환 방식은
[아키텍처 문서](docs/ARCHITECTURE_KO.md#모델-discovery와-context)를 참고합니다.

일반 세션에서는 subagent와 dynamic workflow를 사용할 수 있습니다. `--background`와
`agents` view는 persistent loopback bridge를 자동 사용합니다. 상태 확인과 종료는
`claude-ghcp-status`, `claude-ghcp-stop`을 사용합니다.

### 긴 대화와 기존 세션

캐시 입력 토큰은 한 번만 집계합니다. Copilot의 입력 총합을 Anthropic의 uncached,
cache-read, cache-creation 필드로 나누며, 같은 토큰을 중복으로 더해 context meter가
부풀거나 불필요한 압축을 유발하지 않도록 합니다. 자동 압축은 계속 Claude Code가
담당합니다.

SDK session 생성·재개·effort 변경에는 `SESSION_OPERATION_TIMEOUT_MS`라는 별도의
대기 제한(기본 **60,000ms**)을 적용합니다. 준비 중이거나 큐에서 기다리는 요청도
취소할 수 있고, 늦게 도착한 준비 응답이 폐기된 세션을 복구하지 못하게 합니다.
모델 턴에는 실제 root의 텍스트·추론·도구 입력 진행으로 갱신되는 **5분 idle 제한**과,
갱신되지 않는 **30분 전체 상한**을 따로 적용합니다
(`TURN_IDLE_TIMEOUT_MS`, `TURN_MAX_DURATION_MS`). 답변이 계속 생성되는 중인데도
5분 경과만으로 끊지 않습니다. 준비 단계 무한 대기는 내용을 포함하지 않는
`bridge.session_operation_failed` 진단으로 실패를 알립니다.

주요 GPT-6 모델, Claude Opus 5.5, Claude Sonnet 5(와 명시적으로 선택한 GPT-5.6
모델)는 SDK의 long-context tier를 명시하고 조회한 catalog의 숫자 한도를 함께
전달합니다. SDK 기본 tier는 표시된 모델 window보다 훨씬 작을 수 있습니다. 앞선
야간 실측에서 Astra의 입력 한도는 기본 272K였지만 long tier와 catalog
capabilities를 적용하자 1.05M이었고, 기본 tier는 Opus 5.5와 Sonnet 5를 200,000으로
제한합니다. 실제 한도는 `bridge.context_budget`으로 기록하며, Astra 1,050,000,
Sonnet 5 936,000, Opus 5.5·Sol·Luna 872,000입니다. Astra를 제외한 모델은 Claude
Code가 잡는 1M 예산보다 적은 prompt 토큰을 받으므로, 대화가 그 한도를 넘으면
Claude Code의 약 967K 자동 압축 기준보다 먼저 아래 overflow 경로를 탑니다. Haiku
4.5는 SDK 기본 tier(136,000)를 유지하며 Claude Code의 native gateway window 200K
안에 있습니다. 이 한도는 Claude Code의 167K 자동 압축 기준보다 낮아 같은 overflow
경로를 탈 수 있습니다.

SDK의 자체 압축·잘라내기로 문맥이 조용히 유실되지 않도록 해당 상태를 무효화하고,
Claude Code가 원본 transcript를 압축할 수 있는 context-limit 오류를 반환합니다.
모델 스트리밍 전에 발견된 오류는 HTTP 200 스트림으로 바꾸지 않고 HTTP 400으로
유지해야 native overflow 복구가 작동합니다.

이미 실행 중인 foreground bridge는 로드한 이전 코드를 계속 사용합니다. 기존
Claude Code를 종료한 뒤 같은 프로젝트 디렉터리에서 이전 모델로 재개합니다.
예를 들어 Astra 대화는 다음과 같습니다.

```bash
./bin/claude-ghcp --ghcp-model gpt-6-astra --continue
```

다른 저장된 대화를 선택하려면 `--resume`을 사용합니다. Claude Code transcript를
지우거나 전역 사용자 설정을 바꾸지 않습니다. Persistent bridge는 다음 실행에서
구현·설정 지문을 비교해 오래된 daemon을 교체합니다. window를 억지로 늘리려고
자동 압축을 끄지 마세요.

## LiteLLM 빠른 시작

LiteLLM은 이 저장소의 bridge 앞에 놓이는 proxy입니다. bridge나
`@github/copilot-sdk`를 대체하지 않고, 그 앞에 virtual key, budget,
request logging을 더합니다.

```text
Claude Code
  -> LiteLLM /v1/messages
  -> 이 저장소의 로컬 bridge
  -> @github/copilot-sdk
  -> GitHub Copilot 모델
```

LiteLLM은 `anthropic/*` provider로 bridge에 연결하며 `api_base`는 bridge
root를 가리킵니다. LiteLLM 자체 `github_copilot/*` provider는 사용하지
않으며, LiteLLM 쪽의 별도 GitHub device OAuth도 없습니다.

gateway를 운영하는 사람은 bridge도 함께 운영하므로 `npm install`,
`copilot login` 세션, 실행 중인 bridge daemon이 필요합니다. 다른 사람이
운영하는 gateway에 연결하기만 할 때는 저장소만 복제합니다. `npm install`과
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

`LITELLM_MODEL`은 gateway 구성의 `model_name` alias입니다. GitHub Copilot
모델을 제공하려면 그 alias가 `model: anthropic/<copilot-model-id>`로
해석되고 `api_base`가 이 저장소의 bridge root를 가리켜야 합니다. 다른 곳을
가리키는 alias는 GitHub Copilot을 사용하지 않습니다.

bridge는 `ALLOW_NON_LOOPBACK=1`을 설정하지 않는 한 loopback에만 bind하므로
LiteLLM은 bridge와 같은 호스트에서 실행해야 합니다. 그 호스트에서
`claude-ghcp`도 실행한다면 두 셸에서 같은 `GHCP_BRIDGE_PORT`를 export합니다.
요청 포트는 daemon configuration fingerprint의 일부이므로, 이를 설정하지 않고
실행한 launcher는 고정 포트의 daemon을 종료하고 새 포트와 새 token으로 daemon을
다시 시작하며, LiteLLM은 connection refused를 받습니다.

LiteLLM은 이 저장소의 검증 범위 밖입니다. `npm run verify` matrix(6 모델 x
11 시나리오 = 66 슬롯)는 `src/server.mjs`를 직접 실행하며 LiteLLM을 기동하지
않습니다. LiteLLM 경로는 검증된 경로가 아니라 구성 참고 자료입니다.

bridge daemon과 고정 포트·token, 예제 구성, model mapping, multi-user 인증과
문제 해결은 [LiteLLM 가이드](docs/LITELLM_KO.md)를 따릅니다.

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

Direct SDK bridge의 HTTP 요청 본문(`MAX_BODY_BYTES`)과 대화 이력 재생
(`MAX_REPLAY_BYTES`) 한도는 모두 기본 **256 MiB(268,435,456바이트)**입니다.
각 환경 변수를 `export`해 한도를 바꿀 수 있습니다. 한도를 높이면 메모리 사용량이
늘 수 있지만 모델의 컨텍스트 한도는 늘어나지 않습니다. 변경은 다음 bridge 시작부터
적용되며, 이미 실행 중인 bridge에는 적용되지 않습니다.

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

Bridge 뒤의 Copilot runtime은 기본적으로 SDK session마다 Copilot CLI 자체 MCP server —
`~/.copilot/mcp-config.json`, 설치된 Copilot plugin, workspace 파일, 내장
`github-mcp-server` — 를 띄우지만, 모델에 전달되는 것은 Claude Code의 도구뿐입니다.
그래서 bridge는 시작 시 이 server들의 등록 이름을 확인하고, discovery가 보고하지 않는
내장 server를 더해 session마다 `disabledMcpServers`로 비활성화하며, 해당 설정은 바꾸지
않습니다. Claude Code 자체 MCP server는 영향을 받지 않습니다.
[Copilot runtime MCP server](docs/ARCHITECTURE_KO.md#copilot-runtime-mcp-server)를
참고합니다.

### 지원 범위

다음 표는 Direct SDK 경로의 현재 상태입니다.

| 기능 | 상태 |
|---|---|
| Terminal UI, permissions, user/project settings | Claude Code가 담당 |
| Text, native `Read` tool | 구현됨; 새 실행 증거 필요 |
| SSE, Anthropic Messages 변환 | 구현됨; 회귀 테스트 제공 |
| Reasoning effort, Ultracode `xhigh` routing | Model capability에 맞춰 전달 |
| `Edit`, `Write`, `NotebookEdit`, `Bash`, hooks, plugins, skills, local MCP | Native feature E2E runner 제공 |
| Image/document 변환 | Initial attachment 구현; provider 제약 적용 |
| Root/subagent 세션 분리 | Claude session/agent ID 기반으로 구현 |
| SDK resume | Resume/fork와 history 축소 reconciliation 구현; in-flight crash recovery는 best-effort |
| Token counting | Call 이후 실제 SDK usage; `/count_tokens` preflight는 명시적 추정 |
| Sampling과 생성 제어 | 미지원 native control은 진단으로 노출; `tool_choice`는 bounded filtering/prompt emulation |
| MCP tool search | Full-schema 기본값; native ToolSearch는 명시적 opt-in |
| `--json-schema` structured output | Claude Code native validator/retry 사용 |
| Remote Control | Custom `ANTHROPIC_BASE_URL`에서 Claude Code가 비활성화 |
| `--background`/agent view | Private persistent bridge daemon으로 지원 |
| Claude web/cloud, `--cloud`, `--teleport`, cloud ultrareview | 로컬 실행 경로 밖이므로 GHCP bridge를 사용하지 않음 |
| Reasoning text/signature, citations, prompt-cache metadata | 완전한 round-trip은 미지원 |

VS Code나 JetBrains의 통합 터미널에서 실행 스크립트를 직접 실행하면 같은 경로를
사용합니다. IDE extension, Claude Desktop, cloud session이 시작한 Claude Code 프로세스에는
자동으로 적용되지 않습니다.

## 검증

### 2026-09-23 6개 모델 재검증 (KST)

**엄격한 판정: PASS — 단일 전체 실행에서 66/66(100%) 통과.** 주요 매트릭스는 이제
Claude Opus 5.5, Claude Sonnet 5, Claude Haiku 4.5, GPT-6 Astra, GPT-6 Sol,
GPT-6 Luna이며, 모두 같은 11개 시나리오를 받습니다. 랩탑에 설치된 실제 Claude Code
**2.1.280**으로 모든 슬롯을 bridge와 Copilot SDK를 거쳐 실행했습니다. 사용하지 않는
MCP server를 Copilot runtime이 띄우지 않게 한 commit에서 수행한 최종 실행은
**740초(12분 20초)**가 걸렸으며 실패·blocked·누락·중복·예상 밖 슬롯이 없고 코드와
사용자 설정도 보존되었습니다. 이는 선택한 매트릭스의 통과율이며, 모든 기능의 완전한
커버리지나 이후 실행의 성공을 보장하는 수치가 아닙니다.

- **고정된 피커:** Claude Code의 native `supportedModels()` control 요청은 `Default`와
  위 6개 행만 순서대로 반환했습니다. 각 행으로의 `setModel()`은 bridge에 요청을
  보내지 않았고(bridge 로그에는 시작 관련 기록만 있음), `getContextUsage()`는 Claude 세
  행에서 200K, GPT-6 세 행에서 1M, Haiku로 되돌아오면 다시 200K를 보고했습니다.
  `Default`는 `claude-opus-5-5[1m]`(1M)으로 해석되었습니다. 기록:
  `.verify-runs/picker-six-2026-09-23T00-51-18Z/`.
- **Runtime MCP server:** 최종 실행에서 보존된 bridge 로그 72개(슬롯별 bridge 66개와
  v11 daemon 6개)가 모두 server 5개에 대한 `bridge.mcp_servers_disabled`를 기록합니다.
  v11의 foreground 실행 6회는 임시 bridge를 쓰며, 런처가 종료 시 그 로그를 지웁니다.
  `ps` sampler는 최대 9개 runtime이 동시에 도는 12분 동안 354회 표본을 수집했으며, 그
  아래에서 MCP server 프로세스를 한 번도 보지 못했습니다. 자식 프로세스는 잠깐 뜬 `git`
  호출과 종료 중인 프로세스(`<defunct>`, `(copilot-runtime)`)뿐이었습니다. 변경
  전에는 열린 session 하나가 azmcp와 Playwright MCP node server 2개(~330 MB)를 띄웠고,
  두 session을 동시에 처리하는 bridge에는 이런 자식 프로세스가 6개 있었습니다. 두 cold
  첫 요청의 동시 처리 시간 중앙값은 8.08초에서 3.95초로 줄었습니다. 기록:
  `.verify-runs/runtime-sampler-2026-09-23T00-38-10Z/`,
  `.verify-runs/mcp-check-2026-09-23T00-32-13Z/`.
- **SDK 예산**(`bridge.context_budget`): 기본 tier에서 Opus 5.5·Sonnet 5 200,000,
  Haiku 4.5 136,000; long-context tier에서 Astra 1,050,000, Sol·Luna 872,000.
- **오프라인:** `npm test` **390/390 통과**, 실패·취소·건너뜀 없음.
- **원시 산출물 별도 대조:** 기록된 검사 **1,146개** 중 실패 0개, headless 단계
  transcript **90개**에 담긴 result envelope 95개가 모두 양수 입력 usage와 예상한
  응답 모델을 기록했습니다. 응답 없는 `tool_use`가 없고, 6개 런처 슬롯의
  명령·daemon 근거도 모두 남아 있습니다.
- **최종 실행 이전:** 첫 6개 모델 전체 실행은 64/66으로 NOT GREEN이었습니다.
  Claude Opus 5.5가 v02와 v08을 올바르게 처리했지만 Edit·Write 대신 셸
  명령(`sed -i`, redirect)을 사용해, Edit 정확 일치 검사와 Write|Edit PreToolUse
  관찰 hook이 확인할 대상이 없었습니다. 별도로 검증 하네스 밖의 대화형 Claude Code
  세션이 실행 도중 `/model` 선택을 `~/.claude/settings.json`에 저장했고, 설정 보존
  판정이 이를 정확히 거부했습니다. 이제 v02와 v08 프롬프트는 v08 cron 턴이 이미
  CronCreate를 명시하듯 Edit과 Write를 명시합니다. 검사와 통과 기준은 바꾸지
  않았습니다. Opus 5.5의 두 시나리오만 다시 실행한 부분 실행은 2/2, 다음 전체 실행은
  624초에 66/66 통과했습니다. 이후 runtime MCP 변경은 해당 commit에서 새 전체 실행이
  필요했고, 다른 저장소의 Copilot runtime 안정성 작업이 같은 랩탑에 부하를 주는
  동안(load average ≈ 8.5) 실행되어 더 오래 걸렸습니다.

전체 실행 이력은 각 실행 당시의 구현과 모델 catalog를 기준으로 구분해 보존합니다.

| 전체 실행 | 실행 ID (UTC) | 매트릭스 | pass / fail / blocked / unknown | 모델 × 시나리오 작업자 | 소요 | 사용자 설정 |
|---|---|---|---|---|---|---|
| 6개 모델 첫 실행 — NOT GREEN | `2026-09-22T23-29-13-171Z` | 6 × 11 | 64 / 2 / 0 / 0 | 3 × 2 | 778초 | 하네스 밖 대화형 세션이 변경 |
| 6개 모델, runtime MCP 변경 전 — PASS | `2026-09-22T23-45-15-077Z` | 6 × 11 | 66 / 0 / 0 / 0 | 3 × 2 | 624초 | 보존 |
| 6개 모델 최종, runtime MCP server 비활성화 — PASS | `2026-09-23T00-38-10-470Z` | 6 × 11 | **66 / 0 / 0 / 0** | **3 × 2** | **740초** | **보존** |
| 7개 모델: 이전 마무리 1차 — NOT GREEN | `2026-09-21T22-54-08-294Z` | 7 × 11 | 76 / 1 / 0 / 0 | 7 × 2 | 456초 | 변경됨; 변경 주체·원인 미확인 |
| 7개 모델: 이전 마무리 2차 — NOT GREEN | `2026-09-21T23-07-19-056Z` | 7 × 11 | 74 / 2 / 1 / 0 | 7 × 2 | 863초 | 보존 |
| 7개 모델: 새 기준 실행 — NOT GREEN | `2026-09-22T00-01-29-757Z` | 7 × 11 | 76 / 1 / 0 / 0 | 7 × 2 | 943초 | 보존 |
| 7개 모델: 1차 개선 — NOT GREEN | `2026-09-22T00-30-59-086Z` | 7 × 11 | 75 / 2 / 0 / 0 | 7 × 2 | 973초 | 보존 |
| 7개 모델: 피커·롱턴 후속 변경 전 — PASS | `2026-09-22T00-52-51-013Z` | 7 × 11 | 77 / 0 / 0 / 0 | 3 × 2 | 782초 | 보존 |
| 7개 모델: 피커·롱턴 수정본 — PASS | `2026-09-22T03-37-17-139Z` | 7 × 11 | 77 / 0 / 0 / 0 | 3 × 2 | 794초 | 보존 |
| 7개 모델: 컨텍스트·스트리밍 복구 — PASS | `2026-09-22T12-29-58-559Z` | 7 × 11 | 77 / 0 / 0 / 0 | 3 × 2 | 812초 | 보존 |

최종 실행은 commit
`1df3aa4982ce2eb688a7d48f64aeab61e1499e22`(clean 작업 트리)에서 시작·종료했고,
41개 파일의 `verification-code-v1` SHA-256 지문도 일치합니다.
`5dad75f80408a699feac9f2221d6edcea848a7d9265e0a9e25cd170277c9cd7b`.
생성된 영문·한글 검증 문서는 모두 **이 최종 전체 실행만** 사용합니다.
git 무시 대상 `.verify-runs/2026-09-23T00-38-10-470Z/`에 `summary.json`,
`slots.jsonl`, `console.log`, `audit.json`, 단계별 transcript와 런처 로그를
보존했습니다. 앞선 6개 모델 실행들과 부분 재실행(`2026-09-22T23-44-23-074Z`)은 별도
기록으로 남기며, 그 셀을 최종 66/66에 보태지 않았습니다.

### 이전 7개 모델 기록 (2026-09-22)

이전 주요 모델은 Claude Opus 5, Claude Sonnet 5, Claude Haiku 4.5, GPT-5.6 Sol,
GPT-5.6 Terra, GPT-5.6 Luna, GPT-6 Astra였습니다. 마지막 전체 실행
`2026-09-22T12-29-58-559Z`는 Claude Code 2.1.278로 commit `d84bd22`에서 77/77
통과했습니다. 같은 작업에서 다음 별도 probe도 수행했으며, 어떤 매트릭스에도 셀을
보태지 않습니다.

- 실제 Astra 대화가 검증 전용 100K compact window(실제 trigger 67K)로 **10개 턴과
  자동 압축 4회**를 완료한 뒤 첫 턴에 심은 표식을 회상했습니다:
  `.verify-runs/long-conversation-2026-09-22T02-30-14-506Z/`.
- 복구 검증: **Astra 24/24턴**, native 압축 1회와 최대 **809,115 입력 토큰**에서
  첫 표식 회상; **Haiku 9/9턴**, native 압축 2회.
- 7개 모델의 세션 재개/fork와 long-context 부분 실행 **14/14** 통과:
  `.verify-runs/picker-longturn-regression/2026-09-22T02-40-55-670Z/`.

그 실패들은 소급해 바꾸지 않고 이력으로 남깁니다. 이전 마무리의 Sonnet fork 불일치,
Opus result usage 0, Haiku timeout; bridge에 첫 모델 요청이 도달하기 전 Luna와
Haiku 네이티브 백그라운드 워커의 기동 정지; 이전 메시지를 그대로 추출하도록 묻는
표현에 대한 Opus 거부(이후 배포 사실을 묻는 질문으로 명확히 함)입니다. 당시 실행은
판정을 완화하는 대신 하네스를 강화했습니다.

- 재개/fork 질문은 예제 배포의 원래 사실을 묻습니다. 세 단계 모두 도구를
  사용하지 않아야 하므로 영구 메모리 쓰기로 대화 문맥 상속을 대신할 수 없습니다.
  잘못된 날짜·사실·세션 ID는 여전히 실패합니다.
- 명시적 usage 0을 추정치로 바꾸지 않습니다. 캐시를 포함한 입력 총합이
  0이면 계속 실패하며, 최종 assistant usage나 누적 `modelUsage`로 대신해 통과시키지 않습니다.
- 내용을 남기지 않는 timeout/취소 진단과 정리 전 네이티브 daemon 스냅샷으로
  bridge 정지와 네이티브 기동 정지를 구분합니다. 명령별 stdout/stderr와 daemon
  로그도 정리 후에 남습니다.

이전의 간헐적 SDK/네이티브 정지의 upstream 원인을 확정하거나 제거했다고 주장하지
않습니다. 앞서 수행한 오프라인 근거는
`.verify-runs/soak-20260922-1403/overnight/runtime-fix-offline-v2.log`에 있습니다.

```bash
# 단위·구조 테스트. 모델 호출도 크레딧 소모도 없습니다.
npm test

# 랩탑에서 전체 통과한 설정 재현 (매트릭스 작업자 6개 동시 실행)
PENDING_TOOL_WAIT_MS=30000 npm run verify -- \
  --timeout-scale 2 --model-concurrency 3 --scenario-concurrency 2

# 전체 검증 매트릭스: 11개 시나리오 x 6개 모델 = 66개 실행 슬롯 (timeout scale: 1)
npm run verify

# 검증 대기 시간을 늘립니다. 재정의는 이 명령에만 적용됩니다.
PENDING_TOOL_WAIT_MS=30000 npm run verify -- --timeout-scale 2

# 드라이버를 다듬는 동안 한 칸만 실행
npm run verify -- --models claude-opus-5.5 --scenarios v04-shell-ops

# 계획·커버리지·단일 턴 기준 일정 추정치만 출력. 아무것도 실행하지 않습니다.
npm run verify -- --dry-run
PENDING_TOOL_WAIT_MS=30000 npm run verify -- --timeout-scale 2 --dry-run

# 슬롯 작업 디렉터리를 지우지 않고 남겨 사후 분석
npm run verify -- --scenarios v08-hooks-memory --keep-workspaces

# 최신 실행을 그 실행의 기록에서 다시 읽기
npm run verify:report

# 최신 실행으로 docs/VERIFICATION.md와 docs/VERIFICATION_KO.md 재생성
npm run verify:doc
```

최신 실행 자동 선택은 부분 실행이나 미완료 실행을 고를 수 있습니다. 특정 완료된
전체 실행의 결과를 문서화하려면 로컬 산출물 디렉터리를 명시하고 두 언어에 같은
디렉터리를 사용합니다.

```bash
run_dir=".verify-runs/<completed-run-id>"
node scripts/verify/report.mjs "$run_dir"
node scripts/verify/report.mjs "$run_dir" --markdown > docs/VERIFICATION.md
node scripts/verify/report.mjs "$run_dir" --markdown=ko > docs/VERIFICATION_KO.md
```

`--timeout-scale`의 기본값은 `1`이므로 기존 `npm run verify` 명령의 검증 예산은
그대로입니다. `2`는 검증 실행기의 모델 응답 관련 대기(headless 턴, plan 턴,
v11 launcher/출력 대기)와 bridge-health 대기를 두 배로 늘립니다. v01–v10의
시나리오 timeout은 **슬롯 전체가 아니라 headless 턴/호출마다 적용**됩니다.
여러 턴으로 구성된 슬롯은 그만큼 여러 번 기다릴 수 있습니다. v11의 catalog 기반
`scenarioMs` 값은 **계획용일 뿐**이며 실제 대기는 별도의 launcher/출력 제한을
사용합니다. Status/list/stop/final-cleanup wrapper, poll/probe, 로컬 테스트 제한,
SIGKILL 유예 시간과 실제 운용 launcher/daemon 시작 기본값은 바뀌지 않습니다.

명령 한정 `PENDING_TOOL_WAIT_MS=30000` 재정의는 별도의 pending-tool 대기를
30초로 설정합니다. `--timeout-scale`을 곱하지 않으며 runtime 기본값으로 저장하지도
않습니다. 검증 시의 예방 조치이지 **결과 없이 종료되는 현상의 확립된 해결책은
아닙니다**. `--model-concurrency`와 `--scenario-concurrency`는 모델 작업자 수와
모델별 시나리오 작업자 수를 정합니다(기본값: `6`, `2`). Dry-run의 단일 턴 기준
일정 추정치는 계획을 돕는 값이지 **deadline이나 실제 최악의 경우 상한은 아닙니다**.

`npm run verify`는 실제 GitHub Copilot AI Credits를 사용합니다. 모든 슬롯은
실제 Claude Code 바이너리 → bridge → Copilot SDK → 실제 모델의 전체 경로를
그대로 실행하며, mock도 replay도 없습니다. 슬롯마다 bridge, port, token,
`CLAUDE_CONFIG_DIR`, git 작업 디렉터리를 따로 받기 때문에 한 모델의 지연이 다른
모델의 실패로 읽히지 않습니다. 실행기는 `~/.claude/settings.json`이 바뀌지
않았는지 확인하기 위해 실행 전후의 해시만 읽으며, 파일 내용을 기록하거나
슬롯의 설정으로 사용하지 않습니다.

판정은 1차 증거 — 디스크의 파일, git 기록, hook 로그, 스트림이 남긴 도구 호출
기록 — 으로만 합니다. 모델이 쓴 문장은 심어 둔 토큰이 있는지만 확인하며 문체나
구성, 동의 여부로는 판정하지 않습니다. 실제로 응답한 모델은 `result.modelUsage`
에서 되읽기 때문에 backend가 조용히 바뀌면 통과가 아니라 실패가 됩니다.

`blocked`는 통과가 아닙니다. timeout, bridge 중단, 짝이 맞지 않는
`tool_use`/`tool_result`는 분모에 그대로 남습니다. 새 실행의 정책은
`strict-all-pass-v1`입니다. 전체 매트릭스는 **66개 중 66개**, 명시적인
**부분(focused)** 실행은 선택한 모든 슬롯이 통과해야 합니다. 실행 전 모델 ×
시나리오의 예상 고유 집합을 고정하며, 누락·중복·예상 밖 슬롯이나 fail·blocked·
알 수 없는 결과가 하나라도 있으면 0이 아닌 코드로 종료합니다. 빈 매트릭스,
잘못된 동시성 값, 비어 있거나 중복되거나 알 수 없는 선택은 산출물 생성이나
모델 호출 전에 거부합니다. 가중 기능 커버리지는 선택한 시나리오 카탈로그의
범위이며 **통과율이 아닙니다**. 부분 통과는 전체 매트릭스 통과가 아닙니다.

`summary.json`에는 정책, 예상·실제 슬롯 수, 전체/부분 범위와 시작·종료 시점의
로컬 git commit/dirty 상태가 기록됩니다. 결정적인 SHA-256 지문에는 `src/`,
`scripts/verify/`, `bin/` 및 루트 package 파일의 추적 중인 구현과 관련 미추적
새 코드가 포함되며, 로그·실행 산출물·생성된 문서는 제외됩니다. 코드/commit이나
사용자 설정이 바뀌거나 출처 기록이 없으면 전 슬롯이 pass여도 통과가 아닙니다.
작업 트리가 dirty여도 기록된 구현이 유지되었다면 통과할 수 있습니다. 터미널과
영문/한글 보고서는 실행기와 같은 엄격한 판정을 사용합니다. 과거 요약의 gate와
green은 **legacy 저장 정책**으로 명시하여 보존하며, 엄격한 전체 통과로 바꾸거나
없는 메타데이터를 성공으로 추정하지 않습니다.

두 명령 모두 LiteLLM은 다루지 않습니다. `npm run verify`는 `src/server.mjs`를
직접 실행하며 LiteLLM을 기동하지 않으므로, LiteLLM 경로는 검증된 경로가
아니라 구성 참고 자료입니다.

[검증 결과](docs/VERIFICATION_KO.md)에 최신 전체 매트릭스, 각 시나리오의 의도,
그리고 각 시나리오가 bridge에서 잡아내려는 결함을 기록합니다. 실행 기록에서
생성하므로 다시 생성하면 덮어씁니다. 터미널 및 영문/한글 보고서는 `summary.execution`에서
기록된 timeout 배율, pending-tool 대기, 동시성, 실제 설정된 시나리오별·단계별 제한도
읽어 표시합니다. 재현 명령에는 기록된 재정의를 포함하며, 이 메타데이터가 없는 과거
실행은 현재 기본값으로 채우지 않고 기록 없음으로 표시합니다.

각 명령이 확인하는 범위는
[아키텍처 문서의 검증 범위](docs/ARCHITECTURE_KO.md#검증-범위)를 참고합니다.
`GHCP_NATIVE_TOOL_SEARCH=1`로 Claude Code의 native ToolSearch를 명시적으로
활성화할 수 있으며, 기본값은 기존 full-schema fallback을 유지합니다.

## 지원 상태

이 프로젝트는 working prototype이며 GitHub와 Anthropic이 공동 지원하는 공식
integration이 아닙니다. 정식 Copilot SDK 1.0.14를 고정해 사용하지만, SDK의 정식
릴리스 여부가 이 bridge를 Claude Code의 공식 지원 integration으로 만들지는 않습니다.

구현 범위, 보안, production 제약은 [아키텍처 문서](docs/ARCHITECTURE_KO.md)를 참고합니다.

| 사용 목적 | 권장 수준 |
|---|---|
| 개인 실험·연구 | 적합 |
| Claude Code UI에서 Copilot 모델 사용 | 핵심 경로 사용 가능 |
| 일반 코딩 작업 | 필요한 tool 조합을 E2E 확인한 뒤 사용 |
| 업무 핵심·장시간 자동화 | 복구, 세션 정리와 기능별 검증을 보강한 뒤 사용 |
| 공식 지원 또는 SLA가 필요한 환경 | 부적합 |
