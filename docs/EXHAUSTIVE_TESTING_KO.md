# 7모델 전수 E2E 빠른 실행 가이드

이 문서는 Direct GitHub Copilot SDK 경로의 주력 7모델을 빠짐없이
검증하면서 wall-clock 시간을 줄이는 방법을 설명합니다. 테스트는 저장소 source를
수정하지 않고 임시 디렉터리만 사용합니다. 다만 live E2E이므로 실제 GitHub Copilot
AI Credits를 소비합니다.

## 검증 모델

- `claude-opus-5`
- `claude-sonnet-5`
- `claude-haiku-4.5`
- `gpt-5.6-sol`
- `gpt-5.6-terra`
- `gpt-5.6-luna`
- `gpt-6-astra`

## 병렬화 원칙

모델별 lane은 최대 3개만 동시에 실행합니다. 각 lane은 동적 bridge port, 임시
Claude config, 임시 project와 worktree를 사용하므로 서로 격리됩니다. 동시성을 더
높이면 Copilot rate limit, host CPU/memory 경합, 일시적 model timeout 때문에 오히려
느려질 수 있습니다.

`test:e2e:background`는 병렬화하지 않습니다. 저장소의 private bridge registry는
테스트별로 격리되지만 Claude Code가 관리하는 per-user background daemon과 worker
roster는 공유될 수 있기 때문입니다.

| 단계 | 실행 방식 | 범위 |
|---|---|---|
| Unit | 1회 | Protocol, routing, session, daemon, policy |
| 모델 lane | 동시성 3 | Text/Read, 전체 feature, stream, session, worktree |
| Background | 7모델 순차 | Background agent, agent view, bridge cleanup |
| 선택 real-task | 모델 lane 내부 | 별도 임시 coding fixture와 holdout |

## 사전 조건

```bash
cd /path/to/claude-code-ghcp-sdk
npm run doctor
npm run models
bin/claude-ghcp-status
git status --short
```

- 7개 모델이 조직 정책에서 enabled 상태여야 합니다.
- `bin/claude-ghcp-status`의 `running`은 `false`여야 합니다.
- 결과 비교를 단순하게 하려면 clean working tree에서 시작합니다.
- 다른 Claude Code background 작업이 실행 중이면 background 단계는 별도 시간에
  실행합니다.

## 실행

다음 script는 저장소에 runner를 추가하지 않습니다. log와 status는
`${TMPDIR:-/tmp}` 아래에만 기록합니다.

```bash
#!/usr/bin/env bash
set -uo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel)"
CONCURRENCY="${GHCP_E2E_CONCURRENCY:-3}"
RUN_DIR="${TMPDIR:-/tmp}/claude-ghcp-exhaustive.$(date +%Y%m%d-%H%M%S)"
MODELS=(
  claude-opus-5
  claude-sonnet-5
  claude-haiku-4.5
  gpt-5.6-sol
  gpt-5.6-terra
  gpt-5.6-luna
  gpt-6-astra
)

case "$CONCURRENCY" in
  1|2|3) ;;
  *) echo "GHCP_E2E_CONCURRENCY must be 1, 2, or 3." >&2; exit 2 ;;
esac

mkdir -p "$RUN_DIR"
cd "$ROOT_DIR"

SETTINGS_BEFORE="$(
  node src/settings-file-state.mjs "$HOME/.claude/settings.json"
)"
GIT_BEFORE="$(git status --porcelain=v1 --untracked-files=all)"

run_logged() {
  local model="$1"
  local phase="$2"
  local log="$RUN_DIR/$model-$phase.log"
  local status_file="$RUN_DIR/$model-$phase.status"
  local status
  shift 2

  printf 'START model=%s phase=%s\n' "$model" "$phase"
  if "$@" >"$log" 2>&1; then
    status=0
  else
    status=$?
  fi
  printf '%s\n' "$status" >"$status_file"
  printf 'END model=%s phase=%s status=%s\n' "$model" "$phase" "$status"
  return 0
}

run_lane() {
  local model="$1"
  cd "$ROOT_DIR"

  run_logged "$model" base \
    env GHCP_E2E_MODEL="$model" npm run test:e2e

  run_logged "$model" features \
    env \
      GHCP_E2E_MODEL="$model" \
      GHCP_E2E_MULTIMODAL_MODEL="$model" \
      GHCP_E2E_MCP_MODEL="$model" \
      GHCP_E2E_CALL_TIMEOUT_SECONDS=180 \
      npm run test:e2e:features

  run_logged "$model" stream \
    env GHCP_E2E_MODEL="$model" npm run test:e2e:stream
  run_logged "$model" session \
    env GHCP_E2E_MODEL="$model" npm run test:e2e:session
  run_logged "$model" worktree \
    env GHCP_E2E_MODEL="$model" npm run test:e2e:worktree

  if [[ -n "${GHCP_E2E_REAL_TASK_RUNNER:-}" ]]; then
    run_logged "$model" real-task \
      node "$GHCP_E2E_REAL_TASK_RUNNER" "$model"
  fi
}

export ROOT_DIR RUN_DIR GHCP_E2E_REAL_TASK_RUNNER
export -f run_logged run_lane

run_logged shared unit npm test

printf '%s\n' "${MODELS[@]}" |
  xargs -n 1 -P "$CONCURRENCY" bash -c 'run_lane "$1"' _

# Claude Code의 per-user background daemon과 충돌하지 않도록 순차 실행합니다.
for model in "${MODELS[@]}"; do
  run_logged "$model" background \
    env GHCP_E2E_MODEL="$model" npm run test:e2e:background
done

SETTINGS_AFTER="$(
  node src/settings-file-state.mjs "$HOME/.claude/settings.json"
)"
GIT_AFTER="$(git status --porcelain=v1 --untracked-files=all)"
FAILURES=0

for status_file in "$RUN_DIR"/*.status; do
  status="$(<"$status_file")"
  if [[ "$status" != "0" ]]; then
    printf 'FAIL %s status=%s\n' "$(basename "$status_file")" "$status"
    FAILURES=$((FAILURES + 1))
  fi
done

if [[ "$SETTINGS_BEFORE" != "$SETTINGS_AFTER" ]]; then
  echo "FAIL Claude user settings changed." >&2
  FAILURES=$((FAILURES + 1))
fi
if [[ "$GIT_BEFORE" != "$GIT_AFTER" ]]; then
  echo "FAIL working tree changed." >&2
  git status --short
  FAILURES=$((FAILURES + 1))
fi
if ! bin/claude-ghcp-status |
  node -e '
    let value = "";
    process.stdin.on("data", (chunk) => value += chunk);
    process.stdin.on("end", () => {
      if (JSON.parse(value).running) process.exit(1);
    });
  '
then
  echo "FAIL GHCP bridge daemon is still running." >&2
  FAILURES=$((FAILURES + 1))
fi

grep -h '^PASS ' "$RUN_DIR"/*.log || true
printf 'logs=%s failures=%s\n' "$RUN_DIR" "$FAILURES"
exit "$((FAILURES > 0))"
```

정규 matrix는 unit 1회와 live command 42개로 구성됩니다.

- 모델 lane: 7모델 × 5개 command = 35
- 순차 background: 7모델 × 1개 command = 7

한국어 real-task runner까지 지정하면 모델별 suite는 7개가 됩니다. 이 경우
7모델 × 7개 suite와 공유 unit suite 1회를 합쳐 top-level case는 50개입니다.

`test:e2e:primary`와 `test:e2e:gpt-5.6`은 각각의 모델 lane에서 실행하는
`test:e2e`와 겹치므로 위 script에서는 중복 실행하지 않습니다. 모델별
`test:e2e:features`에는 반드시 같은 모델을 `GHCP_E2E_MODEL`,
`GHCP_E2E_MULTIMODAL_MODEL`, `GHCP_E2E_MCP_MODEL`에 모두 지정합니다. 그래야 MCP,
image, PDF 결과를 대표 모델의 결과로 대신하지 않습니다.

실제 저장소 수정 능력을 별도 검증하려면 저장소 밖의 임시 fixture runner 경로를
다음과 같이 넘길 수 있습니다.

```bash
GHCP_E2E_REAL_TASK_RUNNER=/absolute/path/to/isolated-real-task.mjs \
  GHCP_E2E_CONCURRENCY=3 \
  bash /tmp/run-ghcp-exhaustive.sh
```

real-task runner도 모델마다 별도 임시 project를 만들고 종료 시 제거해야 합니다.
테스트, 요구사항 문서와 package manifest의 hash를 전후 비교하고, 모델이 보지 못한
holdout을 모델 종료 후 실행하는 방식을 권장합니다.

## 성공 판정

다음 조건을 모두 만족해야 전수 통과입니다.

1. 모든 `.status` 파일의 값이 `0`
2. 모든 모델의 feature PASS line에서 `multimodal_model`과 `mcp_model`이 해당
   model ID와 동일
3. `settings_unchanged=true`
4. session의 `resume=true`, `fork=true`
5. background의 `background_result=true`, `agent_view=true`,
   `bridge_daemon_cleanup=true`
6. worktree의 `worktree=true`, `source_clean=true`
7. 실행 전후 Git working tree와 `~/.claude/settings.json` state가 동일
8. 최종 `bin/claude-ghcp-status`의 `running=false`

`claude-code:unrecognized_model`은 Claude Code가 custom model 이름을 자체
catalog에서 찾지 못했다는 진단입니다. 테스트가 PASS하고 bridge가 요청한 Copilot
backend ID를 선택했다면 기능 실패로 세지 않습니다.

## 시간과 비용

동시성 3은 AI Credit 사용량을 줄이지 않고 wall-clock 시간만 줄입니다. 일반적으로
순차 실행보다 2~3배 빠르지만 계정 rate limit, 모델 부하와 retry에 따라 달라집니다.
429 또는 timeout이 반복되면 `GHCP_E2E_CONCURRENCY=2`로 낮춥니다.

## SDK 1.0.14 검증 결과, 2026-09-18–19

Claude Code 2.1.276과 SDK 1.0.14(내장 runtime 1.0.85)에서 위 7개 모델의
base, features, stream, session, worktree, background, real-task를 검증했습니다.

- 최종 통과: 모델별 7개 suite 전체
- 집계: 7모델 × 7개 suite + 공유 unit suite 1회 = **top-level case 50개 통과**
- 공유 unit suite: **87개 테스트 통과**
- 모델별 한국어 코딩 과제: **공개 테스트 5개와 holdout 49개 통과**

첫 SDK 1.0.14 실행에서 Luna의 PDF 단계는 기존 180초 제한에서 두 차례 timeout
후 세 번째 허용된 시도에 통과했습니다. 두 번째 실행에서는 Haiku의 feature suite가
첫 시도에 `mcp_tool_search`에서 실패한 후 재시도에 통과했습니다. 제한 시간이나
통과 기준은 완화하지 않았으며, 최종 통과를 첫 시도 전부 성공으로 해석하면 안 됩니다.

이 집계는 Claude Code 2.1.276에서의 실행 기록입니다. 이후 2026-09-19의
Claude Code 2.1.277 UI 녹화 재검증에서는 단위 테스트 88개와 연동 suite가
통과했지만 Haiku 실전 코딩 과제에 holdout 실패 1건이 남았습니다.
최신 집계(49/50)와 재시도 내역은
[실제 UI 녹화 재검증](FEATURE_COVERAGE_KO.md#실제-ui-녹화-재검증-2026-09-19)에
별도로 기록했으며, 위 과거 통과 집계와 합산하지 않습니다.

2026-08-25의 집계와 소요 시간은 당시 대상·환경의 기록으로 현재 범위에서 제외합니다.
그 결과를 현재 7개 모델의 검증 결과로 바꾸어 표기하지 않습니다.

## 일반 바이브코딩 결론

위 SDK 1.0.14 검증은 7개 모델 각각에서 root agent의 subagent 호출과 nested `Read`,
local stdio MCP, 35-tool full-schema fallback, background agent와 agent view를
포함합니다. 명시한 재시도 후 검증한 범위의 일반적인 **코드 조사 → subagent 위임 →
local MCP 조회 → 수정 → 테스트** 흐름을 통과했습니다.

이 결론은 수백 개 이상의 MCP tool, 대규모 agent fan-out/team messaging, Anthropic
계정 관리형 MCP connector/Channels 또는 process crash 중 in-flight 복구까지
보증한다는 의미는 아닙니다. 이러한 대규모·관리형·장애 복구 시나리오는 별도 부하와
lifecycle 검증이 필요합니다.

`test:e2e:background`가 남길 수 있는 Claude Code 자체 per-user daemon을 정리하려고
`claude daemon stop --any`를 자동 실행하면 안 됩니다. 다른 사용자의 session까지
종료할 수 있습니다. 이 가이드가 확인하는 정리 대상은 저장소의 private GHCP bridge
daemon입니다.

LiteLLM은 별도 provider 경로입니다. 실행 중인 LiteLLM 환경이 있을 때만
`npm run test:e2e:litellm`을 별도로 실행합니다.
