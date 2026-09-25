import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { readCopilotSdkVersion } from "../scripts/verify/sdk-version.mjs";

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "verify-sdk-version-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeUrl = pathToFileURL(path.join(root, "src/session-manager.mjs"));
  write(path.join(root, "src/session-manager.mjs"), "throw new Error('RUNTIME_MUST_NOT_EXECUTE');\n");
  write(path.join(root, "package.json"), JSON.stringify({ name: "fixture-app", version: "0.0.1" }));
  return { root, runtimeUrl };
}

function installSdk(root, { entry = "dist/index.mjs", manifest = {} } = {}) {
  const directory = path.join(root, "node_modules/@github/copilot-sdk");
  const manifestPath = path.join(directory, "package.json");
  write(path.join(directory, entry), "throw new Error('SDK_ENTRY_MUST_NOT_EXECUTE');\n");
  write(manifestPath, JSON.stringify({
    name: "@github/copilot-sdk", version: "9.8.7", type: "module",
    exports: { ".": `./${entry}` }, ...manifest,
  }));
  return { directory, manifestPath };
}

test("reads the installed SDK version, not the declared or locked version", (t) => {
  const { root, runtimeUrl } = fixture(t);
  write(path.join(root, "package.json"), JSON.stringify({ dependencies: { "@github/copilot-sdk": "1.0.0" } }));
  write(path.join(root, "package-lock.json"), JSON.stringify({
    packages: { "node_modules/@github/copilot-sdk": { version: "2.0.0" } },
  }));
  installSdk(root, { manifest: { version: "3.0.0-beta.1" } });
  assert.equal(readCopilotSdkVersion(runtimeUrl), "3.0.0-beta.1");
});

for (const entry of ["index.cjs", "dist/index.js", "build/cjs/public/index.cjs", "lib/build/esm/index.mjs"]) {
  test(`finds the SDK manifest from ${entry} without executing its private-export package`, (t) => {
    const { root, runtimeUrl } = fixture(t);
    const { directory } = installSdk(root, { entry });
    const nested = path.dirname(path.join(directory, entry));
    if (nested !== directory) {
      write(path.join(nested, "package.json"), JSON.stringify({ name: "@github/copilot-sdk-build", version: "wrong" }));
      const parent = path.dirname(nested);
      if (parent !== directory) write(path.join(parent, "package.json"), JSON.stringify({ type: "module" }));
    }
    assert.throws(() => createRequire(runtimeUrl).resolve("@github/copilot-sdk/package.json"), {
      code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
    });
    assert.equal(readCopilotSdkVersion(runtimeUrl), "9.8.7");
  });
}

test("default lookup follows the runtime source's nested dependency regardless of cwd or helper location", (t) => {
  const { root, runtimeUrl } = fixture(t);
  installSdk(root, { manifest: { version: "1.0.0" } });
  installSdk(path.join(root, "src"), { manifest: { version: "2.0.0" } });
  installSdk(path.join(root, "scripts/verify"), { manifest: { version: "3.0.0" } });
  const unrelated = path.join(root, "unrelated");
  installSdk(unrelated, { manifest: { version: "4.0.0" } });
  const helper = path.join(root, "scripts/verify/sdk-version.mjs");
  fs.copyFileSync(new URL("../scripts/verify/sdk-version.mjs", import.meta.url), helper);
  assert.equal(readCopilotSdkVersion(runtimeUrl), "2.0.0");
  for (const cwd of [root, unrelated]) {
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
      import { readCopilotSdkVersion } from ${JSON.stringify(pathToFileURL(helper).href)};
      console.log(JSON.stringify(readCopilotSdkVersion()));
    `], { cwd, encoding: "utf8", timeout: 10000, killSignal: "SIGKILL" });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout), "2.0.0");
  }
});

test("returns null when the SDK is absent", (t) => {
  const { runtimeUrl } = fixture(t);
  assert.equal(readCopilotSdkVersion(runtimeUrl), null);
});

for (const [label, contents] of [
  ["missing manifest", null],
  ["malformed manifest", "{bad json"],
  ["null manifest", "null"],
  ["wrong package name", JSON.stringify({ name: "not-copilot-sdk", version: "9.8.7" })],
]) {
  test(`returns null for ${label}`, (t) => {
    const { root, runtimeUrl } = fixture(t);
    // index.js remains resolvable even when the manifest is missing.
    const { manifestPath } = installSdk(root, { entry: "index.js" });
    if (contents === null) fs.rmSync(manifestPath);
    else fs.writeFileSync(manifestPath, contents);
    assert.equal(readCopilotSdkVersion(runtimeUrl), null);
  });
}

for (const version of [undefined, null, false, 123, [], {}, "", " \t\n"]) {
  test(`returns null for invalid SDK version ${JSON.stringify(version)}`, (t) => {
    const { root, runtimeUrl } = fixture(t);
    installSdk(root, { manifest: { version } });
    assert.equal(readCopilotSdkVersion(runtimeUrl), null);
  });
}
