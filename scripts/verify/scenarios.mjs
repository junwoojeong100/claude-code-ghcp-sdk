/** Six bridge-relevant behaviors, adapted from the neighboring Codex essential suite. */
export { PRIMARY_MODELS } from "../../src/model-map.mjs";
export const SUITE_ID = "claude-ghcp-essential-v1";
export const SCHEMA_VERSION = 2;
export const OUTCOMES = Object.freeze({
  pass: "Every required check passed.",
  fail: "An exercised requirement has a confirmed violation.",
  blocked: "Required execution or evidence is unavailable; not a pass.",
});

function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

export const SCENARIOS = freeze([
  {
    id: "V01", revision: 2, name: "Launch, Unicode and fresh conversation", nameKo: "실행·Unicode·새 대화 격리", budgetSeconds: 240,
    phases: [{ id: "print" }, { id: "unicode" }, { id: "clear" }],
    pass: ["A real print-mode response completes with exactly the requested answer.", "The native picker exposes all six target models; a new Unicode answer is exact.", "Native /clear changes the session and removes the previous conversation from the next request."],
    passKo: ["실제 print 응답이 정상 완료되며 요청한 답과 정확히 같습니다.", "native picker에 대상 모델 6개가 있으며 새로운 Unicode 응답이 정확합니다.", "native /clear가 세션을 바꾸고 다음 요청에서 이전 대화가 제거됩니다."],
  },
  {
    id: "V02", revision: 1, name: "Read, edit and regression tests", nameKo: "읽기·수정·회귀 테스트", budgetSeconds: 300,
    phases: [{ id: "coding" }],
    pass: ["Read returns the complete hidden sample, source and tests before the failing foreground test.", "A successful Edit fixes only discount.mjs, followed by the identical unmasked test command and three passes.", "An independent test run passes; other files, modes and links are unchanged; the final answer is the hidden sample."],
    passKo: ["실패하는 foreground 테스트 전에 Read가 숨은 sample·소스·테스트 전체를 반환합니다.", "성공한 Edit가 discount.mjs만 고친 뒤 종료 상태를 가리지 않은 동일 명령의 테스트 3개가 통과합니다.", "독립 재검사도 통과하며 다른 파일·모드·링크는 불변이고 최종 답은 숨은 sample입니다."],
  },
  {
    id: "V03", revision: 1, name: "MCP error and tool-result recovery", nameKo: "MCP 오류·도구 결과 복구", budgetSeconds: 240,
    phases: [{ id: "lookup" }, { id: "recall" }],
    pass: ["The CLI-owned MCP lookup returns ENOENT for missing before returning the hidden selected value.", "Native tool IDs, arguments, results and MCP ledger agree; no file/shell bypass is used.", "A second turn recalls the exact value without tools in the same process and session."],
    passKo: ["CLI 소유 MCP lookup이 missing의 ENOENT를 반환한 후 숨은 selected 값을 반환합니다.", "native 도구 ID·인자·결과와 MCP ledger가 일치하며 파일·셸 우회가 없습니다.", "같은 프로세스·세션의 두 번째 턴에서 도구 없이 정확한 값을 회상합니다."],
  },
  {
    id: "V04", revision: 1, name: "Model and reasoning-level switch", nameKo: "모델·추론 수준 전환", budgetSeconds: 240,
    phases: [{ id: "source", model: "switch-source" }, { id: "target" }],
    pass: ["A different source model answers before native /model selects the target in the same conversation.", "Each new response's requested, resolved and SDK-reported model matches its phase, retaining conversation context.", "High effort reaches supported models and matches authoritative SDK state; Haiku has no applied effort."],
    passKo: ["다른 source 모델이 응답한 후 같은 대화에서 native /model로 target을 선택합니다.", "각 새 응답의 요청·해석·SDK 보고 모델이 단계와 맞으며 대화 문맥이 유지됩니다.", "지원 모델에는 High effort가 전달되어 SDK 실제 상태와 일치하고 Haiku에는 effort를 적용하지 않습니다."],
  },
  {
    id: "V05", revision: 2, name: "Interrupt and continue", nameKo: "중단 후 같은 프로세스에서 계속", budgetSeconds: 240,
    phases: [{ id: "interrupt", interrupted: true }, { id: "recovery" }],
    pass: ["Escape interrupts an actively streaming request, with correlated client_abort and acknowledged SDK abort, not normal completion.", "The same native process and session answer the follow-up exactly with a complete response."],
    passKo: ["Escape가 실제 스트리밍 요청을 중단하며 같은 요청의 client_abort와 SDK abort acknowledgment가 있고 정상 완료는 없습니다.", "같은 native 프로세스·세션이 후속 질문에 정확한 완료 응답을 반환합니다."],
  },
  {
    id: "V06", revision: 2, name: "Compact, quit and cold resume", nameKo: "압축·종료·콜드 재개", budgetSeconds: 420,
    phases: [{ id: "seed" }, { id: "compact" }, { id: "recall" }, { id: "resume" }],
    pass: ["Native /compact records an actual summary request and compaction boundary; a fresh SDK session, sent the compacted history without the seed prompt, recalls a conversation-only value exactly.", "Normal exit and owned bridge cleanup precede a new CLI and bridge resuming the exact saved session ID.", "The resumed session recalls the same value without tools or auxiliary memory; no prompt repeats the value."],
    passKo: ["native /compact의 실제 요약 요청·압축 경계가 기록되고, seed 프롬프트 없이 압축된 기록을 받은 새 SDK 세션이 대화 전용 값을 정확히 회상합니다.", "정상 종료와 소유 브리지 정리 후 새 CLI·브리지가 정확한 저장 세션 ID를 재개합니다.", "재개 세션은 도구·보조 기억 없이 같은 값을 회상하며 후속 프롬프트에 값을 다시 넣지 않습니다."],
  },
]);
export const SCENARIO_IDS = Object.freeze(SCENARIOS.map(({ id }) => id));
export const switchSource = (model) => model === "gpt-6-astra" ? "gpt-6-luna" : "gpt-6-astra";
export const phaseModel = (scenario, phase, model) => scenario.id === "V04" && phase === "source" ? switchSource(model) : model;
export function gateFor(expectedCount) { return expectedCount; }
