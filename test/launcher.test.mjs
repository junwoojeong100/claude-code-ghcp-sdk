import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  daemonConfigFingerprint,
  daemonPaths,
  writeDaemonRegistry,
} from "../src/bridge-daemon.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridgeModel = "claude-sonnet-5";

test("claude command exposes the GHCP launcher", () => {
  const result = spawnSync(path.join(rootDir, "bin", "claude"), ["--help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Usage: claude-ghcp /);
  assert.match(result.stdout, /default: claude-sonnet-5/);
});

test("claude-ghcp rejects arguments that can bypass bridge routing", () => {
  const cases = [
    ["--settings", "/tmp/other-settings.json"],
    ["--", "--settings", "/tmp/other-settings.json"],
    ["--", "--model", "claude-sonnet-5"],
  ];

  for (const args of cases) {
    const result = spawnSync(path.join(rootDir, "bin", "claude-ghcp"), args, {
      encoding: "utf8",
    });

    assert.equal(result.status, 2, `${args.join(" ")}\n${result.stderr}`);
  }
});

test("claude-litellm exposes a separate gateway launcher", () => {
  const result = spawnSync(
    path.join(rootDir, "bin", "claude-litellm"),
    ["--help"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Usage: claude-litellm /);
  assert.match(result.stdout, /default: claude-sonnet-5/);
});

test("claude-litellm passes temporary gateway settings to upstream Claude", () => {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), "claude-litellm-launcher-"));
  const fakeClaude = path.join(fixtureDir, "claude");
  const capturedSettings = path.join(fixtureDir, "captured-settings.json");
  const capturedSettingsPath = path.join(fixtureDir, "settings-path.txt");
  const userSettingsDir = path.join(fixtureDir, ".claude");
  const userSettingsPath = path.join(userSettingsDir, "settings.json");
  const userSettings = '{"env":{"EXISTING_PROVIDER":"unchanged"}}\n';
  mkdirSync(userSettingsDir);
  writeFileSync(userSettingsPath, userSettings);
  writeFileSync(
    fakeClaude,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "while (($#)); do",
      '  if [[ "$1" == "--settings" ]]; then',
      '    cp "$2" "$CAPTURE_PATH"',
      '    printf "%s" "$2" > "$CAPTURE_SETTINGS_PATH"',
      "  fi",
      "  shift",
      "done",
      'printf "upstream-ok no-flicker=%s\\n" "${CLAUDE_CODE_NO_FLICKER:-}"',
      "",
    ].join("\n"),
  );
  chmodSync(fakeClaude, 0o755);

  try {
    const result = spawnSync(
      path.join(rootDir, "bin", "claude-litellm"),
      [],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CAPTURE_PATH: capturedSettings,
          CAPTURE_SETTINGS_PATH: capturedSettingsPath,
          CLAUDE_CODE_BIN: "",
          HOME: fixtureDir,
          LITELLM_API_KEY: "sk-test-only",
          LITELLM_BASE_URL: "https://litellm.example.com",
          LITELLM_MODEL: "",
          PATH: `${path.join(rootDir, "bin")}:${fixtureDir}:${process.env.PATH}`,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "upstream-ok no-flicker=1\n");
    const settings = JSON.parse(readFileSync(capturedSettings, "utf8"));
    assert.equal(settings.env.ANTHROPIC_BASE_URL, "https://litellm.example.com");
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "sk-test-only");
    assert.equal(settings.env.ANTHROPIC_MODEL, "claude-sonnet-5");
    assert.equal(settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION, "");
    assert.equal(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL, "");
    const temporarySettingsPath = readFileSync(capturedSettingsPath, "utf8");
    assert.equal(existsSync(temporarySettingsPath), false);
    assert.equal(readFileSync(userSettingsPath, "utf8"), userSettings);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("claude-litellm rejects a wrapper as CLAUDE_CODE_BIN", () => {
  const result = spawnSync(
    path.join(rootDir, "bin", "claude-litellm"),
    [],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_CODE_BIN: path.join(rootDir, "bin", "claude-litellm"),
        LITELLM_API_KEY: "sk-test-only",
        LITELLM_BASE_URL: "https://litellm.example.com",
      },
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /must point to the real Claude Code executable/);
});

test("claude-litellm rejects settings passed after the separator", () => {
  const result = spawnSync(
    path.join(rootDir, "bin", "claude-litellm"),
    ["--", "--settings", "/tmp/other-settings.json"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        LITELLM_API_KEY: "sk-test-only",
        LITELLM_BASE_URL: "https://litellm.example.com",
      },
    },
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Do not pass --model or --settings/);
});

test("claude-current skips the repository wrapper", () => {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), "claude-ghcp-launcher-"));
  const fakeClaude = path.join(fixtureDir, "claude");
  writeFileSync(fakeClaude, "#!/usr/bin/env bash\nprintf 'upstream:%s\\n' \"$*\"\n");
  chmodSync(fakeClaude, 0o755);

  try {
    const result = spawnSync(
      path.join(rootDir, "bin", "claude-current"),
      ["--version"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CLAUDE_CODE_BIN: "",
          PATH: `${path.join(rootDir, "bin")}:${fixtureDir}:${process.env.PATH}`,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "upstream:--version\n");
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

// The launcher polls the bridge from curl while spawnSync blocks this
// process's event loop, so the stub bridge has to answer from its own process.
async function fakeBridge(t, instanceId) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      [
        'const http = require("node:http");',
        "const [instanceId, model] = process.argv.slice(1);",
        "const server = http.createServer((request, response) => {",
        '  const body = request.url.startsWith("/health")',
        "    ? { instanceId, ok: true }",
        "    : { data: [{ backend_id: model, id: model }] };",
        '  response.writeHead(200, { "content-type": "application/json" });',
        "  response.end(JSON.stringify(body));",
        "});",
        'server.listen(0, "127.0.0.1", () => {',
        "  console.log(server.address().port);",
        "});",
      ].join("\n"),
      instanceId,
      bridgeModel,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  t.after(() => child.kill("SIGKILL"));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("data", (chunk) => {
      resolve({ pid: child.pid, port: Number(chunk.toString()) });
    });
  });
}

function launcherFixture(t) {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), "claude-ghcp-launcher-"));
  const daemonDir = mkdtempSync(path.join(tmpdir(), "ghcp-daemon-"));
  t.after(() => {
    rmSync(fixtureDir, { force: true, recursive: true });
    rmSync(daemonDir, { force: true, recursive: true });
  });
  const fakeClaude = path.join(fixtureDir, "claude");
  writeFileSync(
    fakeClaude,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "while (($#)); do",
      '  if [[ "$1" == "--settings" ]]; then',
      '    printf "%s" "$2" > "$CAPTURE_SETTINGS_PATH"',
      "  fi",
      "  shift",
      "done",
      "",
    ].join("\n"),
  );
  chmodSync(fakeClaude, 0o755);
  // The launcher only checks that `copilot` is on PATH; the stub bridge serves
  // every request it makes, so no real Copilot session has to exist.
  const fakeCopilot = path.join(fixtureDir, "copilot");
  writeFileSync(fakeCopilot, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(fakeCopilot, 0o755);
  return {
    ...process.env,
    CAPTURE_SETTINGS_PATH: path.join(fixtureDir, "settings-path.txt"),
    CLAUDE_CODE_BIN: "",
    GHCP_DAEMON_DIR: daemonDir,
    // An exported GHCP_MODEL would override the launcher's own default and
    // stop matching the model the stub bridge below advertises, so the
    // model-availability probe would fail on that developer's machine only.
    GHCP_MODEL: "",
    // HOME feeds daemonConfigFingerprint, so a real one makes the fingerprint
    // depend on whose machine is running the suite.
    HOME: fixtureDir,
    // Last-resort containment for the fingerprint drift runBackgroundLauncher
    // describes: ensureDaemon's restart path spawns src/server.mjs detached
    // and unref'd, which is a real Copilot bridge that outlives the suite and
    // is orphaned once t.after removes the registry naming it. An unparseable
    // MAX_ value makes that replacement die while it reads its environment,
    // before it can reach the SDK, so the worst case is a loud test failure
    // rather than a stray daemon.
    MAX_STATES: "not-a-number",
    PATH: `${path.join(rootDir, "bin")}:${fixtureDir}:${process.env.PATH}`,
  };
}

// The launcher subprocess recomputes the fingerprint seeded here, and that
// hash covers every src/*.mjs, so a file saved in the few hundred milliseconds
// between the two reads drops ensureDaemon onto its restart path. Re-seeding is
// the only way back: that restart already SIGTERMed the stub whose PID the
// registry named, so the attempt needs a fresh stub and a fresh daemon dir.
// Three attempts because a concurrent save is a coincidence, not a pattern --
// if it drifts every time, something is rewriting src/ continuously and the
// reuse path this test exists to cover genuinely cannot be reached.
const BACKGROUND_LAUNCH_ATTEMPTS = 3;

async function runBackgroundLauncher(t) {
  for (let attempt = 1; ; attempt += 1) {
    const instanceId = "instance-background";
    const { pid, port } = await fakeBridge(t, instanceId);
    const env = launcherFixture(t);
    const paths = daemonPaths(env);
    // A matching fingerprint over a live PID whose /health echoes that
    // instanceId satisfies every term of ensureDaemon's reuse guard, so the
    // launcher never has to start a real bridge. The registry names the stub's
    // PID, not ours: naming ours would point the restart path's SIGTERM at
    // this test runner.
    writeDaemonRegistry(paths, {
      configFingerprint: daemonConfigFingerprint(env, port),
      instanceId,
      model: bridgeModel,
      pid,
      port,
      token: "test-only",
    });

    const result = spawnSync(
      path.join(rootDir, "bin", "claude-ghcp"),
      ["--background", "--bridge-port", String(port)],
      { encoding: "utf8", env },
    );

    // Every way the restart path can end says "Persistent bridge ...", and the
    // reuse path cannot produce any of them, so this is the drift signal. It
    // is usually "did not stop": the registry names a stub that is this
    // process's own child, and spawnSync blocks the event loop that would
    // reap it, so the SIGKILL leaves a zombie that still answers signal 0 and
    // stopRegistry gives up before it ever spawns a replacement. MAX_STATES in
    // the fixture covers the case where one does get spawned. Note this does
    // not swallow "GitHub Copilot model is unavailable", which is a real
    // environment leak rather than drift and must stay loud.
    if (/Persistent bridge/.test(result.stderr)) {
      assert.ok(
        attempt < BACKGROUND_LAUNCH_ATTEMPTS,
        `ensureDaemon took its restart path on all ${BACKGROUND_LAUNCH_ATTEMPTS} attempts: the seeded fingerprint keeps drifting, so this test never exercised the reuse path.\n${result.stderr}`,
      );
      continue;
    }
    assert.equal(result.status, 0, result.stderr);
    return {
      paths,
      port,
      settingsPath: readFileSync(env.CAPTURE_SETTINGS_PATH, "utf8"),
    };
  }
}

test("claude-ghcp keeps background settings after the launcher exits", async (t) => {
  const { paths, port, settingsPath } = await runBackgroundLauncher(t);

  // Claude Code's daemon respawns a backgrounded job from the --settings path
  // it was launched with, long after this launcher process is gone.
  assert.equal(existsSync(settingsPath), true, settingsPath);
  assert.equal(path.dirname(settingsPath), paths.settings);
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(settings.env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${port}`);
});

test("claude-ghcp keeps surviving settings private to the user", async (t) => {
  const { paths, settingsPath } = await runBackgroundLauncher(t);

  // The file outlives the launcher and carries the bridge token.
  assert.equal(statSync(settingsPath).mode & 0o777, 0o600);
  assert.equal(statSync(paths.settings).mode & 0o777, 0o700);
});

test("claude-ghcp removes the settings file of a foreground bridge", async (t) => {
  const { port } = await fakeBridge(t, "instance-foreground");
  const env = launcherFixture(t);

  const result = spawnSync(
    path.join(rootDir, "bin", "claude-ghcp"),
    ["--bridge-port", String(port)],
    { encoding: "utf8", env },
  );

  assert.equal(result.status, 0, result.stderr);
  const settingsPath = readFileSync(env.CAPTURE_SETTINGS_PATH, "utf8");
  // Nothing respawns a foreground session, so its token must not linger.
  assert.equal(existsSync(settingsPath), false);
  // A foreground launch must never reach bridge-daemon.mjs at all. Asserting
  // its settings subdirectory is absent proves nothing -- this path never
  // creates one either way -- but ensureDaemon cannot run without leaving
  // bridge.log behind in the daemon directory, so an empty directory does.
  assert.deepEqual(readdirSync(daemonPaths(env).base), []);
});
// Every startup probe in bin/claude-ghcp is bounded, and the launcher states a
// worst-case ceiling that callers budget against (scripts/verify/drivers.mjs
// spawns it under a 180s spawnSync cap). Until this test existed nothing held
// those bounds down: deleting both --max-time flags and inflating
// HEALTH_DEADLINE to 99999 left the suite at 152/152 green, and the fetch probe
// had no bound at all -- against a port that is bound but silent it was still
// pending at 30s, so the stated ceiling was arithmetic about a wait that could
// not honour it. Rather than restate the numbers here, this parses them back
// out of the script and re-adds them, so the comment's figure is the assertion.
test("claude-ghcp bounds every startup probe and states the true ceiling", () => {
  const script = readFileSync(path.join(rootDir, "bin", "claude-ghcp"), "utf8");

  const deadline = script.match(/HEALTH_DEADLINE=\$\(\(SECONDS \+ (\d+(?:\.\d+)?)\)\)/);
  assert.ok(deadline, "the health wait no longer sets a HEALTH_DEADLINE ceiling");

  const sleep = script.match(/^\s*sleep (\d+(?:\.\d+)?)$/m);
  assert.ok(sleep, "the health loop no longer sleeps a known interval");

  // Both probes hit a port that may be bound but silent, so an uncapped curl
  // there spends minutes. Collecting every curl (not just the two known ones)
  // means a third, unbounded probe added later also fails here.
  const curls = script
    .split("\n")
    .filter((line) => /(^|\s)curl\s/.test(line) && !/^\s*#/.test(line));
  assert.equal(curls.length, 2, `expected two curl probes, found:\n${curls.join("\n")}`);
  const curlCaps = curls.map((line) => {
    const cap = line.match(/--max-time (\d+(?:\.\d+)?)/);
    assert.ok(cap, `curl probe has no --max-time, so it is unbounded:\n${line}`);
    return Number(cap[1]);
  });

  // A fetch ignores --max-time and every other external clock: AbortSignal is
  // the only thing that bounds it, so each one must carry its own.
  const fetches = [...script.matchAll(/fetch\(/g)];
  assert.equal(fetches.length, 1, "expected exactly one fetch probe in the launcher");
  const fetchCaps = fetches.map(({ index }) => {
    const call = script.slice(index, index + 400);
    const cap = call.match(/signal:\s*AbortSignal\.timeout\((\d[\d_]*)\)/);
    assert.ok(
      cap,
      `fetch probe carries no AbortSignal.timeout, so nothing bounds it:\n${call.split("\n").slice(0, 6).join("\n")}`,
    );
    return Number(cap[1].replaceAll("_", "")) / 1000;
  });

  // The loop can start one last probe just under the deadline, so the true
  // worst case is the deadline plus one overshooting iteration plus every
  // one-shot probe that follows.
  const worstCase =
    Number(deadline[1]) +
    Number(sleep[1]) +
    curlCaps.reduce((total, cap) => total + cap, 0) +
    fetchCaps.reduce((total, cap) => total + cap, 0);

  assert.ok(
    script.includes(`${worstCase}s worst case`),
    `the launcher's bounds now add to ${worstCase}s, which is not the ceiling the file claims`,
  );
  // The same figure is spent against the driver's 180s spawnSync cap a few
  // lines below, and a ceiling that disagrees with itself is the bug this pins.
  assert.ok(
    script.includes(`180 - ${worstCase} leaves`),
    `the budget arithmetic does not subtract the real ${worstCase}s ceiling from the caller's 180s cap`,
  );
});

// The static assertion above proves the AbortSignal is written down; this
// proves it actually fires. A bridge that binds its port and never answers is
// the case both probe caps exist for, and it is the case an unsignalled fetch
// rides out on undici's default header timeout -- minutes, long past the
// ceiling the launcher promises.
test("claude-ghcp's model probe gives up on a bound-but-silent bridge", async (t) => {
  // The real probe body, lifted out of the real script, so this cannot drift
  // into testing a copy.
  const script = readFileSync(path.join(rootDir, "bin", "claude-ghcp"), "utf8");
  const probe = script.match(/if ! node -e '\n([\s\S]*?)\n' "http/);
  assert.ok(probe, "could not find the node -e model probe in bin/claude-ghcp");

  // Accepts the connection, then writes nothing, ever. Nothing here reads from
  // the socket either, so it never leaves the paused state and never observes
  // the child's FIN -- server.close() would wait on it forever. Tearing the
  // sockets down explicitly is what makes this listener short-lived.
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });
  t.after(
    () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  const port = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });

  const child = spawn(
    process.execPath,
    [
      "-e",
      probe[1],
      `http://127.0.0.1:${port}/v1/models?all=true`,
      "test-only",
      bridgeModel,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  // Far above the probe's own cap and far below undici's default, so this can
  // only be reached by a probe that bounds itself.
  const GIVE_UP_MS = 25_000;
  const started = Date.now();
  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, GIVE_UP_MS);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  assert.notEqual(
    exit,
    null,
    `the model probe was still waiting on a silent bridge after ${GIVE_UP_MS}ms, so nothing bounds it`,
  );
  // Non-zero is what makes the launcher exit 1 instead of handing Claude Code a
  // bridge it never confirmed.
  assert.notEqual(exit, 0, `probe reported success against a silent bridge\n${stderr}`);
  assert.ok(
    Date.now() - started < GIVE_UP_MS,
    "probe only stopped because this test killed it",
  );
});
