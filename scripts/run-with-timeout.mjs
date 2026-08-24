import { spawn } from "node:child_process";

const [secondsValue, command, ...args] = process.argv.slice(2);
const seconds = Number(secondsValue);
if (!Number.isFinite(seconds) || seconds <= 0 || !command) {
  console.error("Usage: run-with-timeout.mjs <seconds> <command> [args...]");
  process.exit(2);
}

const child = spawn(command, args, {
  detached: process.platform !== "win32",
  stdio: "inherit",
});
let timedOut = false;
let forceTimer;
const kill = (signal) => {
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
  } catch {}
};
const timer = setTimeout(() => {
  timedOut = true;
  console.error(`Command timed out after ${seconds} seconds.`);
  kill("SIGTERM");
  forceTimer = setTimeout(() => {
    kill("SIGKILL");
    process.exit(124);
  }, 2_000);
}, seconds * 1_000);

child.on("error", (error) => {
  clearTimeout(timer);
  console.error(error.message);
  process.exit(1);
});
child.on("close", (code, signal) => {
  clearTimeout(timer);
  if (timedOut) {
    if (!forceTimer) {
      console.error(`Command timed out after ${seconds} seconds.`);
      process.exit(124);
    }
    return;
  }
  if (signal) {
    console.error(`Command terminated by ${signal}.`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
