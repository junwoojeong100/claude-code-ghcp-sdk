#!/usr/bin/env node
/** Reports consume only explicit, frozen saved runs; no CLI/SDK/network calls. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isEntryPoint } from "../../src/entry-point.mjs";
import { assessRun, FINGERPRINT_SCOPE, slotKey } from "./summary.mjs";
import { evaluateStoredSlot } from "./drivers.mjs";
import { runtimeTimeouts } from "./timeouts.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
// Env names read by src/server.mjs and timeouts.mjs runtimeTimeouts(); abort/MCP discovery budgets have none.
const RUNTIME_ENV = { turnTimeoutMs: "TURN_IDLE_TIMEOUT_MS", maxTurnDurationMs: "TURN_MAX_DURATION_MS", sessionOperationTimeoutMs: "SESSION_OPERATION_TIMEOUT_MS",
  pendingToolWaitMs: "PENDING_TOOL_WAIT_MS", cleanupTimeoutMs: "CLEANUP_TIMEOUT_MS", stateIdleTtlMs: "STATE_IDLE_TTL_MS" };
const RUNTIME_DEFAULTS = runtimeTimeouts({});
const HOME = os.homedir().replace(/[\\/]+$/, ""), hasHome = path.isAbsolute(HOME) && HOME.length > 1;
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), START = String.raw`(?<=^|[\s'"(=:;,[{<>|])`;
const TMP = String.raw`(?:/private)?/var/folders/[^/\s]+/[^/\s]+/T`, TMP_ROOT = new RegExp(`^${TMP}(?=/|$)`);
/** Markdown never names the home directory or macOS per-user temp root, literally or inside a Claude project-directory name. */
const PRIVATE_ROOTS = [
  hasHome && [new RegExp(`${START}${escape(HOME)}(?![\\w.-])`, "gm"), "~"],
  hasHome && [new RegExp(`(?<=^|[\\s'"/])${escape(HOME.replace(/[^A-Za-z0-9]/g, "-"))}(?![A-Za-z0-9])`, "gm"), "-HOME"],
  [new RegExp(`${START}${TMP}(?![\\w.-])`, "gm"), "$TMPDIR"],
  [/(?<=^|[\s'"/])(?:-private)?-var-folders-[A-Za-z0-9-]+?-T(?![A-Za-z0-9])/gm, "-TMPDIR"],
].filter(Boolean);
const redactPaths = s => PRIVATE_ROOTS.reduce((v, [re, to]) => v.replace(re, () => to), s);
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const list = v => Array.isArray(v) ? v : [];
const text = v => v === null || v === undefined || v === "" ? "unknown" : typeof v === "object" ? JSON.stringify(v) : String(v);
const strings = v => [...new Set(list(v).filter(s => typeof s === "string" && s.length))];
const modelList = v => strings(v).join(", ") || "unknown";
const status = v => ["pass", "fail", "blocked"].includes(v) ? v.toUpperCase() : "UNKNOWN";
const shellQuote = v => `'${String(v).replaceAll("'", "'\\''")}'`;
/** Markdown commands name private roots through the reader's environment so they stay copy-pasteable. */
function shellPath(value, markdown) {
  const s = String(value), tmp = TMP_ROOT.exec(s);
  const [root, rest] = markdown && hasHome && (s === HOME || s.startsWith(`${HOME}/`)) ? ["$HOME", s.slice(HOME.length)] : markdown && tmp ? ["$TMPDIR", s.slice(tmp[0].length)] : [];
  return !root ? shellQuote(s) : /^[\w./@%+,:=-]*$/.test(rest) ? `"${root}${rest}"` : `"${root}"${shellQuote(rest)}`;
}
const clean = v => text(v).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{16,})\b/g, "[redacted]");
const cell = v => clean(v).replaceAll("|", "\\|").replace(/\r?\n/g, " ");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const isSha = v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const phasesFor = (summary, slot) => list(list(summary.scenarios).find(s => s?.id === slot?.scenario)?.phases).map(p => p.id);

/** Refuse symlink traversal in every component, not only the terminal filename. */
function localFile(dir, relative, { symlink = false } = {}) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(p => !p || p === "." || p === "..")) throw new Error(`Invalid artifact path: ${relative}`);
  let current = dir;
  const parts = relative.split("/");
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const stat = fs.lstatSync(current), last = i === parts.length - 1;
    if (stat.isSymbolicLink() && !(last && symlink)) throw new Error(`Symlink artifact path: ${relative}`);
    if (!last && !stat.isDirectory()) throw new Error(`Invalid artifact directory: ${relative}`);
  }
  return current;
}
function verifiedJSON(dir, reference) {
  if (!isSha(reference?.sha256)) throw new Error("Missing manifest SHA256");
  const file = localFile(dir, reference.path), bytes = fs.readFileSync(file);
  if (sha(bytes) !== reference.sha256) throw new Error(`Manifest hash mismatch: ${reference.path}`);
  return JSON.parse(bytes);
}

/** Validate stored manifests, not today's checkout or installed executable. */
export function verifySavedArtifacts(dir, summary) {
  const problems = [];
  if (summary.schemaVersion !== 2) return ["Unknown or unsupported saved-run schema; v2 evidence required."];
  try {
    const sources = verifiedJSON(dir, summary.provenance?.sources);
    if (sources.schemaVersion !== 2 || !Array.isArray(sources.entries) || !sources.entries.length) throw new Error("Invalid source manifest");
    const seen = new Set();
    for (const entry of sources.entries) {
      if (typeof entry.path !== "string" || seen.has(entry.path)) throw new Error("Duplicate/invalid source path");
      seen.add(entry.path);
      if (entry.kind === "missing") {
        if (entry.sha256 !== null || entry.bytes !== 0 || entry.copy) throw new Error(`Invalid missing source: ${entry.path}`);
        continue;
      }
      if (!["file", "symlink"].includes(entry.kind) || !isSha(entry.sha256) || !entry.copy?.startsWith("sources/files/")) throw new Error(`Invalid source record: ${entry.path}`);
      const bytes = fs.readFileSync(localFile(dir, entry.copy));
      if (bytes.length !== entry.bytes || sha(bytes) !== entry.sha256) throw new Error(`Frozen source hash mismatch: ${entry.path}`);
    }
    const fingerprint = sha(`${FINGERPRINT_SCOPE}\0${sources.entries.map(({ path: name, kind, executable, bytes, sha256 }) => JSON.stringify([name, kind, executable, bytes, sha256])).join("\n")}\n`);
    if (fingerprint !== summary.provenance?.start?.fingerprint?.value || fingerprint !== sources.fingerprint?.value || sources.entries.length !== summary.provenance?.start?.fingerprint?.files) throw new Error("Frozen sources do not match recorded code fingerprint");
  } catch (error) { problems.push(`Source integrity: ${error.message}`); }
  try {
    const artifacts = verifiedJSON(dir, summary.artifacts?.manifest), entries = artifacts.entries;
    if (artifacts.schemaVersion !== 2 || !Array.isArray(entries) || !entries.length) throw new Error("Invalid artifact manifest");
    const seen = new Set();
    for (const entry of entries) {
      if (seen.has(entry.path) || !isSha(entry.sha256) || !["file", "symlink"].includes(entry.kind)) throw new Error("Duplicate/invalid artifact entry");
      seen.add(entry.path);
      const file = localFile(dir, entry.path, { symlink: entry.kind === "symlink" }), stat = fs.lstatSync(file);
      if (entry.kind === "file" && !stat.isFile() || entry.kind === "symlink" && !stat.isSymbolicLink()) throw new Error(`Artifact type mismatch: ${entry.path}`);
      const bytes = entry.kind === "symlink" ? Buffer.from(fs.readlinkSync(file)) : fs.readFileSync(file);
      if (bytes.length !== entry.bytes || sha(bytes) !== entry.sha256) throw new Error(`Artifact hash mismatch: ${entry.path}`);
    }
    if (summary.artifacts?.slots?.path !== "slots.jsonl" || !seen.has("slots.jsonl") || sha(fs.readFileSync(localFile(dir, "slots.jsonl"))) !== summary.artifacts.slots.sha256) throw new Error("slots.jsonl hash missing or changed");
    const scan = folder => {
      for (const name of fs.readdirSync(folder)) {
        const file = path.join(folder, name), relative = path.relative(dir, file).split(path.sep).join("/");
        if (["summary.json", "artifact-manifest.json", "sources"].includes(relative)) continue;
        if (fs.lstatSync(file).isDirectory()) scan(file);
        else if (!seen.has(relative)) throw new Error(`Unmanifested evidence: ${relative}`);
      }
    };
    scan(dir);
  } catch (error) { problems.push(`Artifact integrity: ${error.message}`); }
  return problems;
}

function replayProblems(summary, slots, evaluate) {
  const problems = [];
  for (const slot of slots) {
    if (slot?.outcome !== "pass") continue; // Never upgrade a saved failure.
    const prefix = `${slot.model} × ${slot.scenario}`;
    try {
      const evaluated = evaluate(slot);
      if (evaluated?.outcome !== "pass") problems.push(`${prefix}: saved PASS rejected by raw evidence replay (${evaluated?.outcome ?? "unknown"}): ${evaluated?.reason ?? "missing evidence"}`);
      for (const label of phasesFor(summary, slot)) {
        const saved = slot.evidence?.phases?.[label], replayed = evaluated.evidence?.phases?.[label];
        if (saved?.outcome !== replayed?.outcome || !isDeepStrictEqual(saved?.sdk, replayed?.sdk)) problems.push(`${prefix} ${label}: stored phase differs from replayed SDK evidence.`);
      }
      const identity = summary.preflight?.claude;
      if (summary.preflight?.scenarios?.[slot.scenario]?.ok !== true || !identity || identity.bin !== summary.claude?.realpath || identity.sha256 !== summary.claude?.sha256 || identity.version !== summary.claude?.version || !isDeepStrictEqual(slot.evidence?.facts?.preflight, summary.preflight)) problems.push(`${prefix}: authoritative binary-bound preflight evidence missing or inconsistent.`);
    } catch (error) { problems.push(`${prefix}: raw evidence replay failed: ${error.message}`); }
  }
  return problems;
}

export function loadRun(input, { evaluate = evaluateStoredSlot } = {}) {
  if (typeof input !== "string" || !input.trim()) throw new Error("An explicit run directory is required.");
  const requested = path.resolve(input);
  if (!fs.lstatSync(requested).isDirectory()) throw new Error(`Not a regular run directory: ${requested}`);
  const dir = fs.realpathSync(requested);
  const summary = JSON.parse(fs.readFileSync(localFile(dir, "summary.json"), "utf8"));
  if (!object(summary)) throw new Error("summary.json must contain an object.");
  const slots = fs.readFileSync(localFile(dir, "slots.jsonl"), "utf8").split("\n").filter(l => l.trim()).map((line, i) => {
    try { return JSON.parse(line); } catch { throw new Error(`Invalid slots.jsonl record ${i + 1}.`); }
  });
  const integrityProblems = [...verifySavedArtifacts(dir, summary), ...replayProblems(summary, slots, evaluate)];
  return { dir, summary, slots, integrityProblems, assessment: assessRun(summary, slots, { integrityProblems }) };
}
function reportPath(dir) {
  const absolute = path.resolve(dir), relative = path.relative(ROOT, absolute);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? absolute : relative || ".";
}
function repeatCommand(summary, dryRun, markdown) {
  const flags = [], execution = summary.execution;
  for (const [flag, value] of [["--model-concurrency", execution?.modelConcurrency], ["--timeout-scale", execution?.timeouts?.scale]]) if (value != null) flags.push(flag, shellQuote(value));
  if (strings(summary.models).length) flags.push("--models", shellQuote(summary.models.join(",")));
  const scenarios = strings(list(summary.scenarios).map(s => s?.id));
  if (scenarios.length) flags.push("--scenarios", shellQuote(scenarios.join(",")));
  if (dryRun) flags.push("--dry-run");
  const env = [];
  if (summary.claude?.realpath ?? summary.claude?.bin) env.push(`CLAUDE_CODE_BIN=${shellPath(summary.claude.realpath ?? summary.claude.bin, markdown)}`);
  if (execution?.pendingToolWaitMs != null) env.push(`PENDING_TOOL_WAIT_MS=${shellQuote(execution.pendingToolWaitMs)}`);
  // Recorded bridge budgets that differ from the defaults; the runner requires /health to report the same values.
  for (const [key, value] of Object.entries(object(execution?.runtimeTimeouts) ? execution.runtimeTimeouts : {})) {
    const name = RUNTIME_ENV[key];
    if (name && value != null && value !== RUNTIME_DEFAULTS[key] && !env.some(e => e.startsWith(`${name}=`))) env.push(`${name}=${shellQuote(value)}`);
  }
  return `${env.length ? env.join(" ") + " " : ""}npm run verify${flags.length ? " -- " + flags.join(" ") : ""}`;
}

export function renderReport(run, { lang = "en", markdown = false, evaluate = evaluateStoredSlot } = {}) {
  if (!["en", "ko"].includes(lang)) throw new Error(`Unknown report language: ${lang}`);
  const ko = lang === "ko", say = (en, kr) => ko ? kr : en, { summary, slots } = run;
  const integrityProblems = run.integrityProblems ?? replayProblems(summary, slots, evaluate);
  const a = assessRun(summary, slots, { integrityProblems });
  const verdict = a.green ? a.scope.kind === "full" ? "PASS" : "FOCUSED PASS" : a.policyKind === "legacy" ? "UNVERIFIED" : "NOT PASSED";
  const out = [], line = (v = "") => out.push(v), row = (...v) => line(`| ${v.map(cell).join(" | ")} |`);
  const heading = (en, kr) => { line(); line(`${markdown ? "## " : ""}${say(en, kr)}`); line(); };
  const command = v => { if (markdown) line("```bash"); line(v); if (markdown) line("```"); };
  // Display only: never feeds a verdict. undefined = not recorded, null = recorded as absent.
  const none = say("none", "없음"), val = v => v === undefined ? "unknown" : v === null ? none : clean(v);
  const yes = v => v === true ? say("yes", "예") : v === false ? say("no", "아니오") : "unknown";
  const where = p => {
    const relative = typeof p === "string" && path.isAbsolute(p) && run.dir ? path.relative(run.dir, p) : null;
    return relative === null || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? p : relative || ".";
  };
  const effort = s => {
    const set = (v, absent) => v === undefined ? "unknown" : v === null ? absent : clean(v), observed = s?.current?.reasoningEffort;
    return `${set(s?.requestedEffort, say("not requested", "요청 없음"))} / ${set(s?.appliedEffort, say("not applied", "적용 없음"))} / ${
      s?.ok === false ? `${say("observation failed", "관측 실패")} (${clean(s.error)})` : typeof observed === "string" ? clean(observed) : s?.ok === true ? say("not reported by SDK", "SDK 미보고") : "unknown"}`;
  };
  const launch = l => l?.notStarted ? say("not started", "시작 안 됨") : [`PID ${val(l?.pid)}`, `${say("exit code", "종료 코드")} ${val(l?.exitCode)}`,
    `${say("signal", "시그널")} ${val(l?.signal)}`, `${say("forced", "강제 종료")} ${yes(l?.forced)}`, `${say("escalated to SIGKILL", "SIGKILL 승격")} ${yes(l?.escalated)}`,
    `${say("reaped", "회수")} ${yes(l?.ok)} (${say("group gone", "그룹 종료")} ${yes(l?.groupGone)}${object(l) && "helperGone" in l ? `; ${say("helper gone", "헬퍼 종료")} ${yes(l.helperGone)}` : ""}; ${
      say("remaining PIDs", "남은 PID")} ${Array.isArray(l?.remainingPids) ? l.remainingPids.map(clean).join(", ") || none : "unknown"})`,
    ...l?.reason ? [`${say("reason", "사유")} ${clean(l.reason)}`] : []].join("; ");
  const stopped = b => [`PID ${val(b?.pid)}`, `${say("group gone", "그룹 종료")} ${yes(b?.groupGone)}`, `${say("port released", "포트 해제")} ${yes(b?.portReleased)}`,
    `${say("exit code", "종료 코드")} ${val(b?.code)}`, `${say("signal", "시그널")} ${val(b?.signal)}`, ...b?.reason ? [`${say("reason", "사유")} ${clean(b.reason)}`] : []].join("; ");
  line(`${markdown ? "# " : ""}${say("Essential integration verification", "핵심 연동 검증")}`);
  if (markdown) line(ko ? "\n> [English](VERIFICATION.md) | 한국어" : "\n> English | [한국어](VERIFICATION_KO.md)");
  line(); line(`${say("result", "결과")}: ${verdict}`);
  line(`pass ${a.counts.pass} / fail ${a.counts.fail} / blocked ${a.counts.blocked} / unknown ${a.counts.unknown}`);
  line(`${say("expected", "예상")}: ${text(a.expectedTotal)} / ${say("actual", "실제")}: ${a.actualTotal} / gate: ${text(a.gate)}`);
  line(`${say("scope", "범위")}: ${a.scope.kind} (${text(a.scope.fullMatrixTotal)} ${say("full-matrix cases", "전체 매트릭스 케이스")})`);
  line(`${say("policy", "정책")}: ${text(a.policy?.id)}; suite: ${clean(summary.suiteId)}; schema: ${clean(summary.schemaVersion)}`);
  line(say("Full PASS requires all 36 canonical slots, required phase checks, replayed raw evidence, cleanup, unchanged settings/code/binary and verified source/artifact hashes. BLOCKED is not a pass.", "전체 PASS에는 정규 슬롯 36개·필수 단계 검사·원본 증거 재판정·정리·설정/코드/실행 파일 불변·소스/산출물 해시 검증이 필요합니다. BLOCKED는 통과가 아닙니다."));
  if (a.scope.kind === "focused") line(say("This focused run is not a full-matrix pass.", "이 선택 실행은 전체 매트릭스 통과가 아닙니다."));
  heading("Model × scenario results", "모델 × 시나리오 결과");
  const models = strings(summary.models), scenarioIds = strings(list(summary.scenarios).map(s => s?.id)), byKey = new Map();
  for (const slot of slots) { const key = slotKey(slot); byKey.set(key, [...(byKey.get(key) ?? []), slot]); }
  row(say("Selected model", "선택 모델"), ...scenarioIds); row("---", ...scenarioIds.map(() => "---"));
  for (const model of models) row(model, ...scenarioIds.map(scenario => {
    const found = byKey.get(slotKey({ model, scenario })) ?? [];
    return found.length > 1 ? "DUPLICATE" : found.length ? status(found[0]?.outcome) : "MISSING";
  }));
  if (!models.length || !scenarioIds.length) line(say("Expected model selection: unknown.", "예상 모델 선택: unknown."));
  heading("Failures and missing evidence", "실패와 누락 증거");
  for (const problem of a.problems) line(`- ${clean(problem)}`);
  for (const [label, entries] of [["MISSING", a.missingSlots], ["DUPLICATE", a.duplicateSlots], ["UNEXPECTED", a.unexpectedSlots], ["UNKNOWN", a.unknownOutcomes]]) for (const entry of entries) line(`- ${label}: ${clean(entry.model)} × ${clean(entry.scenario)}`);
  let failures = 0;
  for (const slot of slots) {
    const bad = list(slot?.checks).filter(c => c?.ok !== true);
    if (slot?.outcome !== "pass" || bad.length) { failures++; line(`- ${status(slot?.outcome)} ${clean(slot?.model)} × ${clean(slot?.scenario)}: ${clean(slot?.reason)}`); }
    for (const check of bad) line(`  - ${clean(check?.name)}: ${clean(check?.detail)}`);
    for (const phase of phasesFor(summary, slot)) {
      const e = slot?.evidence?.phases?.[phase];
      if (e?.reason) line(`  - ${phase}: ${clean(e.reason)}`);
      for (const c of list(e?.checks).filter(c => c?.ok !== true)) line(`    - ${clean(c?.name)}: ${clean(c?.detail)}`);
    }
  }
  if (!failures && !a.problems.length) line(say("None recorded.", "기록된 실패 없음."));
  heading("Scenario criteria", "시나리오 기준");
  line(say("Required criteria are not claims that failed or blocked cases met them.", "필수 기준이며 실패·차단된 케이스가 만족했다는 뜻이 아닙니다."));
  if (!list(summary.scenarios).length) line(say("Checklist text: unknown (not recorded).", "체크리스트 설명: unknown (기록 없음)."));
  for (const scenario of list(summary.scenarios)) {
    line(`- ${clean(scenario.id)} r${clean(scenario.revision)} — ${clean(ko ? scenario.nameKo : scenario.name)}`);
    for (const check of list(ko ? scenario.passKo : scenario.pass)) line(`  - ${clean(check)}`);
  }
  heading("Phase evidence", "단계별 증거");
  line(say("Bridge requested labels and SDK-reported IDs are separate. Only correlated SDK records count as served-model evidence; missing evidence stays unknown. Model catalogue exposure is not execution proof.", "브리지 요청 이름과 SDK 보고 ID를 구분합니다. 연결된 SDK 기록만 처리 모델 증거이며 누락은 unknown입니다. 모델 목록 노출은 실제 실행 증거가 아닙니다."));
  line(say("Effort shows requested / applied / observed for each correlated model-state record: \"not requested\" means the request carried no effort, \"not applied\" means the bridge applied none, \"not reported by SDK\" means the SDK model state omitted reasoningEffort, \"observation failed (reason)\" means the model-state read failed for the recorded reason, \"no model state\" means no record was correlated and \"unknown\" means the saved record lacks the field. No value is filled in.",
    "effort는 연결된 모델 상태 기록마다 요청 / 적용 / 관측을 표시합니다. \"요청 없음\"은 요청에 effort가 없었음을, \"적용 없음\"은 브리지가 적용하지 않았음을, \"SDK 미보고\"는 SDK 모델 상태에 reasoningEffort가 없었음을, \"관측 실패 (사유)\"는 기록된 사유로 모델 상태 조회가 실패했음을, \"모델 상태 없음\"은 연결된 기록이 없음을, \"unknown\"은 저장 기록에 해당 필드가 없음을 뜻합니다. 값을 채워 넣지 않습니다."));
  row(say("Model / case", "모델 / 케이스"), say("Phase", "단계"), say("Result", "결과"), say("Bridge requested labels", "브리지 요청 이름"), say("SDK-reported IDs", "SDK 보고 ID"), say("Effort requested / applied / observed", "effort 요청 / 적용 / 관측"));
  row("---", "---", "---", "---", "---", "---");
  for (const slot of slots) for (const phase of phasesFor(summary, slot)) {
    const e = slot?.evidence?.phases?.[phase], states = list(e?.modelStates);
    row(`${text(slot?.model)} / ${text(slot?.scenario)}`, phase, status(e?.outcome), modelList(e?.requestedModels), modelList(e?.sdk?.servedModels),
      states.length ? states.map(effort).join("; ") : say("no model state", "모델 상태 없음"));
  }
  heading("Run metadata", "실행 메타데이터");
  line(`run: ${clean(reportPath(run.dir))}`);
  line(`Claude Code: ${clean(summary.claude?.version)} (${clean(summary.claude?.realpath ?? summary.claude?.bin)}); SHA256 ${clean(summary.claude?.sha256)}; end SHA256 ${clean(summary.claude?.endSha256)}`);
  line(`Copilot SDK (@github/copilot-sdk) ${say("package version", "패키지 버전")}: ${clean(summary.copilotSdk?.version)}; ${say("npm package version recorded when the run started, not the Copilot runtime binary identity", "실행 시작 시 기록한 npm 패키지 버전이며 Copilot 런타임 실행 파일 식별 정보가 아닙니다")}`);
  line(`Node: ${clean(summary.node)}; host: ${clean(summary.host?.platform)} ${clean(summary.host?.arch)} ${clean(summary.host?.release)}`);
  line(`start: ${clean(summary.startedAt)}; end: ${clean(summary.finishedAt)}; seconds: ${clean(summary.durationSeconds)}`);
  for (const stage of ["start", "end"]) {
    const state = summary.provenance?.[stage];
    line(`code ${stage}: commit ${clean(state?.git?.commit)}; dirty: ${clean(state?.git?.dirty)}; fingerprint: ${clean(state?.fingerprint?.algorithm)} ${clean(state?.fingerprint?.scope)} ${clean(state?.fingerprint?.value)}; files: ${clean(state?.fingerprint?.files)}`);
  }
  line(`sources: ${clean(summary.provenance?.sources?.path)}; SHA256 ${clean(summary.provenance?.sources?.sha256)}`);
  line(`reference commit: ${clean(summary.reference?.commit)}`);
  for (const file of list(summary.reference?.files)) line(`reference ${clean(file.path)}: ${clean(file.sha256)}`);
  line(`user settings: ${clean(summary.userSettings?.path)}; intact: ${text(a.userSettingsIntact)}; before: ${clean(summary.userSettings?.before)}; after: ${clean(summary.userSettings?.after)}`);
  for (const [name, value] of [["--model-concurrency", summary.execution?.modelConcurrency], ["--timeout-scale", summary.execution?.timeouts?.scale], ["PENDING_TOOL_WAIT_MS", summary.execution?.pendingToolWaitMs], ["bridgeHealthMs", summary.execution?.timeouts?.bridgeHealthMs], ["cleanupMs", summary.execution?.timeouts?.cleanupMs]]) line(`${name}: ${clean(value)}`);
  for (const id of scenarioIds) line(`scenarioMs.${id}: ${clean(summary.execution?.timeouts?.scenarioMs?.[id])}`);
  const runtime = summary.execution?.runtimeTimeouts;
  for (const [key, value] of Object.entries(runtime ?? {})) line(`runtime.${key}: ${clean(value)}`);
  line(say("Per slot: each CLI launch's exit code, signal, forced stop and SIGKILL escalation, then whether its owned processes were reaped; each owned bridge's stop receipt and a /health summary. The full /health record stays in slots.jsonl.", "슬롯마다 CLI 실행별 종료 코드·시그널·강제 종료·SIGKILL 승격과 소유 프로세스 회수 여부, 소유 브리지별 정지 기록과 /health 요약을 표시합니다. 전체 /health 기록은 slots.jsonl에 있습니다."));
  for (const slot of slots) {
    line(`${clean(slot?.model)} ${clean(slot?.scenario)}: seconds ${Number.isFinite(slot?.durationMs) ? (slot.durationMs / 1000).toFixed(1) : "unknown"}`);
    const receipts = slot?.cleanup?.bridges, noBridge = Array.isArray(receipts) && !receipts.length && !list(slot?.bridges).length;
    const launches = slot?.evidence?.facts?.launches ?? (list(slot?.evidence?.cleanup?.launches).length ? slot.evidence.cleanup.launches : undefined);
    if (list(launches).length) launches.forEach((l, i) => line(`  CLI ${i + 1}: ${launch(l)}`));
    else line(`  ${Array.isArray(launches) || noBridge ? say("CLI not started", "CLI 시작 안 됨") : say("CLI launch receipts not recorded", "CLI 실행 기록 없음")}`);
    list(slot?.bridges).forEach((b, i) => {
      const h = b?.health, match = object(h?.timeouts) && object(runtime) && Object.keys(runtime).length ? Object.entries(runtime).every(([key, ms]) => h.timeouts[key] === ms) : undefined;
      line(`  ${say("bridge", "브리지")} ${i + 1} /health: ok ${yes(h?.ok)}; ${h?.version != null ? `version ${clean(h.version)}; ` : ""}${h?.instanceId != null ? `instance ${clean(h.instanceId)}; ` : ""}${say("models", "모델 수")} ${val(h?.modelCount)}; ${
        say("timeouts match recorded runtime", "타임아웃이 기록된 런타임 값과 일치")} ${yes(match)}; PID ${val(b?.pid)}; port ${val(b?.port)}; ${say("full record", "전체 기록")} slots.jsonl bridges[${i}].health; ${say("log", "로그")} ${clean(where(b?.logPath))}`);
    });
    if (list(receipts).length) receipts.forEach((b, i) => line(`  ${say("bridge stop", "브리지 정지")} ${i + 1}: ${stopped(b)}`));
    else line(`  ${Array.isArray(receipts) ? say("bridge not started", "브리지 시작 안 됨") : say("bridge stop receipts not recorded", "브리지 정지 기록 없음")}`);
  }
  line(say("Slot budgets are total deadlines, not renewed for each phase. Runtime budgets are recorded without scaling. No metadata is filled from current dependencies, environment or installed binary.", "슬롯 예산은 단계마다 갱신하지 않는 전체 deadline입니다. 런타임 예산은 배율 변경 없이 기록합니다. 현재 의존성·환경·설치 실행 파일에서 메타데이터를 채우지 않습니다."));
  heading("Evidence and reproduction", "증거와 재현");
  line(say("Run from the repository root. Reading this explicit saved run makes no model calls. The reporter re-evaluates each saved PASS slot's stored raw evidence with the current checkout's evaluator and never upgrades a saved failure. Frozen source copies (sources/files/) are reproduction material: the reporter checks their hashes and never executes them.", "저장소 루트에서 실행하세요. 명시한 저장 실행을 읽을 때 모델을 호출하지 않습니다. 리포터는 저장된 PASS 슬롯의 원본 증거를 현재 체크아웃의 평가기로 재판정하며 저장된 실패를 올리지 않습니다. 동결된 소스 사본(sources/files/)은 재현 자료이며 리포터는 해시만 검사하고 실행하지 않습니다."));
  command(`node scripts/verify/report.mjs ${shellPath(reportPath(run.dir), markdown)}`); command(`npm run verify:doc -- ${shellPath(reportPath(run.dir), markdown)}`);
  line(say("Source copies exclude credentials/config and old run evidence. Private settings contain ephemeral bridge keys; raw transcripts may be sensitive. Inspect before sharing raw artifacts.", "소스 사본에 자격 증명·설정·이전 실행 증거를 넣지 않습니다. private 설정에는 임시 브리지 키가 있고 원본 transcript에는 민감한 정보가 있을 수 있습니다. 공유 전 검토하세요."));
  line(say(`Paths inside the run directory are shown relative to it.${markdown ? " In this document ~ and $HOME are the home directory, $TMPDIR is the per-user temporary directory, and -HOME / -TMPDIR stand for them inside Claude project-directory names." : ""}`,
    `실행 디렉터리 안의 경로는 그 디렉터리 기준 상대 경로로 표시합니다.${markdown ? " 이 문서에서 ~와 $HOME은 홈 디렉터리, $TMPDIR은 사용자별 임시 디렉터리이며 Claude 프로젝트 디렉터리 이름 안의 -HOME / -TMPDIR은 각각 이를 뜻합니다." : ""}`));
  for (const slot of slots) for (const phase of phasesFor(summary, slot)) {
    const e = slot?.evidence?.phases?.[phase], range = e?.sdk?.logRange;
    line(`- ${clean(slot?.model)} ${clean(slot?.scenario)} ${phase}: transcript ${clean(where(e?.transcriptPath))}; response IDs ${modelList(e?.sdk?.responseIds)}; log range ${
      object(range) ? `${clean(where(range.path))} bytes ${clean(range.start)}-${clean(range.end)}` : clean(range)}`);
  }
  line(); line(say("Preview only: no binary/authentication/connectivity checks or SDK metadata lookup.", "미리보기: 실행 파일·인증·연결 검사와 SDK 메타데이터 조회 없음.")); command(repeatCommand(summary, true, markdown));
  line(say("Optional new live run: consumes real Copilot usage. Restore the frozen working-tree source copies and recorded dependencies/binary first; a dirty commit alone cannot reconstruct the code that ran. The command repeats recorded runtime budgets that differ from the defaults. This command creates a new run, never rewrites this evidence.", "선택 사항인 새 실제 실행: 실제 Copilot 사용량을 소비합니다. 동결된 작업 트리 소스와 기록된 의존성/실행 파일을 먼저 맞추세요. dirty 커밋만으로 실행한 코드를 복원할 수 없습니다. 명령은 기본값과 다른 기록된 런타임 예산을 그대로 지정합니다. 이 명령은 새 실행을 만들며 저장 증거를 덮어쓰지 않습니다.")); command(repeatCommand(summary, false, markdown));
  heading("Limits", "한계");
  line(say("The six cases cover private CLI launch, Unicode/clear, coding tools, declared MCP recovery, model/effort switch, active interruption and explicit compaction/cold resume only when their gates pass. They do not prove maximum context length, automatic compaction limits, every instant of process isolation, provider internals, arbitrary plugins/hooks/subagents, permissions UI, media, production launcher/shared daemon or LiteLLM. Offline production tests are separate. Results apply to the recorded code, binary, host, models and configuration only.", "여섯 케이스는 gate 통과 시 private CLI 실행·Unicode/clear·코딩 도구·선언된 MCP 복구·모델/effort 전환·활성 응답 중단·명시적 압축/콜드 재개를 다룹니다. 최대 context·자동 압축 한계·모든 순간의 프로세스 격리·제공자 내부·임의 플러그인/훅/서브에이전트·권한 UI·미디어·production 런처/공유 데몬·LiteLLM을 증명하지 않습니다. production 오프라인 테스트는 별도이며 결과는 기록된 코드·실행 파일·호스트·모델·설정에만 해당합니다."));
  const output = out.join("\n").replace(/[ \t]+$/gm, "").trimEnd() + "\n";
  return markdown ? redactPaths(output) : output;
}

/** Render both languages before either replacement, refusing symlink destinations. */
export function writeDocs(input, { docsDir = path.join(ROOT, "docs"), render = renderReport, evaluate = evaluateStoredSlot } = {}) {
  const run = loadRun(input, { evaluate });
  if (!fs.lstatSync(docsDir).isDirectory() || fs.realpathSync(docsDir) !== path.resolve(docsDir)) throw new Error(`Not a regular document directory: ${docsDir}`);
  const documents = ["en", "ko"].map(lang => ({ target: path.join(docsDir, lang === "en" ? "VERIFICATION.md" : "VERIFICATION_KO.md"), content: render(run, { lang, markdown: true }) }));
  for (const doc of documents) {
    if (typeof doc.content !== "string" || !doc.content.trim()) throw new Error("Both rendered documents must be nonempty.");
    try { if (!fs.lstatSync(doc.target).isFile()) throw new Error(`Not a regular document: ${doc.target}`); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const staged = documents.map(doc => ({ ...doc, temp: `${doc.target}.${randomUUID()}.tmp` }));
  try {
    for (const doc of staged) fs.writeFileSync(doc.temp, doc.content, { flag: "wx", mode: 0o644 });
    for (const doc of staged) fs.renameSync(doc.temp, doc.target);
  } finally { for (const doc of staged) fs.rmSync(doc.temp, { force: true }); }
  return documents.map(doc => doc.target);
}
export function parseReportArgs(argv) {
  let dir, markdown = false, lang = "en", write = false;
  for (const arg of argv) {
    if (arg === "--write-docs") write = true;
    else if (["--markdown", "--markdown=en", "--markdown=ko"].includes(arg)) { markdown = true; lang = arg.endsWith("=ko") ? "ko" : "en"; }
    else if (arg.startsWith("--")) throw new Error(`Unknown argument: ${arg}`);
    else if (dir !== undefined) throw new Error("Provide exactly one run directory.");
    else dir = arg;
  }
  if (!dir?.trim()) throw new Error("An explicit run directory is required: node scripts/verify/report.mjs <run-dir> [--markdown[=ko] | --write-docs]");
  if (write && markdown) throw new Error("--write-docs cannot be combined with --markdown.");
  return { dir, markdown, lang, write };
}
if (isEntryPoint(import.meta.url)) {
  try { const options = parseReportArgs(process.argv.slice(2)); if (options.write) console.log(writeDocs(options.dir).join("\n")); else process.stdout.write(renderReport(loadRun(options.dir), options)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
