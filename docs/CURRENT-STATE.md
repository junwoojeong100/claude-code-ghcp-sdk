# Current Claude Code State

확인 시점: 2026-08-19

## 감지된 기존 provider

`~/.claude/settings.json`은 현재 Azure Databricks의 Anthropic-compatible endpoint를 사용합니다.

| 항목 | 감지 결과 |
|---|---|
| Provider | Azure Databricks |
| Endpoint | `*.azuredatabricks.net` (workspace ID redacted) |
| Default UI model | `opus` |
| Opus mapping | `databricks-claude-opus-5[1m]` |
| Sonnet mapping | `databricks-claude-sonnet-5[1m]` |
| Haiku mapping | `databricks-claude-haiku-4-5` |
| Custom mapping | `databricks-claude-sonnet-4-6[1m]` |
| Credential | Configured; value not read into project files |

## 보존 원칙

- 기존 settings 파일을 수정하지 않습니다.
- Databricks endpoint나 token을 이 repository로 복사하지 않습니다.
- repository의 `bin`이 PATH 앞에 있으면 `claude`와 `claude-ghcp`는 command-line
  `--settings`로 provider-related env만 임시 override합니다.
- `claude-current`는 기존 설정을 그대로 사용합니다.
- Launcher 종료 시 임시 settings와 local bridge credential을 제거합니다.

## 현재 사용 가능한 실행 경로

| 목적 | 명령 | 현재 상태 |
|---|---|---|
| Direct GHCP SDK bridge | `claude` 또는 `claude-ghcp` | E2E PASS |
| Local LiteLLM gateway | `claude-litellm` | `127.0.0.1:4000`, E2E PASS |
| 기존 Azure Databricks provider | `claude-current` | 기존 settings 그대로 사용 |

Local LiteLLM runtime은 gitignored `.runtime/`에 설치되어 있고, 별도 GitHub OAuth credential은
`~/.config/litellm/github_copilot`에 mode `0600`으로 저장되어 있습니다. Gateway process는
종료될 수 있으므로 실행 전 다음 health check로 현재 상태를 확인합니다.

```bash
export LITELLM_API_KEY="$(tr -d '\n' < .runtime/litellm-master-key)"
curl --fail \
  -H "Authorization: Bearer $LITELLM_API_KEY" \
  http://127.0.0.1:4000/health/liveliness
```

응답하지 않으면 repository root에서 `npm run litellm:start`를 실행합니다.

## 검증된 precedence

기존 user settings가 Databricks endpoint를 지정한 상태에서도 다음 command-line settings override가 GHCP local bridge로 정상 연결됨을 확인했습니다.

```bash
claude --settings /tmp/ghcp-settings.json --model claude-haiku-4-5 ...
```

이 방식은 user settings의 theme, permissions, plugins, hooks 등 provider 외 설정을 계속 유지합니다.
