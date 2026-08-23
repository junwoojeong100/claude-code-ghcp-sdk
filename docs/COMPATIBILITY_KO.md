# Claude Code 호환성

> **Language / 언어:** [English](COMPATIBILITY.md) | 한국어

이 문서는 서로 다른 세 가지 주장을 구분합니다.

1. **지원:** 브리지가 구현했거나 로컬 Claude Code 프로세스가 그대로
   제공하는 기능
2. **구현 가능:** 아직 완전히 커버하지 않지만 이 저장소에서 추가할 수 있는 기능
3. **구조적 한계:** Anthropic 계정 서비스 또는 모델 provider 기능에 의존해
   Anthropic Messages 호환 브리지로 재현할 수 없는 기능

구조적 한계를 단순 request translation으로 해결할 수 있는 backlog처럼 설명하면
안 됩니다.

## 구조적 한계

| 기능 | native 동등성을 제공할 수 없는 이유 | 대안 |
|---|---|---|
| Remote Control | `ANTHROPIC_BASE_URL`이 Anthropic 이외 host를 가리키면 Claude Code가 Remote Control을 비활성화합니다. 세션 rendezvous와 mobile/web client는 Anthropic 계정 서비스입니다. | 로컬 terminal 또는 IDE terminal 사용 |
| Claude Code on the web, `--cloud`, Teleport, mobile session | Anthropic 관리 인프라에서 실행되며 claude.ai 계정 session이 필요합니다. | 로컬 실행 또는 공식 지원 Claude provider 사용 |
| Artifacts, cloud ultrareview, routines, Desktop scheduled tasks | publish, schedule, cloud multi-agent 실행은 Messages API가 아니라 claude.ai 서비스입니다. | 로컬 파일·에이전트와 외부 scheduler 사용 |
| Anthropic Analytics, billing, subscription usage, SSO/SCIM | Anthropic 계정·조직 API입니다. Copilot 사용량은 GitHub가 별도로 계산합니다. | GitHub Copilot 사용량·조직 reporting 사용 |
| Anthropic server-side WebSearch, auto-mode classifier, Channels, 계정 관리 MCP connector | gateway Messages API로 표현되지 않는 first-party server component에 의존합니다. | 로컬 `WebFetch`, 명시적 MCP server, 로컬 permission mode 사용 |
| Anthropic prompt-cache metadata | `cache_control` 회계와 cache read/write metadata는 Anthropic model service가 생성합니다. | Copilot provider cache는 사용할 수 있지만 Anthropic cache semantics는 보고할 수 없음 |
| encrypted thinking signature와 Anthropic reasoning block | Copilot SDK가 provider별 reasoning event/summary를 제공할 수는 있어도 Anthropic cryptographic thinking signature를 생성할 수 없습니다. | effort 전달 및 가능한 경우 서명 없는 provider reasoning summary를 text로 노출 |
| Anthropic sampling semantics의 정확한 재현 | 고정된 Copilot SDK의 `SessionConfig`와 `MessageOptions`는 native `temperature`, `top_p`, `max_tokens`, `stop_sequences`, Anthropic `tool_choice`를 제공하지 않습니다. prompt 기반 모방은 동등하지 않습니다. | 미지원 control을 명시적으로 거부하거나 best-effort임을 문서화 |
| Anthropic model availability, safety fallback, Fable consent | Anthropic 조직 정책과 billing에 연결된 검사입니다. | GitHub Copilot model catalog와 조직 정책 사용 |

## 구현된 호환성 보강

아래 항목은 구조적 한계가 아니며 현재 저장소에 구현 또는 bounded compatibility
경로가 추가됐습니다.

- Private registry permission, lock, status, stop, stale cleanup을 포함한
  background agent·agent view용 persistent loopback bridge daemon
- Copilot SDK event 기반 실제 call 이후 token usage와, estimated임을 명시한
  preflight token count
- History 축소 reconciliation, completed-tool cache invalidation, bounded cold
  replay, state split 진단, state LRU/TTL cleanup
- 이 bridge를 통과하는 Claude Code native structured-output validator/retry의
  실제 model 검증
- Copilot SDK-side tool search와 local MCP full-schema fallback
- `CopilotSession.abort()`까지 전달되는 request cancellation
- Edit, Write, NotebookEdit, Bash, permission, hook, skill, plugin, MCP,
  multimodal input, worktree, session, stream, cron, subagent 실제 E2E

정확한 native sampling semantics나 crash-atomic in-flight recovery 같은 남은
제약은 기능 커버리지 표에 기록합니다. 이 구현들이 위 구조적 한계를 제거하지는
않습니다.

## IDE 관련 구분

Remote Control과 IDE integration은 다른 기능입니다. VS Code나 JetBrains의
integrated terminal에서 `claude`를 실행하면 이 브리지를 사용합니다. IDE extension이
자체 Claude Code process를 시작하는 경우에는 이 저장소 wrapper나 임시 settings를
자동으로 상속하지 않으므로 wrapper 실행 또는 동등한 환경 설정이 필요합니다.

## 미지원 control 처리 원칙

Copilot SDK로 표현할 수 없는 provider control 요청은 명시적으로 실패시키거나
best-effort 동작이라고 표시해야 합니다. Anthropic과 동등한 semantics를 제공한다고
조용히 가정하면 안 됩니다.

공식 참고 문서:

- [Claude Code 기능 가용성](https://code.claude.com/docs/en/feature-availability)
- [Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol)
- [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control)
- [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web)
- [Claude Code model configuration](https://code.claude.com/docs/en/model-config)
