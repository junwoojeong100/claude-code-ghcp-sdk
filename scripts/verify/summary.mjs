/** Pure, shared run policy. Completed rows never define the expected matrix. */
import { OUTCOMES, PRIMARY_MODELS, SCENARIO_IDS, gateFor } from "./scenarios.mjs";

export const STRICT_POLICY = Object.freeze({ id: "strict-all-pass-v1", requiredPassRate: 1 });
export const FINGERPRINT_SCOPE = "verification-code-v1";

const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const idList = (values) => Array.isArray(values) && values.length > 0 &&
  values.every((value) => typeof value === "string" && value.trim() === value && value.length > 0) &&
  new Set(values).size === values.length;
const scenarioIds = (scenarios) => Array.isArray(scenarios)
  ? scenarios.map((scenario) => typeof scenario === "string" ? scenario : scenario?.id)
  : null;
const sameSet = (a, b) => a.length === b.length && a.every((value) => b.includes(value));
export const slotKey = (slot) => JSON.stringify([slot?.model, slot?.scenario]);
const validSlot = (slot) => typeof slot?.model === "string" && typeof slot?.scenario === "string";

/** Freeze the selected Cartesian product before starting any workers. */
export function createRunDefinition(models, scenarios) {
  const ids = scenarioIds(scenarios);
  for (const [name, values, known] of [
    ["models", models, PRIMARY_MODELS], ["scenarios", ids, SCENARIO_IDS],
  ]) {
    if (!idList(values)) throw new Error(`--${name} must contain nonempty, unique values.`);
    const unknown = values.find((value) => !known.includes(value));
    if (unknown) throw new Error(`Unknown ${name === "models" ? "model" : "scenario"}: ${unknown}`);
  }
  const expectedSlots = models.flatMap((model) => ids.map((scenario) => ({ model, scenario })));
  return {
    policy: { ...STRICT_POLICY },
    models: [...models],
    scenarios: ids.map((id) => ({ id })),
    scope: {
      kind: sameSet(models, PRIMARY_MODELS) && sameSet(ids, SCENARIO_IDS) ? "full" : "focused",
      fullMatrixTotal: PRIMARY_MODELS.length * SCENARIO_IDS.length,
      catalogModels: [...PRIMARY_MODELS],
      catalogScenarios: [...SCENARIO_IDS],
    },
    expectedSlots,
    expectedTotal: expectedSlots.length,
  };
}

function validCodeState(state) {
  const fingerprint = state?.fingerprint;
  return typeof state?.git?.commit === "string" && /^[a-f0-9]{40,64}$/.test(state.git.commit) &&
    typeof state.git.dirty === "boolean" && fingerprint?.algorithm === "sha256" &&
    fingerprint.scope === FINGERPRINT_SCOPE && /^[a-f0-9]{64}$/.test(fingerprint.value ?? "") &&
    positiveInteger(fingerprint.files);
}

/**
 * Grade strict records from their saved definition and evidence, not saved green
 * or today's catalogue. Legacy gate/green are reported as stored, never upgraded.
 * Returns diagnostics without mutating either argument.
 */
export function assessRun(summary = {}, slots = []) {
  const rows = Array.isArray(slots) ? slots : [];
  const counts = { pass: 0, fail: 0, blocked: 0, unknown: 0 };
  const unknownOutcomes = [];
  for (const [index, slot] of rows.entries()) {
    if (typeof slot?.outcome === "string" && Object.hasOwn(OUTCOMES, slot.outcome)) counts[slot.outcome] += 1;
    else {
      counts.unknown += 1;
      unknownOutcomes.push({ index, model: slot?.model ?? null, scenario: slot?.scenario ?? null, outcome: slot?.outcome ?? null });
    }
  }

  const models = summary.models;
  const ids = scenarioIds(summary.scenarios);
  const axesValid = idList(models) && idList(ids);
  const expected = axesValid ? models.flatMap((model) => ids.map((scenario) => ({ model, scenario }))) : [];
  const expectedTotal = axesValid ? expected.length : (positiveInteger(summary.expectedTotal) ? summary.expectedTotal : null);
  const base = {
    counts, actualTotal: rows.length, expectedTotal, unknownOutcomes,
    storedGreen: typeof summary.green === "boolean" ? summary.green : null,
  };
  if (!summary.policy) {
    return {
      ...base, policyKind: "legacy", policy: null,
      gate: Number.isSafeInteger(summary.gate) && summary.gate >= 0 ? summary.gate : null,
      scope: { kind: "unknown", fullMatrixTotal: null },
      green: false, complete: false, userSettingsIntact: null, codeUnchanged: null,
      missingSlots: [], duplicateSlots: [], unexpectedSlots: [],
      problems: ["Legacy stored policy; strict completeness and provenance were not recorded."],
    };
  }

  const problems = [];
  const strict = summary.policy.id === STRICT_POLICY.id && summary.policy.requiredPassRate === 1;
  if (!strict) problems.push("Unknown or invalid verification policy.");
  if (!axesValid) problems.push("Selected models/scenarios must be recorded, nonempty and unique.");
  if (!positiveInteger(summary.expectedTotal) || summary.expectedTotal !== expected.length) {
    problems.push("Recorded expectedTotal does not match the selected matrix.");
  }
  const expectedByKey = new Map(expected.map((slot) => [slotKey(slot), slot]));
  const savedExpected = summary.expectedSlots;
  if (!Array.isArray(savedExpected) || !savedExpected.length || savedExpected.length !== expected.length ||
      savedExpected.some((slot) => !validSlot(slot) || !expectedByKey.has(slotKey(slot))) ||
      new Set(savedExpected.map(slotKey)).size !== expected.length) {
    problems.push("Recorded expectedSlots is not the exact unique selected matrix.");
  }

  // Keep the run's catalogue so a later catalogue edit cannot relabel its scope.
  const scope = summary.scope;
  const catalogValid = idList(scope?.catalogModels) && idList(scope?.catalogScenarios);
  const fullMatrixTotal = catalogValid ? scope.catalogModels.length * scope.catalogScenarios.length : null;
  const computedKind = axesValid && catalogValid &&
    sameSet(models, scope.catalogModels) && sameSet(ids, scope.catalogScenarios) ? "full" : "focused";
  const scopeValid = axesValid && catalogValid && scope.fullMatrixTotal === fullMatrixTotal &&
    models.every((model) => scope.catalogModels.includes(model)) &&
    ids.every((id) => scope.catalogScenarios.includes(id)) && scope.kind === computedKind;
  if (!scopeValid) problems.push("Full/focused scope is missing or inconsistent with the recorded catalogue.");
  const definitionValid = problems.length === 0;

  const seen = new Map();
  const duplicateSlots = [];
  const unexpectedSlots = [];
  for (const [index, slot] of rows.entries()) {
    const key = slotKey(slot);
    if (!validSlot(slot) || !expectedByKey.has(key)) {
      unexpectedSlots.push({ index, model: slot?.model ?? null, scenario: slot?.scenario ?? null });
    }
    if (seen.has(key)) duplicateSlots.push({ index, model: slot?.model ?? null, scenario: slot?.scenario ?? null });
    seen.set(key, true);
  }
  const missingSlots = expected.filter((slot) => !seen.has(slotKey(slot)));
  if (missingSlots.length) problems.push(`Missing expected slots: ${missingSlots.length}.`);
  if (duplicateSlots.length) problems.push(`Duplicate slots: ${duplicateSlots.length}.`);
  if (unexpectedSlots.length) problems.push(`Unexpected or malformed slots: ${unexpectedSlots.length}.`);
  if (unknownOutcomes.length) problems.push(`Unknown outcomes: ${unknownOutcomes.length}.`);
  if (!Array.isArray(slots) || !rows.length) problems.push("No completed slots were recorded.");
  if (summary.actualTotal !== rows.length) problems.push("Recorded actualTotal does not match slots.jsonl.");
  if (rows.length !== expectedTotal) problems.push(`Actual total ${rows.length} differs from expected ${expectedTotal ?? "unknown"}.`);

  const settings = summary.userSettings;
  const userSettingsIntact = settings?.intact === true && typeof settings.before === "string" &&
    settings.before.length > 0 && settings.before === settings.after;
  if (!userSettingsIntact) problems.push("User settings changed or their before/after state was not recorded.");
  const { start, end } = summary.provenance ?? {};
  const codeUnchanged = validCodeState(start) && validCodeState(end) &&
    start.git.commit === end.git.commit && start.fingerprint.value === end.fingerprint.value &&
    start.fingerprint.files === end.fingerprint.files;
  if (!codeUnchanged) problems.push("Code/commit changed or complete start/end provenance was not recorded.");
  if (counts.pass !== expectedTotal || counts.fail || counts.blocked || counts.unknown) {
    problems.push("Every expected slot must pass; fail, blocked and unknown outcomes are not passes.");
  }
  const complete = definitionValid && rows.length === expectedTotal &&
    !missingSlots.length && !duplicateSlots.length && !unexpectedSlots.length;
  return {
    ...base, policyKind: strict ? "strict" : "unknown", policy: summary.policy,
    gate: expectedTotal === null ? null : gateFor(expectedTotal),
    scope: scopeValid ? { ...scope } : { kind: "unknown", fullMatrixTotal },
    green: problems.length === 0, complete, userSettingsIntact, codeUnchanged,
    missingSlots, duplicateSlots, unexpectedSlots, problems,
  };
}
