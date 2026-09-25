/** Verification-only waits. Scaling never changes the shipped runtime defaults. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

export const DEFAULT_TIMEOUTS = Object.freeze({
  bridgeHealthMs: 120_000,
  cleanupMs: 10_000,
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
    interrupt: Object.freeze(Object.fromEntries(
      Object.entries({ progressMs: 90_000, settleMs: 15_000, recoveryMs: 60_000 })
        .map(([key, ms]) => [key, scaleTimeoutMs(ms, value)]),
    )),
    // One total ceiling per slot, including every phase and bridge startup.
    scenarioMs: Object.freeze(Object.fromEntries(
      scenarios.map((s) => [s.id, scaleTimeoutMs(s.budgetSeconds * 1000, value)]),
    )),
  });
}

/** Runtime budgets are recorded, not scaled or changed by the verifier. */
export function runtimeTimeouts(env = process.env) {
  const read = (name, fallback) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) throw new Error(`${name} must be an integer in 1–${MAX_TIMEOUT_MS}ms.`);
    return value;
  };
  return {
    turnTimeoutMs: read("TURN_IDLE_TIMEOUT_MS", 300_000),
    maxTurnDurationMs: read("TURN_MAX_DURATION_MS", 1_800_000),
    sessionOperationTimeoutMs: read("SESSION_OPERATION_TIMEOUT_MS", 60_000),
    pendingToolWaitMs: readPendingToolWaitMs(env), abortTimeoutMs: 5_000,
    cleanupTimeoutMs: read("CLEANUP_TIMEOUT_MS", 5_000),
    stateIdleTtlMs: read("STATE_IDLE_TTL_MS", 1_800_000), mcpDiscoveryTimeoutMs: 10_000,
  };
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
