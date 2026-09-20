/**
 * Ten verification scenarios for Claude Code driven through the GHCP bridge.
 *
 * Question they answer: running Claude Code against GitHub Copilot models
 * through this bridge, do the features people actually use behave the way they
 * do on a native Anthropic connection?
 *
 * Design rules:
 *  - Ten scenarios, each deliberately dense. Coverage comes from stacking
 *    several real features into one honest task, not from counting tasks.
 *  - Every slot runs the real path: real Claude Code binary -> bridge ->
 *    Copilot SDK -> Copilot model. Nothing is stubbed or replayed.
 *  - Assertions are on observable state (files on disk, git history, hook
 *    logs, stream events), never on the model's prose style. Seven models
 *    write seven different sentences; only behaviour is comparable.
 *  - Wire-protocol correctness (SSE framing, tool_use/tool_result pairing,
 *    stop_reason, usage) gets no scenario of its own: it is asserted inside
 *    every scenario that would break if it were wrong.
 *
 * budgetSeconds is a HARD TIMEOUT, not an expected duration.
 */

import { COVERAGE_TARGET, coverage } from "./features.mjs";

export const PRIMARY_MODELS = Object.freeze([
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4.5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-6-astra",
]);

export const REQUIRED_ROUTE =
  "claude-code>bridge>github-copilot-sdk>github-copilot-model";

export const OUTCOMES = Object.freeze({
  pass: "Native-equivalent behaviour observed from primary evidence.",
  fail: "Observed behaviour diverges from the native contract.",
  blocked:
    "Could not be exercised (timeout, host gap, rate limit). Stays in the denominator; never counts as a pass.",
});

export const DEFAULT_PLAN = Object.freeze({
  modelConcurrency: 7,
  scenarioConcurrency: 2,
  overheadSeconds: 180,
});

export const WALL_CLOCK_LIMIT_SECONDS = 3600;

function scenario(id, name, nameKo, spec) {
  return Object.freeze({
    id,
    name,
    nameKo,
    route: REQUIRED_ROUTE,
    ...spec,
    covers: Object.freeze([...spec.covers]),
    pass: Object.freeze([...spec.pass]),
  });
}

export const SCENARIOS = Object.freeze([
  scenario("v01-repo-recon", "Repository reconnaissance", "저장소 정찰", {
    intent:
      "Locate code across a repository before touching it, which is the first move of nearly every session.",
    intentKo: "코드를 고치기 전에 저장소에서 대상을 찾아내는, 거의 모든 세션의 첫 동작.",
    bridgeRisk:
      "Large tool_result payloads truncated or re-encoded in transit; multi-call turns reordered so the model cites a path it never read.",
    bridgeRiskKo:
      "큰 tool_result가 전송 중 잘리거나 재인코딩되는 경우, 또는 다중 호출 턴 순서가 뒤바뀌어 읽지도 않은 경로를 답하는 경우.",
    covers: ["read", "glob", "grep", "parallel-tools", "headless", "streaming", "result-envelope", "model-identity"],
    pass: [
      "A search tool (Glob, Grep or Bash) was actually used.",
      "The answer names the planted file, not either decoy.",
      "Every tool_use in the transcript has a matching tool_result.",
      "result carries a stop_reason and non-zero usage, and modelUsage names the expected backend.",
    ],
    budgetSeconds: 150,
  }),

  scenario("v02-surgical-edit", "Surgical edit and file creation", "정밀 편집과 파일 생성", {
    intent:
      "Change exactly what was asked and nothing else, then create a new file. The edit contract is byte-level.",
    intentKo: "요청한 것만 정확히 바꾸고 나머지는 건드리지 않은 뒤 새 파일을 만드는, 바이트 단위 편집 계약.",
    bridgeRisk:
      "Whitespace or newline normalisation in the tool_use payload makes Edit's exact-match fail, or silently matches the wrong line.",
    bridgeRiskKo:
      "tool_use 페이로드의 공백·개행 정규화로 Edit의 정확 일치가 실패하거나 엉뚱한 줄에 조용히 매칭되는 경우.",
    covers: ["read", "edit", "write", "permission-mode", "settings", "headless", "streaming", "result-envelope", "model-identity"],
    pass: [
      "The second marked line holds the new value.",
      "The first and third marked lines are byte-for-byte unchanged.",
      "The requested new file exists with the requested export.",
      "The Edit tool was used; the file was not rewritten wholesale.",
    ],
    budgetSeconds: 150,
  }),

  scenario("v03-test-fix-loop", "Failing test diagnose and fix", "실패 테스트 진단과 수정", {
    intent:
      "The core agentic loop: run, read the failure, change the source, run again until green.",
    intentKo: "실행 → 실패 확인 → 소스 수정 → 재실행을 녹색이 될 때까지 반복하는 핵심 에이전트 루프.",
    bridgeRisk:
      "A non-zero exit or stderr-heavy tool_result is dropped or mis-flagged, so the model never learns the run failed and stops early.",
    bridgeRiskKo:
      "비정상 종료나 stderr 위주의 tool_result가 유실·오표기되어 모델이 실패 사실을 모른 채 조기 종료하는 경우.",
    covers: ["read", "edit", "bash", "tool-loop", "error-recovery", "headless", "streaming", "result-envelope", "model-identity"],
    pass: [
      "Bash was used to run the suite.",
      "The first run came back failing and the session continued anyway.",
      "The test file is byte-for-byte unchanged.",
      "The runner re-runs the suite itself afterwards and it exits 0.",
    ],
    budgetSeconds: 240,
  }),

  scenario("v04-shell-ops", "Background shell and git workflow", "백그라운드 셸과 git 워크플로", {
    intent:
      "Long-running processes and version control, the two shell workflows that outlive a single command.",
    intentKo: "단일 명령보다 오래 사는 두 가지 셸 워크플로 — 장기 실행 프로세스와 버전 관리.",
    bridgeRisk:
      "A backgrounded shell's handle is lost across turns, so the model never sees it finish and the process is orphaned.",
    bridgeRiskKo:
      "백그라운드 셸 핸들이 턴을 넘기며 유실되어 모델이 완료를 확인하지 못하고 프로세스가 고아로 남는 경우.",
    covers: ["bash", "git", "tool-loop", "error-recovery", "headless", "streaming", "result-envelope", "model-identity"],
    pass: [
      "A long-running process was started and watched to completion.",
      "The tick log reached at least three lines.",
      "git log shows exactly the requested commit subject.",
      "No ticker process survives the slot.",
    ],
    budgetSeconds: 210,
  }),

  scenario("v05-multi-step", "Four-step plan across file types", "파일 종류를 넘나드는 4단계 계획", {
    intent:
      "Holding a four-step plan over one turn and landing every step, across a source file, a plain text file, a new markdown file and a Jupyter notebook.",
    intentKo:
      "한 턴 안에서 4단계 계획을 유지하며 소스 파일, 평문 파일, 새 마크다운 파일, 주피터 노트북까지 모든 단계를 완수하는 것.",
    bridgeRisk:
      "The plan is lost as the tool loop lengthens, so early steps land and the last ones are silently dropped.",
    bridgeRiskKo:
      "도구 루프가 길어지며 계획이 유실되어 앞쪽 단계만 반영되고 뒤쪽 단계가 조용히 누락되는 경우.",
    covers: ["edit", "write", "notebook", "tool-loop", "headless", "streaming", "result-envelope", "model-identity"],
    pass: [
      "All four changes are present on disk.",
      "The notebook still parses as a valid nbformat 4 document.",
      "No step was reported done without the file backing it.",
    ],
    budgetSeconds: 240,
  }),

  scenario("v06-subagent", "Subagent delegation", "서브에이전트 위임", {
    intent:
      "Handing work to a project-defined subagent and using what comes back.",
    intentKo: "프로젝트에 정의된 서브에이전트에 작업을 넘기고 그 결과를 이어 쓰는 동작.",
    bridgeRisk:
      "The subagent's own tool loop runs on a nested session; its final report can be lost at the handoff, leaving the parent to invent an answer.",
    bridgeRiskKo:
      "서브에이전트의 도구 루프는 중첩 세션에서 돌기 때문에 최종 보고가 인계 지점에서 유실되고 부모가 답을 지어내는 경우.",
    covers: ["subagent", "subagent-config", "tool-loop", "headless", "streaming", "result-envelope", "model-identity"],
    pass: [
      "The project-defined agent is advertised in the init event.",
      "The Task tool was invoked against that agent.",
      "A tool_result came back for the delegation.",
      "The final answer names the files only the delegated search could have found.",
    ],
    budgetSeconds: 240,
  }),

  scenario("v07-mcp-playwright", "MCP browser automation, headless", "MCP 브라우저 자동화(헤드리스)", {
    intent:
      "Third-party capability arriving over MCP and being used for real: a headless Chrome driven through @playwright/mcp.",
    intentKo: "MCP로 들어온 외부 기능을 실제로 사용하는 것 — @playwright/mcp로 구동되는 헤드리스 Chrome.",
    bridgeRisk:
      "MCP tool schemas are rewritten or namespaced differently on the way through, so the model cannot call them or calls them with the wrong shape.",
    bridgeRiskKo:
      "MCP 도구 스키마가 경유 중 재작성·네임스페이스 변경되어 모델이 호출하지 못하거나 잘못된 형태로 호출하는 경우.",
    covers: ["mcp-stdio", "mcp-tools", "tool-loop", "headless", "streaming", "result-envelope", "model-identity"],
    pass: [
      "The playwright MCP server is connected in the init event.",
      "At least one mcp__playwright__* tool was called.",
      "The answer carries the token that only exists in the served page's DOM.",
    ],
    budgetSeconds: 300,
  }),

  scenario("v08-hooks-memory", "Hooks, memory, commands and skills", "훅·메모리·명령·스킬", {
    intent:
      "Everything the project configures around the model: CLAUDE.md rules, hooks that observe and deny, custom commands and skills.",
    intentKo: "프로젝트가 모델 주위에 설정하는 모든 것 — CLAUDE.md 규칙, 관찰·차단하는 훅, 커스텀 명령과 스킬.",
    bridgeRisk:
      "A hook denial arrives as an ordinary tool_result instead of a refusal, so the model treats a blocked action as done.",
    bridgeRiskKo:
      "훅 차단이 거부가 아닌 평범한 tool_result로 전달되어 모델이 막힌 동작을 수행된 것으로 오인하는 경우.",
    covers: ["hooks", "hook-deny", "memory", "slash-commands", "skills", "settings", "permission-mode", "error-recovery", "bash", "write", "headless", "streaming", "result-envelope", "model-identity"],
    pass: [
      "The CLAUDE.md rule was obeyed: the record landed at the path the project mandates.",
      "The PreToolUse hook fired and left its log.",
      "The forbidden command was denied and never ran.",
      "The custom command and skill are advertised in the init event.",
    ],
    budgetSeconds: 240,
  }),

  scenario("v09-session-resume", "Session resume across processes", "프로세스 간 세션 재개", {
    intent:
      "Closing the laptop and picking the same conversation back up: a second process must inherit the first one's context.",
    intentKo: "작업을 덮었다 다시 여는 상황 — 두 번째 프로세스가 첫 번째의 문맥을 그대로 이어받아야 한다.",
    bridgeRisk:
      "Session state is keyed on the upstream connection, so resuming re-opens an empty conversation that answers from nothing.",
    bridgeRiskKo:
      "세션 상태가 업스트림 연결에 묶여 있어 재개 시 빈 대화가 열리고 아무 근거 없이 답하는 경우.",
    covers: ["session-resume", "session-id", "headless", "streaming", "result-envelope", "model-identity"],
    pass: [
      "The resumed process reports the same session id.",
      "It recalls the planted build id.",
      "It used no file-reading tool: the answer came from conversation context.",
    ],
    budgetSeconds: 210,
  }),

  scenario("v10-long-context", "Long context retrieval and reasoning", "대형 컨텍스트 검색과 추론", {
    intent:
      "Pulling two facts from far apart in a large context and combining them, which is what long context is actually for.",
    intentKo: "큰 컨텍스트의 멀리 떨어진 두 사실을 꺼내 결합하는 것 — 긴 컨텍스트의 실제 용도.",
    bridgeRisk:
      "Context is silently truncated upstream, so the model answers confidently from the half it still has. The corpus is carried in the prompt, not read from disk, so nothing but the transport can deliver it.",
    bridgeRiskKo:
      "업스트림에서 컨텍스트가 조용히 잘려 모델이 남은 절반만 보고 자신 있게 답하는 경우.",
    // "thinking" is deliberately absent: no Copilot model emitted a single
    // thinking block over this transport in any run, so claiming it would be
    // a coverage number that describes nothing. It sits in the remainder.
    covers: ["long-context", "multi-hop", "headless", "streaming", "result-envelope", "model-identity"],
    pass: [
      "The arithmetic answer is exactly right, which needs both facts.",
      "Reported input usage reflects the whole corpus, not a truncated prefix.",
      "The answer came from the prompt itself: no file-reading tool was used.",
    ],
    budgetSeconds: 240,
  }),
]);

export const SCENARIO_IDS = Object.freeze(SCENARIOS.map((s) => s.id));

/** Worst-case schedule, assuming every slot runs to its hard timeout. */
export function planRun({
  scenarios = SCENARIOS,
  models = PRIMARY_MODELS,
  modelConcurrency = DEFAULT_PLAN.modelConcurrency,
  scenarioConcurrency = DEFAULT_PLAN.scenarioConcurrency,
  overheadSeconds = DEFAULT_PLAN.overheadSeconds,
} = {}) {
  const serial = scenarios.reduce((sum, s) => sum + s.budgetSeconds, 0);
  const longest = scenarios.reduce((max, s) => Math.max(max, s.budgetSeconds), 0);
  // With n workers the critical path cannot beat either an even split of the
  // total or the single longest scenario.
  const perModel = Math.max(Math.ceil(serial / Math.max(1, scenarioConcurrency)), longest);
  const waves = Math.ceil(models.length / Math.max(1, modelConcurrency));
  const wallClockSeconds = perModel * waves + overheadSeconds;

  return {
    scenarios: scenarios.length,
    models: models.length,
    slots: scenarios.length * models.length,
    modelConcurrency,
    scenarioConcurrency,
    perModel: { serialSeconds: serial, criticalPathSeconds: perModel },
    waves,
    wallClockSeconds,
    withinLimit: wallClockSeconds <= WALL_CLOCK_LIMIT_SECONDS,
    peakClaudeProcesses: Math.min(models.length, modelConcurrency) * scenarioConcurrency,
  };
}

export function validateCatalog(scenarios = SCENARIOS) {
  const problems = [];
  const seen = new Set();

  if (scenarios.length !== 10) {
    problems.push(`Expected 10 scenarios, found ${scenarios.length}.`);
  }
  for (const s of scenarios) {
    if (seen.has(s.id)) problems.push(`Duplicate scenario id: ${s.id}`);
    seen.add(s.id);
    if (!s.intent || !s.intentKo) problems.push(`${s.id}: missing intent`);
    if (!s.bridgeRisk || !s.bridgeRiskKo) problems.push(`${s.id}: missing bridge risk`);
    if (!s.pass.length) problems.push(`${s.id}: no pass criteria`);
    if (!s.covers.length) problems.push(`${s.id}: covers nothing`);
    if (!Number.isFinite(s.budgetSeconds) || s.budgetSeconds <= 0) {
      problems.push(`${s.id}: invalid budgetSeconds`);
    }
  }

  const cov = coverage(scenarios);
  for (const entry of cov.unknown) problems.push(`Unknown feature id: ${entry}`);
  if (cov.ratio < COVERAGE_TARGET) {
    problems.push(
      `Weighted coverage is ${cov.percent}%, below the ${COVERAGE_TARGET * 100}% target. ` +
        `Uncovered: ${cov.missed.join(", ")}`,
    );
  }

  const run = planRun({ scenarios });
  if (!run.withinLimit) {
    problems.push(
      `Default plan needs ${Math.round(run.wallClockSeconds / 60)} min, over the ${
        WALL_CLOCK_LIMIT_SECONDS / 60
      } min limit.`,
    );
  }

  return { ok: problems.length === 0, problems, coverage: cov, run };
}

/** 95% gate. `blocked` is not a pass, so it can never be rounded up to green. */
export function gateFor(applicableCount) {
  return Math.ceil(applicableCount * 0.95);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { ok, problems, coverage: cov, run } = validateCatalog();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ok, problems, coverage: cov, run }, null, 2));
  } else {
    console.log(`scenarios: ${SCENARIOS.length}   models: ${PRIMARY_MODELS.length}   slots: ${run.slots}`);
    console.log(`coverage:  ${cov.percent}% weighted (${cov.coveredWeight}/${cov.totalWeight})`);
    console.log(`uncovered: ${cov.missed.join(", ") || "none"}`);
    console.log(`schedule:  ~${Math.round(run.wallClockSeconds / 60)} min worst case, peak ${run.peakClaudeProcesses} Claude processes`);
    for (const problem of problems) console.error(`  PROBLEM: ${problem}`);
  }
  process.exit(ok ? 0 : 1);
}
