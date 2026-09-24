/**
 * Eleven verification scenarios for Claude Code driven through the GHCP bridge.
 *
 * Question they answer: running Claude Code against GitHub Copilot models
 * through this bridge, do the features people actually use behave the way they
 * do on a native Anthropic connection?
 *
 * Design rules:
 *  - Eleven scenarios, each deliberately dense. Coverage comes from stacking
 *    several real features into one honest task, not from counting tasks.
 *  - Every slot runs the real path: real Claude Code binary -> bridge ->
 *    Copilot SDK -> Copilot model. Nothing is stubbed or replayed.
 *  - `pass` states each scenario's own checks as drivers.mjs makes them, and
 *    `passKo` says the same in Korean. Keep both in step with the driver.
 *  - Assertions are on observable state (files on disk, git history, hook
 *    logs, stream events), never on the model's prose style. Six models
 *    write six different sentences; only behaviour is comparable.
 *  - Wire-protocol correctness (SSE framing, tool_use/tool_result pairing,
 *    stop_reason, usage) gets no scenario of its own: it is asserted inside
 *    every scenario that would break if it were wrong.
 *  - v01-v10 drive `claude --settings` against a bridge the harness started.
 *    v11 drives `bin/claude-ghcp` instead, because the launcher and the daemon
 *    it leaves running are what users actually invoke, and nothing else here
 *    touches them.
 *
 * budgetSeconds is a base ceiling per Claude Code invocation, not per slot.
 * run.mjs applies --timeout-scale before handing it to the driver. Every
 * runHeadless call re-arms that limit, so v09 can spend it three times over.
 * v11 never calls runHeadless and uses independent launcher/file-wait caps.
 * planRun() counts just one scaled catalogue budget per scenario: a single-turn
 * scheduling estimate, not a worst-case bound or runtime deadline. Startup,
 * extra turns and cleanup can take longer. WALL_CLOCK_LIMIT_SECONDS checks
 * the default catalogue's estimate; nothing stops a run that exceeds it.
 */

import { COVERAGE_TARGET, coverage } from "./features.mjs";
import { scaleTimeoutMs } from "./timeouts.mjs";
import { isEntryPoint } from "../../src/entry-point.mjs";
import { PRIMARY_MODELS } from "../../src/model-map.mjs";

export { PRIMARY_MODELS };

export const REQUIRED_ROUTE =
  "claude-code>bridge>github-copilot-sdk>github-copilot-model";

export const OUTCOMES = Object.freeze({
  pass: "Every check passed.",
  fail: "At least one check failed.",
  blocked:
    "Could not be judged: the harness could not run the slot, a Claude Code invocation did not finish or did not run, " +
    "a tool_use or tool_result was left without its pair, or modelUsage did not name the slot's model. Counts as not passed.",
});

/**
 * What a passing matrix does not show, stated once for the generated
 * VERIFICATION documents. `en` and `ko` carry the same items in the same order.
 * Links are relative to docs/, where the generated files live, and the
 * #feature-coverage anchors point at the generated documents' own section.
 */
export const NOT_VERIFIED = Object.freeze({
  en: Object.freeze([
    "**Upstream errors.** No slot injects a Copilot failure. The bridge's 429 (rate limit) and 529 (overloaded) responses are covered by `npm test`, not by this run.",
    "**The context-limit error and compaction.** No scenario fills a model's context window, so the bridge's context-limit error and the compaction Claude Code runs after it do not occur.",
    "**Interactive sessions.** v01–v10 run every Claude Code invocation in print mode (`-p`). v11 runs the launcher with `--background`, `-p` and `agents`. The interactive terminal UI, `/rewind` and Esc cancellation are not exercised.",
    "**Permission prompts.** v01–v10 run with `bypassPermissions`, except v02's plan-mode turn. v11's launches that call a model run with `acceptEdits`. The prompt that asks a person to approve a tool is not exercised.",
    "**Which Copilot model answered.** The model check reads `modelUsage`, which names the model Claude Code requested. It does not show which Copilot model served the turn.",
    "**Running custom commands, skills and scheduled jobs.** v08 checks that they appear in Claude Code's init event and that a scheduled job is created and listed. No check requires one to run.",
    "**A bridge restart in the middle of a session.** v09's first, resumed and forked processes all use one bridge that keeps running.",
    "**LiteLLM.** Every slot talks to the bridge directly.",
    "**Models outside the matrix.** Only the models in the results table ran.",
    "**Request fields the bridge ignores or cannot apply.** See [COMPATIBILITY.md](COMPATIBILITY.md#unsupported-controls).",
    "**Features without a check, and features no scenario declares.** Both are listed under [Feature coverage](#feature-coverage).",
    "**Other hosts.** The run used one machine, named at the top of this page.",
    "**Code committed after the recorded commit.** This run covers only the commit named at the top of this page. [README.md](../README.md#verified) lists the later changes and what checks them.",
  ]),
  ko: Object.freeze([
    "**업스트림 오류.** Copilot 실패를 일부러 일으키는 슬롯이 없습니다. 브리지의 429(요청 한도)와 529(과부하) 응답은 이 실행이 아니라 `npm test`가 확인합니다.",
    "**컨텍스트 한도 오류와 압축.** 모델의 컨텍스트 창을 채우는 시나리오가 없습니다. 그래서 브리지의 컨텍스트 한도 오류와 그 뒤에 Claude Code가 하는 압축이 일어나지 않습니다.",
    "**대화형 세션.** v01–v10은 Claude Code를 모두 print 모드(`-p`)로 실행합니다. v11은 런처를 `--background`, `-p`, `agents`로 실행합니다. 대화형 터미널 화면, `/rewind`, Esc 취소는 다루지 않습니다.",
    "**권한 확인 창.** v01–v10은 `bypassPermissions`로 실행하고, v02의 plan 모드 턴만 예외입니다. v11에서 모델을 호출하는 실행은 `acceptEdits`로 실행합니다. 사람에게 도구 사용 승인을 묻는 확인 창은 검증하지 않습니다.",
    "**실제로 답한 Copilot 모델.** 모델 검사는 `modelUsage`를 읽는데, 여기에는 Claude Code가 요청한 모델 이름이 들어 있습니다. 어떤 Copilot 모델이 턴을 처리했는지는 알 수 없습니다.",
    "**커스텀 명령, 스킬, 예약 작업의 실행.** v08은 이들이 Claude Code의 init 이벤트에 나오는지, 예약 작업이 만들어지고 목록에 나오는지만 확인합니다. 실제로 실행되었는지는 검사하지 않습니다.",
    "**세션 도중의 브리지 재시작.** v09의 처음·재개·포크 프로세스는 계속 실행 중인 브리지 하나를 함께 씁니다.",
    "**LiteLLM.** 모든 슬롯이 브리지에 직접 연결합니다.",
    "**매트릭스 밖의 모델.** 결과 표에 있는 모델만 실행했습니다.",
    "**브리지가 무시하거나 적용하지 못하는 요청 값.** [COMPATIBILITY_KO.md](COMPATIBILITY_KO.md#적용하지-않는-요청-값)를 보세요.",
    "**검사가 없는 기능과 어느 시나리오도 선언하지 않은 기능.** 둘 다 [기능 커버리지](#기능-커버리지)에 있습니다.",
    "**다른 호스트.** 이 실행은 이 문서 맨 위에 적은 머신 한 대에서만 돌았습니다.",
    "**기록한 커밋 이후의 코드.** 이 실행은 이 문서 맨 위에 적은 커밋만 검증합니다. 이후 변경과 그 변경을 확인하는 방법은 [README_KO.md](../README_KO.md#검증한-것)에 있습니다.",
  ]),
});

/**
 * Features a scenario lists in `covers` that no check in its driver would fail
 * on. They still count toward the coverage percentage, which counts declared
 * features, so the generated document names them next to it.
 */
export const DECLARED_WITHOUT_CHECK = Object.freeze([
  Object.freeze({
    feature: "parallel-tools",
    scenario: "v01-repo-recon",
    en: "No check counts the tool calls in one assistant message. No other scenario declares this feature.",
    ko: "한 어시스턴트 메시지에 든 도구 호출 수를 세는 검사가 없습니다. 이 기능을 선언한 다른 시나리오도 없습니다.",
  }),
  Object.freeze({
    feature: "error-recovery",
    scenario: "v04-shell-ops",
    en: "No v04 check involves a failed tool result. v03 and v08 also declare this feature.",
    ko: "v04에는 실패한 도구 결과를 다루는 검사가 없습니다. v03과 v08도 이 기능을 선언합니다.",
  }),
]);

export const DEFAULT_PLAN = Object.freeze({
  modelConcurrency: 6,
  scenarioConcurrency: 2,
  overheadSeconds: 180,
});

// Compared against planRun()'s estimate in the suite. It is a design bar for
// the matrix, not a runtime kill switch: no part of run.mjs measures elapsed
// wall clock or stops a run that passes it.
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
    passKo: Object.freeze([...(spec.passKo ?? [])]),
  });
}

// `pass` and `passKo` list the scenario's own checks, in the same order. The
// checks every Claude Code turn gets (completion, tool_use/tool_result pairing,
// the model in modelUsage, stop_reason, input tokens, no error) are stated
// once by the report, not repeated here.
export const SCENARIOS = Object.freeze([
  scenario("v01-repo-recon", "Repository reconnaissance", "저장소 정찰", {
    intent:
      "Locate code across a repository before touching it, which is the first move of nearly every session.",
    intentKo: "코드를 고치기 전에 저장소에서 대상을 찾습니다. 거의 모든 세션이 이 동작으로 시작합니다.",
    bridgeRisk:
      "Results from several search calls are lost, mis-paired or reordered, so the model cites a path it never read.",
    bridgeRiskKo:
      "여러 검색 호출의 결과가 유실되거나, 짝이 어긋나거나, 순서가 바뀌어 모델이 읽지 않은 경로를 답하는 경우.",
    covers: ["read", "bash", "parallel-tools", "headless", "streaming", "stream-input", "result-envelope", "model-identity"],
    pass: [
      "Claude Code parsed the stream-json input and echoed the user message back.",
      "A search tool was used: Bash, Glob, Grep or Task (this build has no Glob or Grep).",
      "The answer names the file that defines the constant and gives the constant's value.",
      "The answer does not cite either decoy file.",
    ],
    passKo: [
      "Claude Code가 stream-json 입력을 해석하고 사용자 메시지를 되돌려 보냈습니다.",
      "검색 도구(Bash, Glob, Grep, Task 중 하나)를 사용했습니다. 이 빌드에는 Glob과 Grep이 없습니다.",
      "답에 상수를 정의한 파일과 그 상수의 값이 있습니다.",
      "답이 미끼 파일을 가리키지 않습니다.",
    ],
    // Slots passed at 130s and were killed at 151s: the old budget cut the
    // distribution in half rather than bounding a hang.
    budgetSeconds: 240,
  }),

  scenario("v02-surgical-edit", "Surgical edit and file creation", "정밀 편집과 파일 생성", {
    intent:
      "Change exactly what was asked and nothing else, then create a new file. A plan-mode turn runs first and must leave the file alone.",
    intentKo:
      "요청한 부분만 정확히 바꾸고 나머지는 그대로 둔 뒤 새 파일을 만듭니다. 그보다 먼저 plan 모드 턴이 실행되며, 이 턴은 파일을 바꾸면 안 됩니다.",
    bridgeRisk:
      "Whitespace or newline normalisation in the tool_use payload makes Edit's exact match fail, or silently changes the wrong line.",
    bridgeRiskKo:
      "tool_use 입력의 공백이나 줄바꿈이 정규화되어 Edit의 정확한 일치가 실패하거나, 엉뚱한 줄이 조용히 바뀌는 경우.",
    covers: ["read", "edit", "write", "permission-mode", "plan-mode", "settings", "headless", "streaming", "result-envelope", "model-identity"],
    pass: [
      "The plan-mode turn finished without waiting for approval and did not make the change it was asked for.",
      "The edit turn set the marked value to the new one.",
      "The two other marked lines are still present, unchanged.",
      "The requested new file exists and exports the requested const.",
      "The edit turn used Edit (or MultiEdit or NotebookEdit).",
    ],
    passKo: [
      "plan 모드 턴이 승인을 기다리지 않고 끝났고, 요청받은 변경을 하지 않았습니다.",
      "편집 턴에서 표시한 값이 새 값으로 바뀌었습니다.",
      "표시한 다른 두 줄은 바뀌지 않은 채 남아 있습니다.",
      "요청한 새 파일이 있고, 요청한 const를 export합니다.",
      "편집 턴에서 Edit(또는 MultiEdit, NotebookEdit)를 사용했습니다.",
    ],
    budgetSeconds: 240,
  }),

  scenario("v03-test-fix-loop", "Failing test diagnose and fix", "실패 테스트 진단과 수정", {
    intent:
      "The core agentic loop: run the tests, read the failure, change the source, and run again until the tests pass.",
    intentKo: "테스트를 실행하고, 실패를 읽고, 소스를 고친 뒤 테스트가 통과할 때까지 다시 실행하는 핵심 에이전트 루프입니다.",
    bridgeRisk:
      "A failing test run's tool_result is lost on the way to the model, so it never learns the run failed and stops early.",
    bridgeRiskKo:
      "실패한 테스트 실행의 tool_result가 모델에 전달되지 않아, 모델이 실패를 모른 채 일찍 멈추는 경우.",
    covers: ["read", "edit", "bash", "tool-loop", "error-recovery", "headless", "streaming", "result-envelope", "model-identity"],
    pass: [
      "The model called Bash.",
      "A tool result contains \"not ok\", \"fail\" or \"AssertionError\", or is an error, and the model made more than one tool call. Any `node --test` output matches, because it prints a \"# fail\" count.",
      "The test file is byte-for-byte unchanged.",
      "The harness then runs the suite itself, and it exits 0.",
    ],
    passKo: [
      "모델이 Bash를 호출했습니다.",
      "도구 결과 중 하나에 \"not ok\", \"fail\", \"AssertionError\"가 있거나 오류 결과가 있고, 모델이 도구를 두 번 이상 호출했습니다. `node --test` 출력은 \"# fail\" 개수를 늘 찍으므로 어떤 출력이든 이 조건에 맞습니다.",
      "테스트 파일은 바이트 단위로 그대로입니다.",
      "검증 하네스가 테스트를 직접 다시 실행했고, 종료 코드가 0입니다.",
    ],
    budgetSeconds: 240,
  }),

  scenario("v04-shell-ops", "Background shell and git workflow", "백그라운드 셸과 git 워크플로", {
    intent:
      "Long-running processes and version control, the two shell workflows that outlive a single command.",
    intentKo: "명령 하나로 끝나지 않는 두 가지 셸 작업, 오래 실행되는 프로세스와 버전 관리를 다룹니다.",
    bridgeRisk:
      "A long chain of shell and git tool results is lost or mis-paired, so the model skips the commit, the worktree or stopping the ticker.",
    bridgeRiskKo:
      "길게 이어지는 셸과 git 도구 결과가 유실되거나 짝이 어긋나, 모델이 커밋, worktree 생성, ticker 종료 중 하나를 건너뛰는 경우.",
    covers: ["bash", "git", "worktree", "tool-loop", "error-recovery", "headless", "streaming", "result-envelope", "model-identity"],
    pass: [
      "A Bash call named the ticker script or ran in the background, and a Bash command named the tick log or Read was called.",
      "The tick log reached at least three lines, and the record file was written.",
      "A commit in git log has exactly the requested subject.",
      "Git's worktree list can be read, and exactly one other worktree is registered on the requested branch or on the branch EnterWorktree creates for that name.",
      "That worktree holds the marker file on disk and, unchanged, in its HEAD commit.",
      "The marker file is absent from the primary checkout and its HEAD.",
      "No ticker process is still running after the turn ends.",
    ],
    passKo: [
      "ticker 스크립트 이름이 들어가거나 백그라운드로 실행한 Bash 호출이 있고, tick 로그 파일 이름이 들어간 Bash 명령이나 Read 호출이 있습니다.",
      "tick 로그가 세 줄 이상이고, 기록 파일이 만들어졌습니다.",
      "git log에 요청한 제목과 정확히 같은 커밋이 있습니다.",
      "git의 worktree 목록을 읽을 수 있고, 요청한 브랜치나 EnterWorktree가 그 이름으로 만드는 브랜치에 등록된 다른 worktree가 정확히 하나 있습니다.",
      "그 worktree의 디스크와 HEAD 커밋에 표식 파일이 같은 내용으로 있습니다.",
      "주 체크아웃과 그 HEAD에는 표식 파일이 없습니다.",
      "턴이 끝난 뒤 실행 중인 ticker 프로세스가 없습니다.",
    ],
    // Three slots passed at 297-328s while three more were killed 24-43s past
    // the old 300s line. The spread is this scenario's, not a hang.
    budgetSeconds: 420,
  }),

  scenario("v05-multi-step", "Four-step plan across file types", "파일 종류를 넘나드는 4단계 계획", {
    intent:
      "Hold a four-step plan in one turn and land every step: a source file, a plain text file, a new markdown file and a Jupyter notebook. " +
      "Then read a token from a PDF and from a PNG in the workspace.",
    intentKo:
      "한 턴 안에서 4단계 계획을 끝까지 지킵니다. 소스 파일, 텍스트 파일, 새 마크다운 파일, 주피터 노트북을 차례로 고친 뒤, 작업 폴더의 PDF와 PNG에서 확인 문자열을 읽습니다.",
    bridgeRisk:
      "A PDF page or image returned inside a tool_result is dropped by a text-only translation, or the plan is lost as the tool loop lengthens and the last steps are silently skipped.",
    bridgeRiskKo:
      "tool_result 안에 담긴 PDF 페이지나 이미지가 텍스트만 옮기는 변환에서 빠지는 경우, 또는 도구 루프가 길어지며 계획이 흐트러져 마지막 단계가 조용히 빠지는 경우.",
    covers: ["edit", "write", "notebook", "multimodal", "tool-loop", "headless", "streaming", "result-envelope", "model-identity"],
    pass: [
      "All four changes are on disk.",
      "The notebook still parses as an nbformat 4 document, with the new RATE in its cell.",
      "If the answer claims every step is done, all four files back the claim.",
      "The answer reports the token printed in the PDF and the one in the PNG, each with at most one of its six random characters misread.",
    ],
    passKo: [
      "네 가지 변경이 모두 디스크에 반영되었습니다.",
      "노트북이 여전히 nbformat 4 문서로 파싱되고, 셀의 RATE가 새 값입니다.",
      "답이 모든 단계를 마쳤다고 주장하면, 네 파일이 모두 그 주장과 맞습니다.",
      "답에 PDF와 PNG에 적힌 확인 문자열이 모두 있습니다. 각 문자열의 무작위 여섯 글자 중 한 글자까지는 잘못 읽어도 허용합니다.",
    ],
    budgetSeconds: 300,
  }),

  scenario("v06-subagent", "Subagent delegation", "서브에이전트 위임", {
    intent:
      "Hand work to a project-defined subagent and use what comes back.",
    intentKo: "프로젝트에 정의한 서브에이전트에 작업을 넘기고, 돌아온 결과를 이어서 씁니다.",
    bridgeRisk:
      "The subagent runs its own tool loop in a nested session. Its final report is lost at the handoff, and the parent invents an answer.",
    bridgeRiskKo:
      "중첩 세션에서 도구 루프를 돈 서브에이전트의 최종 보고가 인계 지점에서 유실되어, 부모 에이전트가 답을 지어내는 경우.",
    covers: ["subagent", "subagent-config", "tool-loop", "headless", "streaming", "result-envelope", "model-identity"],
    pass: [
      "The project-defined agent appears in the init event.",
      "The Agent tool (listed as Task in the init event) was called with that agent as `subagent_type`.",
      "The delegation returned a tool_result that is not an error.",
      "The final answer lists every file that carries the marker.",
    ],
    passKo: [
      "프로젝트에 정의한 에이전트가 init 이벤트에 나옵니다.",
      "Agent 도구(init 이벤트에는 Task로 표시)를 그 에이전트를 `subagent_type`으로 지정해 호출했습니다.",
      "위임 호출이 오류가 아닌 tool_result를 돌려받았습니다.",
      "최종 답에 표식이 든 파일이 모두 있습니다.",
    ],
    budgetSeconds: 240,
  }),

  scenario("v07-mcp-playwright", "MCP browser automation, headless", "MCP 브라우저 자동화(headless Chrome)", {
    intent:
      "Third-party capability arriving over MCP and being used for real: a headless Chrome driven through @playwright/mcp.",
    intentKo: "MCP로 들어온 외부 기능을 실제로 씁니다. @playwright/mcp가 headless Chrome을 조작합니다.",
    bridgeRisk:
      "MCP tool schemas are rewritten or namespaced differently on the way through, so the model cannot call them or calls them with the wrong shape.",
    bridgeRiskKo:
      "MCP 도구 스키마가 브리지를 지나며 바뀌거나 이름공간이 달라져, 모델이 도구를 호출하지 못하거나 잘못된 형태로 호출하는 경우.",
    covers: ["mcp-stdio", "mcp-tools", "tool-loop", "headless", "streaming", "result-envelope", "model-identity"],
    pass: [
      "The playwright MCP server shows as connected in the init event.",
      "At least one `mcp__playwright__*` tool was called.",
      "The answer carries the build token shown on the served page.",
    ],
    passKo: [
      "init 이벤트에서 playwright MCP 서버가 연결됨으로 나옵니다.",
      "`mcp__playwright__*` 도구를 한 번 이상 호출했습니다.",
      "하네스가 띄운 페이지에 표시된 빌드 토큰이 답에 있습니다.",
    ],
    budgetSeconds: 300,
  }),

  scenario("v08-hooks-memory", "Hooks, memory, commands and skills", "훅·메모리·명령·스킬", {
    intent:
      "Everything the project configures around the model: CLAUDE.md rules, hooks that observe and deny, custom commands, skills, a plugin and a scheduled task.",
    intentKo:
      "프로젝트가 모델에 덧붙여 설정하는 것을 모두 씁니다. CLAUDE.md 규칙, 관찰하고 차단하는 훅, 커스텀 명령, 스킬, 플러그인, 예약 작업입니다.",
    bridgeRisk:
      "A hook denial reaches the model as an ordinary tool_result instead of an error, so the model reports the blocked command as done.",
    bridgeRiskKo:
      "훅의 차단이 오류가 아닌 평범한 tool_result로 모델에 전달되어, 모델이 막힌 명령을 실행된 것으로 보고하는 경우.",
    covers: ["hooks", "hook-deny", "memory", "slash-commands", "skills", "plugins", "cron", "settings", "permission-mode", "error-recovery", "bash", "write", "headless", "streaming", "result-envelope", "model-identity"],
    pass: [
      "The audit record landed at the path CLAUDE.md requires, not the one the prompt suggested, with the audit token and the required heading.",
      "The hook log shows that the PreToolUse hook and the deny hook both fired.",
      "No tool result carries the page the forbidden `curl` command asked for, and the answer uses a word such as blocked, denied or refused.",
      "The custom slash command and the project skill appear in the init event. Claude Code builds that event from local files before any model request, so this check does not involve the bridge.",
      "A plugin loaded with `--plugin-dir` adds a command and a skill, and both appear in the init event. This check does not involve the bridge either.",
      "A second turn created a job with CronCreate, and CronList returned it by id or prompt.",
    ],
    passKo: [
      "감사 기록이 프롬프트가 제안한 경로가 아니라 CLAUDE.md가 정한 경로에 생겼고, 감사 토큰과 정해진 제목이 들어 있습니다.",
      "훅 로그에 PreToolUse 훅과 차단 훅이 모두 실행된 기록이 있습니다.",
      "금지한 `curl` 명령이 요청한 페이지가 어떤 도구 결과에도 없고, 답에 차단이나 거부를 뜻하는 말(blocked, denied, 차단, 거부 등)이 있습니다.",
      "커스텀 슬래시 명령과 프로젝트 스킬이 init 이벤트에 나옵니다. Claude Code는 모델 요청 전에 로컬 파일로 이 이벤트를 만들므로, 이 검사에는 브리지가 관여하지 않습니다.",
      "`--plugin-dir`로 불러온 플러그인이 명령과 스킬을 하나씩 추가하고, 둘 다 init 이벤트에 나옵니다. 이 검사에도 브리지는 관여하지 않습니다.",
      "두 번째 턴에서 CronCreate로 작업을 만들었고, CronList가 그 작업을 id나 프롬프트로 다시 보여 줍니다.",
    ],
    budgetSeconds: 330,
  }),

  scenario("v09-session-resume", "Session resume across processes", "프로세스 간 세션 재개", {
    intent:
      "Three separate Claude Code processes on one bridge: a seed turn, a `--resume` turn and a `--resume --fork-session` turn. " +
      "The later two must recall literal values from the seed turn without tools or persistent memory. The bridge keeps running between them.",
    intentKo:
      "Claude Code 프로세스 세 개가 브리지 하나를 차례로 씁니다. 처음 턴, `--resume` 턴, `--resume --fork-session` 턴입니다. " +
      "뒤의 두 턴은 도구나 영구 메모리 없이 처음 턴에서 준 값을 그대로 답해야 합니다. 그동안 브리지는 계속 실행 중입니다.",
    bridgeRisk:
      "The bridge finds each Copilot session by the Claude Code session id, together with the agent, model, tools and system prompt. A resumed or forked process is matched to the wrong history, or to none, and answers without the earlier turn.",
    bridgeRiskKo:
      "브리지는 Claude Code 세션 ID와 에이전트, 모델, 도구, 시스템 프롬프트로 Copilot 세션을 찾습니다. 재개하거나 포크한 프로세스가 엉뚱한 기록에 연결되거나 아무 기록에도 연결되지 않아, 앞선 턴 없이 답하는 경우.",
    covers: ["session-resume", "session-id", "session-fork", "headless", "streaming", "result-envelope", "model-identity"],
    pass: [
      "The seed turn ran under the session id the harness gave it, and the resumed turn kept that id.",
      "The resumed turn answered with the planted build id.",
      "None of the three turns called a tool.",
      "The forked turn answered with the planted deploy window, under a session id of its own.",
    ],
    passKo: [
      "처음 턴이 하네스가 준 세션 ID로 실행되었고, 재개한 턴도 같은 ID를 유지했습니다.",
      "재개한 턴이 심어 둔 빌드 ID로 답했습니다.",
      "세 턴 모두 도구를 호출하지 않았습니다.",
      "포크한 턴이 자기 세션 ID로 실행되면서 심어 둔 배포 시간을 답했습니다.",
    ],
    budgetSeconds: 300,
  }),

  scenario("v10-long-context", "Long context retrieval and reasoning", "대형 컨텍스트 검색과 추론", {
    intent:
      "Pull two facts from far apart in a report of about 108,000 characters pasted into the prompt, and combine them into one number.",
    intentKo: "프롬프트에 붙여 넣은 약 108,000자 분량의 보고서에서 멀리 떨어진 두 사실을 찾아 숫자 하나로 계산합니다.",
    bridgeRisk:
      "Context is silently truncated upstream, so the model answers confidently from the part it still has. The report is pasted into the prompt, so a large cut shows up in the input-token count.",
    bridgeRiskKo:
      "업스트림에서 컨텍스트가 조용히 잘려, 모델이 남은 부분만 보고 자신 있게 답하는 경우. 보고서를 프롬프트에 붙여 넣으므로, 크게 잘리면 입력 토큰 수에 드러납니다.",
    // "thinking" is deliberately absent: no Copilot model emitted a single
    // thinking block over this transport in any run, so claiming it would be
    // a coverage number that describes nothing. It sits in the remainder.
    covers: ["long-context", "multi-hop", "structured-output", "headless", "streaming", "result-envelope", "model-identity"],
    pass: [
      "The result carries a structured object with a numeric `difference`, as the `--json-schema` requires.",
      "The difference is exactly right, which needs both facts.",
      "Compared with a one-line control turn, input tokens rose by at least half the report's estimated size (characters ÷ 4).",
      "No Read, Grep or Glob call was made. Bash is not ruled out, and a copy of the report is in the workspace.",
    ],
    passKo: [
      "result에 `--json-schema`가 요구하는 숫자 `difference`를 가진 구조화 객체가 있습니다.",
      "두 사실이 모두 있어야 나오는 차이 값이 정확합니다.",
      "한 줄짜리 대조 턴과 비교해 입력 토큰이 보고서 추정 크기(글자 수 ÷ 4)의 절반 이상 늘었습니다.",
      "Read, Grep, Glob을 호출하지 않았습니다. Bash는 막지 않으며, 작업 폴더에도 보고서 사본이 있습니다.",
    ],
    budgetSeconds: 240,
  }),

  scenario("v11-daemon-background", "Launcher, daemon and background agent", "런처·데몬·백그라운드 에이전트", {
    intent:
      "The front door this project actually ships: the bin/claude-ghcp launcher, the persistent bridge daemon it leaves running, and a detached agent that keeps being served after the launcher exits.",
    intentKo:
      "이 프로젝트가 실제로 제공하는 진입점을 씁니다. bin/claude-ghcp 런처, 런처가 남겨 두는 상주 브리지 데몬, 런처가 끝난 뒤에도 계속 응답을 받는 분리 실행 에이전트입니다.",
    bridgeRisk:
      "A second launch starts a rival daemon instead of reusing the live one, a stale registry hands out a dead port, or stop leaves the port bound. " +
      "Only v11 can see this: v01–v10 each start their own bridge.",
    bridgeRiskKo:
      "두 번째 실행이 살아 있는 데몬을 재사용하지 않고 경쟁 데몬을 띄우거나, 낡은 레지스트리가 죽은 포트를 넘기거나, 정지한 뒤에도 포트가 점유된 채 남는 경우. " +
      "v01–v10은 슬롯마다 브리지를 따로 띄우므로 v11만 이 문제를 볼 수 있습니다.",
    covers: ["launcher", "daemon", "background-agent", "read", "write", "headless"],
    pass: [
      "`bin/claude-ghcp --background` exited with code 0 and printed a background session id.",
      "`claude-ghcp-status` reports the daemon running with a pid and port, and its record names the slot's model.",
      "The detached agent wrote a value that only a fixture file holds.",
      "`claude agents` lists a background session in the slot's workspace.",
      "A print-mode (`-p`) launch, which uses its own bridge, exited with code 0, answered with the value from the file it was told to read, and left the daemon's pid and port unchanged.",
      "A launch that uses the persistent bridge (the `agents` subcommand, which makes no model call) exited with code 0, added a settings file in the daemon's directory, and found the daemon at the same pid and port.",
      "`claude-ghcp-stop` reports stopped, status then shows the daemon not running, and its registry and log are removed.",
    ],
    passKo: [
      "`bin/claude-ghcp --background`가 종료 코드 0으로 끝났고 백그라운드 세션 ID를 출력했습니다.",
      "`claude-ghcp-status`가 데몬이 실행 중이며 pid와 포트가 있다고 보고하고, 그 기록의 모델이 슬롯의 모델과 같습니다.",
      "분리 실행한 에이전트가 검증용 파일에만 있는 값을 기록했습니다.",
      "`claude agents`가 슬롯 작업 폴더의 백그라운드 세션을 보여 줍니다.",
      "자체 브리지를 쓰는 print 모드(`-p`) 실행이 종료 코드 0으로 끝났고, 읽으라고 한 파일의 값으로 답했으며, 데몬의 pid와 포트는 바뀌지 않았습니다.",
      "상주 브리지를 쓰는 실행(모델을 호출하지 않는 `agents` 하위 명령)이 종료 코드 0으로 끝났고, 데몬 폴더에 설정 파일을 하나 더 만들었으며, 같은 pid와 포트의 데몬을 찾았습니다.",
      "`claude-ghcp-stop`이 정지를 보고하고, 이후 status가 데몬이 실행 중이 아님을 보여 주며, 레지스트리와 로그가 지워졌습니다.",
    ],
    budgetSeconds: 420,
  }),
]);

export const SCENARIO_IDS = Object.freeze(SCENARIOS.map((s) => s.id));

/**
 * Single-turn scheduling estimate, counting one scaled budgetSeconds per slot.
 * Multi-turn drivers re-arm the ceiling on each call; bridge startup, v11's
 * independent waits and cleanup are not modelled. This is not a time limit.
 */
export function planRun({
  scenarios = SCENARIOS,
  models = PRIMARY_MODELS,
  modelConcurrency = DEFAULT_PLAN.modelConcurrency,
  scenarioConcurrency = DEFAULT_PLAN.scenarioConcurrency,
  overheadSeconds = DEFAULT_PLAN.overheadSeconds,
  timeoutScale = 1,
} = {}) {
  const budgets = scenarios.map((s) => scaleTimeoutMs(s.budgetSeconds * 1000, timeoutScale) / 1000);
  const serial = budgets.reduce((sum, seconds) => sum + seconds, 0);
  const longest = budgets.reduce((max, seconds) => Math.max(max, seconds), 0);
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

  if (scenarios.length !== 11) {
    problems.push(`Expected 11 scenarios, found ${scenarios.length}.`);
  }
  for (const s of scenarios) {
    if (seen.has(s.id)) problems.push(`Duplicate scenario id: ${s.id}`);
    seen.add(s.id);
    if (!s.intent || !s.intentKo) problems.push(`${s.id}: missing intent`);
    if (!s.bridgeRisk || !s.bridgeRiskKo) problems.push(`${s.id}: missing bridge risk`);
    if (!s.pass.length) problems.push(`${s.id}: no pass criteria`);
    if (s.passKo?.length !== s.pass.length || s.passKo.some((line) => !line)) {
      problems.push(`${s.id}: passKo must translate every pass line`);
    }
    if (!s.covers.length) problems.push(`${s.id}: covers nothing`);
    if (!Number.isFinite(s.budgetSeconds) || s.budgetSeconds <= 0) {
      problems.push(`${s.id}: invalid budgetSeconds`);
    }
  }

  if (NOT_VERIFIED.en.length !== NOT_VERIFIED.ko.length || !NOT_VERIFIED.en.length) {
    problems.push("NOT_VERIFIED needs the same nonempty list in en and ko.");
  }
  for (const entry of DECLARED_WITHOUT_CHECK) {
    const owner = scenarios.find((s) => s.id === entry.scenario);
    if (owner && !owner.covers.includes(entry.feature)) {
      problems.push(`${entry.scenario} does not declare ${entry.feature}, listed in DECLARED_WITHOUT_CHECK`);
    }
    if (!entry.en || !entry.ko) problems.push(`DECLARED_WITHOUT_CHECK ${entry.feature}: missing text`);
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

/** Strict all-pass gate. Empty/incomplete matrices are rejected by assessRun(). */
export function gateFor(applicableCount) {
  return applicableCount;
}

if (isEntryPoint(import.meta.url)) {
  const { ok, problems, coverage: cov, run } = validateCatalog();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ok, problems, coverage: cov, run }, null, 2));
  } else {
    console.log(`scenarios: ${SCENARIOS.length}   models: ${PRIMARY_MODELS.length}   slots: ${run.slots}`);
    console.log(`coverage:  ${cov.percent}% weighted (${cov.coveredWeight}/${cov.totalWeight})`);
    console.log(`uncovered: ${cov.missed.join(", ") || "none"}`);
    console.log(`schedule:  ~${Math.round(run.wallClockSeconds / 60)} min single-turn estimate, peak ${run.peakClaudeProcesses} Claude processes`);
    for (const problem of problems) console.error(`  PROBLEM: ${problem}`);
  }
  process.exit(ok ? 0 : 1);
}
