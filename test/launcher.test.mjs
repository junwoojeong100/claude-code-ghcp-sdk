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
  symlinkSync,
  utimesSync,
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
import { ClaudeBinaryError, resolveClaudeBin } from "../scripts/verify/bridge.mjs";

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

function runLitellm(t, args, env = {}) {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), "claude-litellm-launcher-"));
  t.after(() => rmSync(fixtureDir, { recursive: true, force: true }));
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
  const stateHome = path.join(fixtureDir, "state");
  const result = spawnSync(path.join(rootDir, "bin", "claude-litellm"), args, {
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
      XDG_STATE_HOME: stateHome,
      ...env,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(userSettingsPath, "utf8"), userSettings);
  return {
    fixtureDir,
    result,
    settings: JSON.parse(readFileSync(capturedSettings, "utf8")),
    settingsPath: readFileSync(capturedSettingsPath, "utf8"),
    stateDir: path.join(stateHome, "claude-code-ghcp-sdk", "litellm-settings"),
  };
}

test("claude-litellm passes gateway settings to upstream Claude", (t) => {
  const { result, settings } = runLitellm(t, []);

  assert.equal(result.stdout, "upstream-ok no-flicker=1\n");
  assert.equal(settings.env.ANTHROPIC_BASE_URL, "https://litellm.example.com");
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "sk-test-only");
  assert.equal(settings.env.ANTHROPIC_MODEL, "claude-sonnet-5");
  assert.equal(settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION, "");
  assert.equal(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL, "");
});

// Claude Code's daemon respawns a /background or --background job from the
// --settings path it started with, after the launcher has exited. The file
// carries the LiteLLM key, so it stays private to the user.
test("claude-litellm keeps settings that a background job restarts from", (t) => {
  for (const args of [[], ["--background", "task"], ["-p", "--bg", "task"]]) {
    const { settingsPath, stateDir } = runLitellm(t, args);
    assert.equal(existsSync(settingsPath), true, args.join(" "));
    assert.equal(path.dirname(settingsPath), stateDir);
    assert.equal(statSync(settingsPath).mode & 0o777, 0o600);
    assert.equal(statSync(stateDir).mode & 0o777, 0o700);
    assert.equal(statSync(path.dirname(stateDir)).mode & 0o777, 0o700);
  }
  // Without XDG_STATE_HOME the state directory falls back to ~/.local/state.
  const { fixtureDir, settingsPath } = runLitellm(t, [], { XDG_STATE_HOME: "" });
  assert.equal(
    path.dirname(settingsPath),
    path.join(fixtureDir, ".local", "state", "claude-code-ghcp-sdk", "litellm-settings"),
  );
});

test("claude-litellm removes the settings file of a print-mode run", (t) => {
  const { settingsPath, stateDir } = runLitellm(t, ["-p", "hello"]);
  // Nothing respawns a print-mode run, so its key must not linger.
  assert.equal(existsSync(settingsPath), false);
  assert.equal(existsSync(stateDir), false);
});

test("claude-litellm reaps only its settings files older than 7 days", (t) => {
  const stateHome = mkdtempSync(path.join(tmpdir(), "claude-litellm-state-"));
  t.after(() => rmSync(stateHome, { recursive: true, force: true }));
  const stateDir = path.join(stateHome, "claude-code-ghcp-sdk", "litellm-settings");
  mkdirSync(stateDir, { recursive: true });
  const stale = path.join(stateDir, "stale.json");
  const live = path.join(stateDir, "live.json");
  const seconds = Date.now() / 1000;
  const day = 24 * 60 * 60;
  for (const [file, age] of [[stale, 8 * day], [live, 6 * day]]) {
    writeFileSync(file, "{}\n", { mode: 0o600 });
    utimesSync(file, seconds - age, seconds - age);
  }

  const { settingsPath } = runLitellm(t, [], { XDG_STATE_HOME: stateHome });

  assert.equal(existsSync(stale), false);
  // A background job can sit idle for days; one inside the window stays.
  assert.equal(existsSync(live), true);
  assert.equal(existsSync(settingsPath), true);
});

// -p --bg keeps its key file, and a print-mode run reaps nothing, so the help
// and .env.example must not promise otherwise.
test("claude-litellm help and .env.example state when the key file is removed", () => {
  const help = spawnSync(path.join(rootDir, "bin", "claude-litellm"), ["--help"], {
    encoding: "utf8",
  }).stdout.replace(/\s+/g, " ");
  const env = readFileSync(path.join(rootDir, ".env.example"), "utf8").replace(/\s*\n#\s*/g, " ");
  assert.match(help, /print-mode run \(-p without --background or --bg\) removes it/);
  assert.match(help, /each launch other than print mode first removes files there older than 7 days/);
  assert.match(env, /claude-litellm print-mode run \(-p without --background or --bg\) it holds the settings file/);
  assert.match(env, /claude-litellm launches other than print mode \(-p without --background or --bg\) keep/);
  assert.match(env, /Each such launch deletes the ones older than 7 days/);
  assert.doesNotMatch(env, /A later claude-litellm launch deletes/);
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

test("both resolvers skip another checkout's launcher", (t) => {
  // A worktree run with the main checkout's bin/ on PATH: the old check only
  // knew its own checkout's launchers, resolved to the other one, and every
  // slot of that matrix was blocked by that launcher's --settings guard. The
  // symlink is how ~/.local/bin usually exposes a checkout's launcher.
  const fixtureDir = mkdtempSync(path.join(tmpdir(), "claude-ghcp-launcher-"));
  t.after(() => rmSync(fixtureDir, { recursive: true, force: true }));
  const otherBin = path.join(fixtureDir, "other-checkout", "bin");
  const linkDir = path.join(fixtureDir, "local-bin");
  const realDir = path.join(fixtureDir, "real");
  for (const dir of [otherBin, linkDir, realDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(otherBin, "claude"), "#!/usr/bin/env bash\nprintf 'other-checkout\\n'\n");
  writeFileSync(path.join(otherBin, "resolve-claude.sh"), "");
  symlinkSync(path.join(otherBin, "claude"), path.join(linkDir, "claude"));
  const realClaude = path.join(realDir, "claude");
  writeFileSync(realClaude, "#!/usr/bin/env bash\nprintf 'upstream:%s\\n' \"$*\"\n");
  for (const file of [path.join(otherBin, "claude"), realClaude]) chmodSync(file, 0o755);

  const env = {
    ...process.env,
    CLAUDE_CODE_BIN: "",
    PATH: `${otherBin}:${linkDir}:${realDir}:${process.env.PATH}`,
  };
  const result = spawnSync(path.join(rootDir, "bin", "claude-current"), ["--version"], {
    encoding: "utf8",
    env,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "upstream:--version\n");
  assert.equal(resolveClaudeBin({ env }), realClaude);

  // Naming the other checkout's launcher outright is refused the same way.
  const explicit = { ...env, CLAUDE_CODE_BIN: path.join(linkDir, "claude") };
  const refused = spawnSync(path.join(rootDir, "bin", "claude-current"), ["--version"], {
    encoding: "utf8",
    env: explicit,
  });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /must point to the real Claude Code executable/);
  assert.throws(() => resolveClaudeBin({ env: explicit }), ClaudeBinaryError);

  // A real binary that happens to be named claude is still found: the name
  // alone does not make a launcher, the resolve-claude.sh beside it does.
  assert.equal(resolveClaudeBin({ env: { ...env, PATH: realDir } }), realClaude);
});

// The launcher polls the bridge from curl while spawnSync blocks this
// process's event loop, so the stub bridge has to answer from its own process.
// With token, /v1/models requires that x-api-key; with healthLimit, /health
// answers 503 once it has answered that many times.
async function fakeBridge(t, instanceId, { token = "", healthLimit = 0 } = {}) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      [
        'const http = require("node:http");',
        "const [instanceId, model, token, healthLimit] = process.argv.slice(1);",
        "let healthAnswers = 0;",
        "const server = http.createServer((request, response) => {",
        '  const health = request.url.startsWith("/health");',
        "  if (health && Number(healthLimit) && ++healthAnswers > Number(healthLimit)) {",
        "    response.writeHead(503);",
        "    return response.end();",
        "  }",
        '  if (!health && token && request.headers["x-api-key"] !== token) {',
        "    response.writeHead(401);",
        "    return response.end();",
        "  }",
        "  const body = health",
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
      token,
      String(healthLimit),
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
      // Whatever lease the launcher took is only on disk while this runs.
      'cat "$GHCP_DAEMON_DIR"/leases/*.pid > "$CAPTURE_LEASE_PATH" 2>/dev/null || true',
      'printf "%s" "$PATH" > "$CAPTURE_PATH_ENV"',
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
    CAPTURE_LEASE_PATH: path.join(fixtureDir, "leases.txt"),
    CAPTURE_PATH_ENV: path.join(fixtureDir, "path.txt"),
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

async function runBackgroundLauncher(
  t,
  launchArgs = ["--background"],
  { bridge = {}, seed = () => {}, status = 0 } = {},
) {
  for (let attempt = 1; ; attempt += 1) {
    const instanceId = "instance-background";
    // The token the launcher can only have taken from ensure's JSON, so a
    // probe or settings file that lost it on the way is caught here.
    const { pid, port } = await fakeBridge(t, instanceId, { token: "test-only", ...bridge });
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
    seed(paths);

    const result = spawnSync(
      path.join(rootDir, "bin", "claude-ghcp"),
      [...launchArgs, "--bridge-port", String(port)],
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
    assert.equal(result.status, status, result.stderr);
    if (status !== 0) return { result };
    return {
      launcherPid: result.pid,
      leasesDuringRun: readFileSync(env.CAPTURE_LEASE_PATH, "utf8"),
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
  // Reached the writer through GHCP_BRIDGE_TOKEN rather than argv.
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "test-only");
});

test("claude-ghcp keeps surviving settings private to the user", async (t) => {
  const { paths, settingsPath } = await runBackgroundLauncher(t);

  // The file outlives the launcher and carries the bridge token.
  assert.equal(statSync(settingsPath).mode & 0o777, 0o600);
  assert.equal(statSync(paths.settings).mode & 0o777, 0o700);
});

// An interactive session can be handed to Claude Code's daemon with
// /background at any point, so the launcher cannot know at startup that it
// will not be. The job that leaves behind still calls the bridge and is
// respawned from --settings after the launcher exits; on the ephemeral bridge
// it failed with "API Error: 499 The client closed the request." once cleanup
// stopped the bridge under it.
test("claude-ghcp gives an interactive session the persistent bridge", async (t) => {
  const { paths, port, settingsPath } = await runBackgroundLauncher(t, []);

  assert.equal(existsSync(settingsPath), true, settingsPath);
  assert.equal(path.dirname(settingsPath), paths.settings);
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(settings.env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${port}`);
});

// Sharing one bridge means a later launch can replace it under a session that
// is still open. The lease is what keeps a replaced bridge serving that
// session (src/retirement.mjs), so it has to name a PID that lives exactly as
// long as the session does -- the launcher's own -- and go away with it.
test("claude-ghcp holds a lease on the shared bridge only while it runs", async (t) => {
  const { launcherPid, leasesDuringRun, paths } = await runBackgroundLauncher(t, []);

  assert.equal(leasesDuringRun, `${launcherPid}\n`);
  assert.deepEqual(readdirSync(paths.leases), []);
});

test("claude-ghcp removes the settings file of a print-mode bridge", async (t) => {
  const { port } = await fakeBridge(t, "instance-foreground");
  const env = launcherFixture(t);

  const result = spawnSync(
    path.join(rootDir, "bin", "claude-ghcp"),
    ["-p", "--bridge-port", String(port), "hello"],
    { encoding: "utf8", env },
  );

  assert.equal(result.status, 0, result.stderr);
  const settingsPath = readFileSync(env.CAPTURE_SETTINGS_PATH, "utf8");
  // A print-mode run ends with this process and nothing respawns it, so its
  // token must not linger.
  assert.equal(existsSync(settingsPath), false);
  // A print-mode launch must never reach bridge-daemon.mjs at all. Asserting
  // its settings subdirectory is absent proves nothing -- this path never
  // creates one either way -- but ensureDaemon cannot run without leaving
  // bridge.log behind in the daemon directory, so an empty directory does.
  assert.deepEqual(readdirSync(daemonPaths(env).base), []);
  // Claude Code, and the Bash tool, hooks and MCP servers it starts, see the
  // caller's PATH: this repository's devDependency binaries (playwright and
  // the like) must not shadow the user's own.
  assert.equal(readFileSync(env.CAPTURE_PATH_ENV, "utf8"), env.PATH);
});

// The shared daemon log is only ever appended to, so its head is the oldest
// bridges' output and the failure being reported is at its end.
test("claude-ghcp shows the end of the shared bridge log when the bridge stops answering", async (t) => {
  const lines = Array.from({ length: 200 }, (_, index) => `bridge log line ${index + 1}`);
  const { result } = await runBackgroundLauncher(t, [], {
    // ensure's own probe gets its answer; the launcher's confirmation does not.
    bridge: { healthLimit: 1 },
    seed: (paths) => writeFileSync(paths.log, `${lines.join("\n")}\n`),
    status: 1,
  });

  assert.match(result.stderr, /Timed out waiting for the GHCP bridge/);
  assert.match(result.stderr, /bridge log line 200\n/);
  assert.doesNotMatch(result.stderr, /bridge log line 1\n/);
});

// A process's arguments are readable by every local user, and the persistent
// bridge's token stays valid for as long as that bridge runs.
test("claude-ghcp never passes the bridge token as an argument", () => {
  const script = readFileSync(path.join(rootDir, "bin", "claude-ghcp"), "utf8");
  const code = script.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  const uses = [...code.matchAll(/\$\{?BRIDGE_TOKEN\}?/g)];
  // The private bridge, the model probe and the settings writer all need it.
  assert.equal(uses.length, 3, uses.map(({ index }) => code.slice(index - 40, index + 20)).join("\n---\n"));
  for (const { index } of uses) {
    assert.match(
      code.slice(Math.max(0, index - 40), index),
      /(?:^|\s)[A-Z_][A-Z0-9_]*="$/,
      `$BRIDGE_TOKEN is used outside an environment assignment:\n${code.slice(index - 60, index + 30)}`,
    );
  }
});

// npm link and ~/.local/bin expose launchers through symlinks, so each one has
// to find its checkout from the link's target, not from where the link sits.
test("launchers work when run through a symlink", (t) => {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), "claude-ghcp-launcher-"));
  t.after(() => rmSync(fixtureDir, { recursive: true, force: true }));
  const linkBin = path.join(fixtureDir, "prefix", "bin");
  const hopDir = path.join(fixtureDir, "hop");
  for (const dir of [linkBin, hopDir]) mkdirSync(dir, { recursive: true });
  for (const name of ["claude", "claude-ghcp", "claude-litellm", "claude-current", "claude-ghcp-status"]) {
    // Two hops, the second one relative.
    symlinkSync(path.join(rootDir, "bin", name), path.join(hopDir, name));
    symlinkSync(path.join("..", "..", "hop", name), path.join(linkBin, name));
  }
  const realClaude = path.join(fixtureDir, "real-claude");
  writeFileSync(realClaude, "#!/usr/bin/env bash\nprintf 'upstream:%s\\n' \"$*\"\n");
  chmodSync(realClaude, 0o755);
  const env = {
    ...process.env,
    CLAUDE_CODE_BIN: realClaude,
    GHCP_DAEMON_DIR: path.join(fixtureDir, "daemon"),
  };
  const run = (name, args) => {
    const result = spawnSync(path.join(linkBin, name), args, { encoding: "utf8", env });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    return result.stdout;
  };

  assert.match(run("claude", ["--help"]), /^Usage: claude-ghcp /);
  assert.match(run("claude-ghcp", ["--help"]), /^Usage: claude-ghcp /);
  assert.match(run("claude-litellm", ["--help"]), /^Usage: claude-litellm /);
  assert.equal(run("claude-current", ["--version"]), "upstream:--version\n");
  assert.equal(JSON.parse(run("claude-ghcp-status", [])).running, false);

  // The others would start or stop a bridge or reach Copilot, so they are only
  // checked for the same resolution step.
  for (const name of readdirSync(path.join(rootDir, "bin"))) {
    if (name.startsWith(".") || name === "resolve-claude.sh") continue;
    assert.match(
      readFileSync(path.join(rootDir, "bin", name), "utf8"),
      /while \[\[ -L "\$SCRIPT_PATH" \]\]; do[\s\S]*?done\nROOT_DIR="\$\(cd -P "\$\(dirname "\$SCRIPT_PATH"\)\/\.\." && pwd\)"/,
      name,
    );
  }
});

// The private -p bridge's shutdown awaits the SDK's client.stop(), which can
// hang on a wedged Copilot runtime, so the launcher's wait for it has to end
// on its own. PATH puts a node in front whose src/server.mjs is a stub bridge
// that ignores SIGTERM; every other node command runs the real node.
test("claude-ghcp ends a print-mode bridge that ignores SIGTERM", (t) => {
  const env = launcherFixture(t);
  const fixtureDir = path.dirname(env.CAPTURE_PATH_ENV);
  const wrapperDir = path.join(fixtureDir, "node-wrapper");
  mkdirSync(wrapperDir);
  const pidFile = path.join(fixtureDir, "bridge.pid");
  const stubborn = path.join(fixtureDir, "stubborn-bridge.cjs");
  writeFileSync(stubborn, [
    'const http = require("node:http");',
    'process.on("SIGTERM", () => {});',
    'require("node:fs").writeFileSync(process.env.STUBBORN_PID_PATH, String(process.pid));',
    "const model = process.env.GHCP_MODEL;",
    "http.createServer((request, response) => {",
    '  const body = request.url.startsWith("/health") ? { ok: true } : { data: [{ backend_id: model, id: model }] };',
    '  response.writeHead(200, { "content-type": "application/json" });',
    "  response.end(JSON.stringify(body));",
    '}).listen(Number(process.env.PORT), "127.0.0.1");',
  ].join("\n"));
  writeFileSync(path.join(wrapperDir, "node"), [
    "#!/usr/bin/env bash",
    'if [[ "${1:-}" == */src/server.mjs ]]; then exec "$REAL_NODE" "$STUBBORN_BRIDGE"; fi',
    'exec "$REAL_NODE" "$@"',
    "",
  ].join("\n"));
  chmodSync(path.join(wrapperDir, "node"), 0o755);

  const started = Date.now();
  const result = spawnSync(path.join(rootDir, "bin", "claude-ghcp"), ["-p", "hello"], {
    encoding: "utf8",
    env: {
      ...env,
      PATH: `${wrapperDir}:${env.PATH}`,
      REAL_NODE: process.execPath,
      STUBBORN_BRIDGE: stubborn,
      STUBBORN_PID_PATH: pidFile,
    },
    // An unbounded wait would outlive this; SIGKILL, because the launcher's
    // own trap would wait again on SIGTERM.
    killSignal: "SIGKILL",
    timeout: 90_000,
  });
  const elapsed = Date.now() - started;
  const pid = Number(readFileSync(pidFile, "utf8"));
  try {
    assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}`);
    assert.ok(elapsed < 60_000, `the launcher took ${elapsed}ms to give up on its bridge`);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
});

// npm run doctor has to probe the real Claude Code, not this repository's
// bin/claude, which would start (or fail to start) the persistent bridge just
// to print a version. No copilot is on PATH, so that wrong path fails at once
// instead of reaching bridge-daemon.mjs; the hanging npm checks that one stuck
// probe cannot stall the whole report, even one that ignores SIGTERM. It ends
// itself after ~30s, and in 1s steps, so no probe outlives a failing run long.
test("npm run doctor probes the real Claude Code and bounds each probe", (t) => {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), "claude-ghcp-doctor-"));
  t.after(() => rmSync(fixtureDir, { recursive: true, force: true }));
  symlinkSync(process.execPath, path.join(fixtureDir, "node"));
  writeFileSync(path.join(fixtureDir, "claude"), "#!/bin/sh\necho 9.9.9\n");
  writeFileSync(
    path.join(fixtureDir, "npm"),
    "#!/bin/sh\ntrap '' TERM\ni=0\nwhile [ $i -lt 30 ]; do sleep 1; i=$((i + 1)); done\n",
  );
  for (const name of ["claude", "npm"]) chmodSync(path.join(fixtureDir, name), 0o755);
  const { scripts } = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));

  const started = Date.now();
  const result = spawnSync("/bin/sh", ["-c", scripts.doctor], {
    cwd: rootDir,
    encoding: "utf8",
    env: {
      CLAUDE_CODE_BIN: "",
      GHCP_DAEMON_DIR: path.join(fixtureDir, "daemon"),
      HOME: fixtureDir,
      MAX_STATES: "not-a-number",
      PATH: `${path.join(rootDir, "bin")}:${fixtureDir}:/usr/bin:/bin`,
    },
    killSignal: "SIGKILL",
    timeout: 60_000,
  });

  const report = JSON.parse(result.stdout);
  assert.equal(report.claude.version, "9.9.9", result.stderr);
  assert.equal(report.npm.ok, false);
  assert.ok(Date.now() - started < 25_000, "a hanging probe stalled the report");
});
// Parse every startup bound from the launcher and check that their sum
// matches its documented worst-case ceiling, including a silent health port.
test("claude-ghcp bounds every startup probe and states the true ceiling", () => {
  const script = readFileSync(path.join(rootDir, "bin", "claude-ghcp"), "utf8");

  const deadline = script.match(/HEALTH_DEADLINE=\$\(\(SECONDS \+ (\d+(?:\.\d+)?)\)\)/);
  assert.ok(deadline, "the health wait no longer sets a HEALTH_DEADLINE ceiling");

  const sleep = script.slice(deadline.index).match(/^\s*sleep (\d+(?:\.\d+)?)$/m);
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
  const probe = script.match(/if ! GHCP_BRIDGE_TOKEN="\$BRIDGE_TOKEN" node -e '\n([\s\S]*?)\n' "http/);
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
      bridgeModel,
    ],
    {
      env: { ...process.env, GHCP_BRIDGE_TOKEN: "test-only" },
      stdio: ["ignore", "ignore", "pipe"],
    },
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
