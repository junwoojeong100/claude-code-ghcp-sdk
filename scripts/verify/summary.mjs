/** Lightweight, pure run policy. Safe to import before a side-effect-free preview. */
import { OUTCOMES, PRIMARY_MODELS, SCENARIOS, SCENARIO_IDS, SCHEMA_VERSION, SUITE_ID, gateFor } from "./scenarios.mjs";

export const STRICT_POLICY = Object.freeze({ id: "strict-all-pass-v2", requiredPassRate: 1 });
export const FINGERPRINT_SCOPE = "verification-code-v2";
const positive = value => Number.isSafeInteger(value) && value > 0;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const ids = values => Array.isArray(values) ? values.map(v => typeof v === "string" ? v : v?.id) : [];
const idList = values => Array.isArray(values) && values.length > 0 && values.every(v => typeof v === "string" && v.trim() === v && v.length) && new Set(values).size === values.length;
const sameSet = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every(v => b.includes(v));
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const slotKey = slot => JSON.stringify([slot?.model, slot?.scenario]);

export function createRunDefinition(models, scenarios) {
  const selected = ids(scenarios);
  for (const [name, values, known] of [["models", models, PRIMARY_MODELS], ["scenarios", selected, SCENARIO_IDS]]) {
    if (!idList(values)) throw new Error(`--${name} must contain nonempty, unique values.`);
    const unknown = values.find(v => !known.includes(v));
    if (unknown) throw new Error(`Unknown ${name === "models" ? "model" : "scenario"}: ${unknown}`);
  }
  const expectedSlots = models.flatMap(model => selected.map(scenario => ({ model, scenario })));
  return {
    suiteId: SUITE_ID, schemaVersion: SCHEMA_VERSION, policy: { ...STRICT_POLICY }, models: [...models],
    scenarios: selected.map(id => structuredClone(SCENARIOS.find(s => s.id === id))),
    scope: { kind: sameSet(models, PRIMARY_MODELS) && sameSet(selected, SCENARIO_IDS) ? "full" : "focused",
      fullMatrixTotal: PRIMARY_MODELS.length * SCENARIO_IDS.length, catalogModels: [...PRIMARY_MODELS], catalogScenarios: [...SCENARIO_IDS] },
    expectedSlots, expectedTotal: expectedSlots.length,
  };
}

const checksPass = checks => Array.isArray(checks) && checks.length > 0 && checks.every(c =>
  typeof c?.name === "string" && c.name.length > 0 && c.ok === true && c.outcome === "pass");

/** Structure is necessary but not sufficient: loadRun also replays the raw evaluator. */
export function slotEvidenceProblems(slot, scenario) {
  const problems = [], evidence = slot?.evidence;
  if (!scenario) return ["unknown scenario contract"];
  const phases = evidence?.phases;
  if (!object(phases) || !sameSet(Object.keys(phases), scenario.phases.map(p => p.id))) problems.push("required phase set is missing or unexpected");
  for (const phase of scenario.phases) {
    const saved = phases?.[phase.id];
    if (!saved || !Object.hasOwn(OUTCOMES, saved.outcome ?? "")) problems.push(`${phase.id}: no terminal outcome`);
    if (!Array.isArray(saved?.checks) || !saved.checks.length) problems.push(`${phase.id}: checks missing`);
    if (slot.outcome !== "pass") continue;
    if (saved?.outcome !== "pass" || !checksPass(saved.checks)) problems.push(`${phase.id}: required checks did not pass`);
    if (!object(saved?.raw) || !object(evidence?.facts)) problems.push(`${phase.id}: raw evidence missing`);
    if (typeof saved?.transcriptPath !== "string" || !saved.transcriptPath) problems.push(`${phase.id}: transcript reference missing`);
    if (!idList(saved?.sdk?.responseIds) || !Array.isArray(saved?.sdk?.records) || !saved.sdk.records.length) problems.push(`${phase.id}: correlated SDK records missing`);
    if (!phase.interrupted && !idList(saved?.sdk?.servedModels)) problems.push(`${phase.id}: SDK-reported models missing`);
  }
  if (slot.outcome === "pass") {
    if (!checksPass(slot.checks)) problems.push("slot checks missing or not passing");
    if (evidence?.cleanup?.ok !== true || !evidence.cleanup.launches?.length || evidence.cleanup.launches.some(l => l?.ok !== true)) problems.push("CLI cleanup missing or failed");
    if (evidence?.isolation?.ok !== true) problems.push("isolation missing or failed");
    if (evidence?.settings?.ok !== true || !evidence.settings.files?.length || evidence.settings.files.some(f => !sha(f.before) || f.before !== f.after)) problems.push("launch settings integrity missing or changed");
    if (slot.cleanup?.ok !== true || !slot.cleanup.bridges?.length || slot.cleanup.bridges.some(b => b?.ok !== true)) problems.push("owned bridge cleanup missing or failed");
    if (slot.safetyBreach || evidence?.safetyBreach) problems.push("safety breach");
  }
  return problems;
}

function validCodeState(state) {
  return /^[a-f0-9]{40,64}$/.test(state?.git?.commit ?? "") && typeof state?.git?.dirty === "boolean" &&
    state?.fingerprint?.algorithm === "sha256" && state.fingerprint.scope === FINGERPRINT_SCOPE &&
    sha(state.fingerprint.value) && positive(state.fingerprint.files);
}

/** Assess the fixed v2 contract, not a saved green flag or a user-shrunken catalogue. */
export function assessRun(summary = {}, slots = [], { integrityProblems = [] } = {}) {
  if (!object(summary)) summary = {};
  const rows = Array.isArray(slots) ? slots : [];
  const counts = { pass: 0, fail: 0, blocked: 0, unknown: 0 }, unknownOutcomes = [];
  for (const [index, slot] of rows.entries()) {
    if (Object.hasOwn(OUTCOMES, slot?.outcome ?? "")) counts[slot.outcome]++;
    else { counts.unknown++; unknownOutcomes.push({ index, model: slot?.model, scenario: slot?.scenario, outcome: slot?.outcome }); }
  }
  const models = summary.models, selected = ids(summary.scenarios);
  const axesValid = idList(models) && idList(selected);
  const expected = axesValid ? models.flatMap(model => selected.map(scenario => ({ model, scenario }))) : [];
  const expectedTotal = axesValid ? expected.length : positive(summary.expectedTotal) ? summary.expectedTotal : null;
  const base = { counts, actualTotal: rows.length, expectedTotal, unknownOutcomes, storedGreen: typeof summary.green === "boolean" ? summary.green : null };
  if (!summary.policy && summary.schemaVersion === undefined) return { ...base, policyKind: "legacy", policy: null,
    gate: Number.isSafeInteger(summary.gate) ? summary.gate : null, scope: { kind: "unknown", fullMatrixTotal: null },
    green: false, complete: false, userSettingsIntact: null, codeUnchanged: null,
    missingSlots: [], duplicateSlots: [], unexpectedSlots: [], problems: ["Legacy stored policy; no v2 evidence verification."] };
  const problems = [...integrityProblems];
  const strict = summary.policy?.id === STRICT_POLICY.id && summary.policy.requiredPassRate === 1;
  if (!strict) problems.push("Unknown or invalid verification policy.");
  if (summary.suiteId !== SUITE_ID || summary.schemaVersion !== SCHEMA_VERSION) problems.push("Unknown suite or schema version.");
  if (!axesValid || models.some(m => !PRIMARY_MODELS.includes(m)) || selected.some(id => !SCENARIO_IDS.includes(id))) problems.push("Selected models/scenarios must be known, nonempty and unique.");
  if (summary.expectedTotal !== expected.length || !positive(summary.expectedTotal)) problems.push("Recorded expectedTotal does not match the selected matrix.");
  const expectedByKey = new Map(expected.map(s => [slotKey(s), s]));
  if (!Array.isArray(summary.expectedSlots) || summary.expectedSlots.length !== expected.length ||
      summary.expectedSlots.some(s => !expectedByKey.has(slotKey(s))) || new Set(summary.expectedSlots.map(slotKey)).size !== expected.length) problems.push("Recorded expectedSlots is not the exact unique selected matrix.");
  for (const saved of Array.isArray(summary.scenarios) ? summary.scenarios : []) {
    const canonical = SCENARIOS.find(s => s.id === saved?.id);
    if (!canonical || saved.revision !== canonical.revision || JSON.stringify(saved.phases) !== JSON.stringify(canonical.phases) || saved.budgetSeconds !== canonical.budgetSeconds) problems.push(`Scenario ${saved?.id ?? "unknown"} contract differs from suite revision.`);
  }
  const scope = summary.scope;
  const kind = axesValid && sameSet(models, PRIMARY_MODELS) && sameSet(selected, SCENARIO_IDS) ? "full" : "focused";
  const scopeValid = sameSet(scope?.catalogModels, PRIMARY_MODELS) && sameSet(scope?.catalogScenarios, SCENARIO_IDS) &&
    scope?.fullMatrixTotal === 36 && scope?.kind === kind;
  if (!scopeValid) problems.push("Full/focused scope is inconsistent with the canonical 6×6 catalogue.");
  const definitionValid = problems.length === 0;
  const seen = new Set(), duplicateSlots = [], unexpectedSlots = [];
  for (const [index, slot] of rows.entries()) {
    const key = slotKey(slot), entry = { index, model: slot?.model, scenario: slot?.scenario };
    if (!expectedByKey.has(key)) unexpectedSlots.push(entry);
    if (seen.has(key)) duplicateSlots.push(entry);
    seen.add(key);
    for (const issue of slotEvidenceProblems(slot, SCENARIOS.find(s => s.id === slot?.scenario))) problems.push(`${slot?.model} × ${slot?.scenario}: ${issue}.`);
  }
  const missingSlots = expected.filter(s => !seen.has(slotKey(s)));
  for (const [label, entries] of [["Missing expected slots", missingSlots], ["Duplicate slots", duplicateSlots], ["Unexpected or malformed slots", unexpectedSlots], ["Unknown outcomes", unknownOutcomes]]) if (entries.length) problems.push(`${label}: ${entries.length}.`);
  if (summary.actualTotal !== rows.length) problems.push("Recorded actualTotal does not match slots.jsonl.");
  if (!rows.length || rows.length !== expectedTotal) problems.push(`Actual total ${rows.length} differs from expected ${expectedTotal ?? "unknown"}.`);
  const settings = summary.userSettings;
  const userSettingsIntact = settings?.intact === true && typeof settings.before === "string" && settings.before.length > 0 && settings.before === settings.after;
  if (!userSettingsIntact) problems.push("User settings changed or their before/after state was not recorded.");
  const { start, end } = summary.provenance ?? {};
  const codeUnchanged = validCodeState(start) && validCodeState(end) && start.git.commit === end.git.commit && start.fingerprint.value === end.fingerprint.value && start.fingerprint.files === end.fingerprint.files;
  if (!codeUnchanged) problems.push("Code/commit changed or complete start/end provenance was not recorded.");
  if (summary.mode !== "live" || !Number.isFinite(Date.parse(summary.startedAt)) || !Number.isFinite(Date.parse(summary.finishedAt)) || Date.parse(summary.finishedAt) < Date.parse(summary.startedAt)) problems.push("A finished live run is required.");
  if (!sha(summary.claude?.sha256) || summary.claude.sha256 !== summary.claude.endSha256 || typeof summary.claude.realpath !== "string" || !summary.claude.realpath || summary.claude.version == null) problems.push("Pinned CLI binary provenance missing or changed.");
  if (!sha(summary.provenance?.sources?.sha256) || !summary.provenance.sources.path || !sha(summary.artifacts?.slots?.sha256) || !sha(summary.artifacts?.manifest?.sha256)) problems.push("Frozen sources/artifact manifest provenance missing.");
  if (summary.cleanup?.ok !== true || summary.safetyStop) problems.push("Run cleanup failed or isolation safety stop occurred.");
  if (counts.pass !== expectedTotal || counts.fail || counts.blocked || counts.unknown) problems.push("Every expected slot must pass; fail, blocked and unknown outcomes are not passes.");
  const complete = definitionValid && rows.length === expectedTotal && !missingSlots.length && !duplicateSlots.length && !unexpectedSlots.length;
  return { ...base, policyKind: strict ? "strict" : "unknown", policy: summary.policy,
    gate: expectedTotal === null ? null : gateFor(expectedTotal), scope: scopeValid ? { ...scope } : { kind: "unknown", fullMatrixTotal: 36 },
    green: problems.length === 0, complete, userSettingsIntact, codeUnchanged, missingSlots, duplicateSlots, unexpectedSlots, problems };
}
