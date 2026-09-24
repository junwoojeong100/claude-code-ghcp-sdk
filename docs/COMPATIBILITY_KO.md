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
| Anthropic prompt caching | `cache_control` breakpoint와 그것이 제어하는 cache는 Anthropic model service에 속합니다. Copilot SDK에는 cache breakpoint control이 없으므로 이 marker는 효과가 없습니다. | 브리지는 Copilot 자체 cache read/write token 수를 `cache_read_input_tokens`와 `cache_creation_input_tokens`로 보고합니다. 이 값은 Anthropic cache가 아니라 Copilot cache를 나타냅니다. |
| encrypted thinking signature와 Anthropic reasoning block | Copilot SDK는 provider reasoning event를 내보내지만 Anthropic thinking block에 붙는 cryptographic signature는 생성할 수 없습니다. | Reasoning effort는 전달합니다. 요청의 `thinking` 필드는 무시하며 응답에는 thinking block이 없습니다. Provider reasoning delta는 turn의 idle timer를 유지하는 데만 쓰입니다. |
| Anthropic sampling semantics의 정확한 재현 | 고정된 Copilot SDK의 `SessionConfig`와 `MessageOptions`는 native `temperature`, `top_p`, `max_tokens`, `stop_sequences`, Anthropic `tool_choice`를 제공하지 않습니다. prompt 기반 모방은 동등하지 않습니다. | 네 가지 sampling control은 받지만 적용하지 않습니다. [미지원 control 처리 원칙](#미지원-control-처리-원칙)을 참고하세요. `tool_choice`는 도구 필터링과 system 지시로 모방합니다. |
| Anthropic model availability, safety fallback, Fable consent | Anthropic 조직 정책과 billing에 연결된 검사입니다. | GitHub Copilot model catalog와 조직 정책 사용 |

## 구현된 호환성 보강

아래 항목은 구조적 한계가 아니며 현재 저장소에 구현 또는 bounded compatibility
경로가 추가됐습니다.

- Private registry permission, lock, status, stop, stale cleanup을 포함한
  background agent·agent view용 persistent loopback bridge daemon. Claude Code
  자체 transient daemon은 Claude Code lifecycle이 관리
- Copilot SDK event 기반 실제 call 이후 token usage와, estimated임을 명시한
  preflight token count
- History 축소 reconciliation, completed-tool cache invalidation, bounded cold
  replay, state split 진단, state LRU/TTL cleanup
- 이 bridge를 통과하는 Claude Code native structured-output validator/retry
- Local MCP의 안전한 full-schema fallback과 `GHCP_NATIVE_TOOL_SEARCH=1`의 native
  Claude Code ToolSearch opt-in. 도구 참조는 보존하지만 provider-side deferral 전체의
  동등성은 여전히 문서화된 한계
- Custom agent 정의와 output style 등 native inline system 지시 전달. Token-budget이나
  cache-control metadata 변경을 대화 rewind로 잘못 처리하지 않음
- Request cancellation: client 연결이 끊기면 아직 시작하지 않은 queued request는
  제거하고, 이미 실행 중인 turn에는 `CopilotSession.abort()`를 호출
- Edit, Write, NotebookEdit, Bash, permission, hook, skill, plugin, MCP,
  multimodal input, worktree, session, stream, cron, subagent와 launcher, daemon,
  background agent 실제 E2E. [VERIFICATION_KO.md](VERIFICATION_KO.md) 참고

정확한 native sampling semantics나 브리지가 crash했을 때 진행 중이던 turn의 복구
같은 남은 제약은 README의 [지원 범위](../README_KO.md#지원-범위) 표에 정리돼
있습니다. 이 구현들이 위 구조적 한계를 제거하지는 않습니다.

## IDE 관련 구분

Remote Control과 IDE integration은 다른 기능입니다. VS Code나 JetBrains의
integrated terminal에서 `claude`를 실행하면 이 브리지를 사용합니다. IDE extension이
자체 Claude Code process를 시작하는 경우에는 이 저장소 wrapper나 임시 settings를
자동으로 상속하지 않으므로 wrapper 실행 또는 동등한 환경 설정이 필요합니다.

## 미지원 control 처리 원칙

Copilot SDK로 표현할 수 없는 control을 요청하면 브리지는 요청을 거부하거나, 받은 뒤
보고합니다. 근사치를 적용하고 Anthropic과 동등하다고 주장하지는 않습니다.

- **400 `invalid_request_error`로 거부:** 충족할 수 없는 `tool_choice`. 선언된
  도구가 없는 `any`나 `tool`, 선언되지 않은 도구를 지정한 `tool`, 알 수 없는 mode가
  해당합니다.
- **모방:** `tool_choice: none`은 도구를 제거합니다. `tool_choice: tool`은 지정한
  도구만 남기며, `tool`과 `any`는 도구를 호출하라는 system 지시를 추가합니다. 모델은
  여전히 도구 호출 없이 답할 수 있습니다.
- **받되 적용하지 않고 보고:** `temperature`, `top_p`, `max_tokens`,
  `stop_sequences`. Claude Code 요청은 항상 `max_tokens`를 설정하므로 이를 거부하면
  일반 요청이 실패합니다. 이 중 하나를 설정한 요청마다 `bridge.degraded_controls`를
  기록하며, `GET /health`는 이를 `unsupportedNativeControls`로 나열합니다.
- **받고 무시:** `thinking`, `top_k`, `metadata`, `output_config.format`처럼 이후
  단계에서 읽지 않는 필드. 같은 diagnostic의 `ignoredFields`로 기록되고
  `GET /health`의 `ignoredRequestFields`에 나열됩니다.

보고는 브리지 log와 `GET /health`에만 남습니다. Claude Code에 가는 응답에는 표시가
없으므로, 이런 보장이 필요한 호출자는 응답이 아니라 브리지를 확인해야 합니다.

공식 참고 문서:

- [Claude Code 기능 가용성](https://code.claude.com/docs/en/feature-availability)
- [Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol)
- [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control)
- [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web)
- [Claude Code model configuration](https://code.claude.com/docs/en/model-config)
