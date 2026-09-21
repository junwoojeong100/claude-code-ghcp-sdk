/**
 * Claude Code core-feature inventory, and the coverage arithmetic behind the
 * "the catalog covers ~90%" claim.
 *
 * The claim is only worth making if it is checkable, so it is computed here
 * from two declared lists rather than asserted in prose:
 *
 *   - FEATURES      every core capability, with a weight for how central it is
 *   - scenario.covers  which of those each scenario actually exercises
 *
 * coverage() multiplies out and reports the real number. Features nothing
 * covers stay in the inventory and drag the number down; they are the honest
 * remainder, listed in the report rather than quietly dropped.
 *
 * Weights
 *   3  used in almost every session (Read, Bash, the tool loop)
 *   2  common but not constant (background shells, hooks, subagent configs)
 *   1  niche
 */

export const FEATURE_WEIGHTS = Object.freeze({ core: 3, common: 2, niche: 1 });

function feature(id, name, nameKo, tier, requiresTool = null) {
  return Object.freeze({ id, name, nameKo, tier, weight: FEATURE_WEIGHTS[tier], requiresTool });
}

/**
 * Tools this Claude Code build does not offer.
 *
 * Measured by `scripts/verify/probe.mjs`, which instructs a session to call
 * each candidate by name and reads the stream: a tool the build does not offer
 * can never produce a tool_use block. Read runs in the same turn as a positive
 * control, so a model that declines wholesale is distinguishable from a tool
 * that is genuinely missing.
 *
 * Glob and Grep are here on that evidence, against an earlier note in this file
 * that had them working while merely unadvertised. They are not: the
 * `inventory-crosscheck` probe saw Read produce a tool_use in the same turn
 * that both of them produced none, and init.tools omits them too. Both
 * independent signals agree for every tool named. Scenarios reach for Bash
 * instead, which is why nothing failed while the note was wrong.
 *
 *   measured on Claude Code 2.1.278, 2026-09-20
 *   node scripts/verify/probe.mjs --only inventory-crosscheck,todo-write,background-shell
 *
 * Features gated on an absent tool leave BOTH sides of the coverage fraction.
 * Counting them as covered would be a lie; counting them as missed would blame
 * the bridge for something the CLI never offered.
 */
export const ABSENT_TOOLS = Object.freeze(["TodoWrite", "BashOutput", "KillShell", "Glob", "Grep"]);

export const FEATURES = Object.freeze([
  // --- built-in tools ------------------------------------------------
  feature("read", "Read tool (numbered lines, offset/limit)", "Read 도구", "core"),
  feature("glob", "Glob path matching", "Glob 경로 검색", "core", "Glob"),
  feature("grep", "Grep content search", "Grep 내용 검색", "core", "Grep"),
  feature("edit", "Edit exact-string replacement", "Edit 정밀 치환", "core"),
  feature("write", "Write file creation", "Write 파일 생성", "core"),
  feature("bash", "Bash command execution", "Bash 명령 실행", "core"),
  feature("bash-background", "Background shells and output polling", "백그라운드 셸/출력 폴링", "common", "BashOutput"),
  feature("todo", "TodoWrite task tracking", "TodoWrite 작업 추적", "common", "TodoWrite"),
  feature("git", "Git workflow driven through Bash", "Bash 기반 git 워크플로", "common"),
  feature("worktree", "Git worktree isolation", "git worktree 격리", "common"),

  // --- agent loop ----------------------------------------------------
  feature("tool-loop", "Multi-turn tool_use -> tool_result loop", "멀티턴 도구 루프", "core"),
  feature("parallel-tools", "Several tool_use blocks in one turn", "한 턴 내 병렬 도구 호출", "common"),
  feature("error-recovery", "Recovering from a failed tool result", "실패한 도구 결과에서 복구", "core"),
  feature("thinking", "Extended thinking / reasoning blocks", "확장 사고 블록", "common"),
  feature("multi-hop", "Multi-step reasoning over retrieved facts", "검색한 사실 기반 다단 추론", "common"),

  // --- delegation ----------------------------------------------------
  feature("subagent", "Task/Agent delegation", "서브에이전트 위임", "core"),
  feature("subagent-config", "Project .claude/agents definitions", "프로젝트 에이전트 정의", "common"),

  // --- extensibility -------------------------------------------------
  feature("mcp-stdio", "MCP stdio server connection", "MCP stdio 서버 연결", "core"),
  feature("mcp-tools", "Invoking tools exposed over MCP", "MCP 도구 호출", "core"),
  feature("hooks", "Hook lifecycle (PreToolUse/PostToolUse)", "훅 수명주기", "common"),
  feature("hook-deny", "Hook-driven tool denial", "훅 기반 도구 차단", "common"),
  feature("memory", "CLAUDE.md project instructions", "CLAUDE.md 프로젝트 지침", "core"),
  feature("slash-commands", "Custom slash commands", "커스텀 슬래시 명령", "common"),
  feature("skills", "Skills discovery and invocation", "스킬 탐색/호출", "common"),
  feature("settings", "settings.json driven configuration", "settings.json 설정", "core"),
  feature("permission-mode", "Permission modes and enforcement", "권한 모드와 집행", "core"),
  feature("plan-mode", "Plan mode withholds edits and still completes", "플랜 모드(편집 보류)", "common"),
  feature("plugins", "Plugins loaded from --plugin-dir", "플러그인(--plugin-dir)", "common"),
  feature("cron", "In-session scheduled tasks", "세션 내 예약 작업", "niche"),

  // --- how this bridge is actually launched ---------------------------
  //
  // Every other feature here is Claude Code's. These three are this project's
  // own front door: the launcher script users type, the daemon it leaves
  // running, and the detached session that daemon has to keep serving after
  // the launcher process is gone. A suite that drove only `claude --settings`
  // verified the bridge but never the thing shipped around it.
  feature("launcher", "bin/claude-ghcp launcher and preflight", "bin/claude-ghcp 런처와 사전 점검", "core"),
  feature("daemon", "Persistent bridge daemon (start, status, stop)", "상주 브리지 데몬(기동·상태·종료)", "common"),
  feature("background-agent", "Detached background agent sessions", "분리형 백그라운드 에이전트 세션", "common"),

  // --- session and context -------------------------------------------
  feature("session-resume", "Resuming a session in a new process", "새 프로세스에서 세션 재개", "core"),
  feature("session-id", "Stable session identity", "세션 ID 일관성", "common"),
  feature("session-fork", "Forking a resumed session", "세션 포크(--fork-session)", "common"),
  feature("long-context", "Retrieval from a large context window", "대형 컨텍스트에서 검색", "common"),

  // --- transport and output ------------------------------------------
  feature("headless", "Headless -p invocation", "헤드리스 -p 실행", "core"),
  feature("streaming", "stream-json event protocol", "stream-json 이벤트 프로토콜", "core"),
  feature("stream-input", "stream-json input and user-message replay", "stream-json 입력/사용자 메시지 재생", "common"),
  feature("structured-output", "--json-schema validated result", "구조화 출력(--json-schema)", "common"),
  feature("multimodal", "Image and PDF content reaching the model", "이미지·PDF 콘텐츠 전달", "common"),
  feature("result-envelope", "result event: stop_reason and usage", "result 이벤트(stop_reason/usage)", "core"),
  feature("model-identity", "Serving model verified from modelUsage", "modelUsage 기반 모델 검증", "core"),

  // --- the remainder: real features the catalog does not reach ---
  feature("webfetch", "WebFetch / WebSearch", "WebFetch / WebSearch", "common"),
  feature("notebook", "NotebookEdit for .ipynb", "NotebookEdit(.ipynb)", "niche"),   // reached by v05
  feature("tui", "Interactive TUI affordances (plan picker, /rewind)", "대화형 TUI 요소", "common"),
  feature("compaction", "Automatic context compaction", "자동 컨텍스트 압축", "common"),
]);

export const FEATURE_IDS = Object.freeze(FEATURES.map((f) => f.id));

const BY_ID = new Map(FEATURES.map((f) => [f.id, f]));

export function featureById(id) {
  return BY_ID.get(id) ?? null;
}

/**
 * Weighted coverage of the inventory by a set of scenarios.
 *
 * Features whose tool this build does not offer are reported separately and
 * excluded from the fraction entirely -- see ABSENT_TOOLS.
 */
export function coverage(scenarios, { absentTools = ABSENT_TOOLS } = {}) {
  const absent = new Set(absentTools);
  const covered = new Set();
  const unknown = [];
  for (const scenario of scenarios) {
    for (const id of scenario.covers ?? []) {
      if (!BY_ID.has(id)) unknown.push(`${scenario.id} -> ${id}`);
      else covered.add(id);
    }
  }

  const unavailable = FEATURES.filter((f) => f.requiresTool && absent.has(f.requiresTool));
  const inScope = FEATURES.filter((f) => !unavailable.includes(f));

  const claimedButAbsent = unavailable.filter((f) => covered.has(f.id)).map((f) => f.id);

  const total = inScope.reduce((sum, f) => sum + f.weight, 0);
  const hit = inScope.filter((f) => covered.has(f.id));
  const missed = inScope.filter((f) => !covered.has(f.id));
  const weighted = hit.reduce((sum, f) => sum + f.weight, 0);

  return {
    unknown,
    claimedButAbsent,
    totalWeight: total,
    coveredWeight: weighted,
    ratio: weighted / total,
    percent: Math.round((weighted / total) * 1000) / 10,
    countRatio: hit.length / inScope.length,
    covered: hit.map((f) => f.id),
    missed: missed.map((f) => f.id),
    unavailable: unavailable.map((f) => ({ id: f.id, weight: f.weight, requiresTool: f.requiresTool })),
    byFeature: inScope.map((f) => ({
      ...f,
      covered: covered.has(f.id),
      scenarios: scenarios.filter((s) => (s.covers ?? []).includes(f.id)).map((s) => s.id),
    })),
  };
}

/** The bar the catalogue must clear. */
export const COVERAGE_TARGET = 0.9;
