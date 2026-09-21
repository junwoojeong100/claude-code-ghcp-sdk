/** Verification-only waits. Scaling never changes the shipped runtime defaults. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

export const DEFAULT_TIMEOUTS = Object.freeze({
  bridgeHealthMs: 120_000,
  planTurnMs: 90_000,
  backgroundLaunchMs: 120_000,
  foregroundLaunchMs: 180_000,
  persistentLaunchMs: 120_000,
  detachedOutputMs: 240_000,
});

export function parseTimeoutScale(raw) {
  const value = typeof raw === "string" && raw.trim() ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("--timeout-scale must be a positive finite number.");
  }
  return value;
}

export function scaleTimeoutMs(baseMs, scale = 1) {
  const value = parseTimeoutScale(scale);
  const ms = Math.ceil(baseMs * value);
  if (!Number.isFinite(baseMs) || baseMs <= 0 || !Number.isSafeInteger(ms) || ms < 1 || ms > MAX_TIMEOUT_MS) {
    throw new Error(`--timeout-scale produces a delay outside 1–${MAX_TIMEOUT_MS}ms.`);
  }
  return ms;
}

export function createTimeoutPolicy(scenarios, scale = 1) {
  const value = parseTimeoutScale(scale);
  return Object.freeze({
    scale: value,
    ...Object.fromEntries(
      Object.entries(DEFAULT_TIMEOUTS).map(([key, ms]) => [key, scaleTimeoutMs(ms, value)]),
    ),
    // v01–v10 use these per invocation. v11's catalogue budget is planning
    // only; its launcher and detached-output waits above are the actual caps.
    scenarioMs: Object.freeze(Object.fromEntries(
      scenarios.map((s) => [s.id, scaleTimeoutMs(s.budgetSeconds * 1000, value)]),
    )),
  });
}

/** Mirror the server's existing env override without writing to the environment. */
export function readPendingToolWaitMs(env) {
  const raw = env.PENDING_TOOL_WAIT_MS;
  if (raw === undefined || raw === "") return 10_000;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new Error(`PENDING_TOOL_WAIT_MS must be an integer in 1–${MAX_TIMEOUT_MS}ms.`);
  }
  return value;
}
