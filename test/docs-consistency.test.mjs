import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const pair = (name) => [`docs/${name}.md`, `docs/${name}_KO.md`];
// Hand-written documents. docs/VERIFICATION*.md is generated from a run.
const HAND_WRITTEN = ["README.md", "README_KO.md",
  ...["ARCHITECTURE", "COMPATIBILITY", "DIAGNOSTICS", "LITELLM", "TESTING"].flatMap(pair)];
const ALL_DOCS = ["README.md", "README_KO.md",
  ...fs.readdirSync(path.join(root, "docs")).filter((name) => name.endsWith(".md")).map((name) => `docs/${name}`)];

// Markdown outside fenced code blocks, with inline code spans blanked.
function prose(markdown) {
  let fenced = false;
  return markdown.split("\n").map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return ""; }
    return fenced ? "" : line.replace(/`[^`]*`/g, (span) => " ".repeat(span.length));
  });
}

// The text between a heading and the next heading of the same or higher level.
function section(markdown, heading) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  assert.notEqual(start, -1, `missing heading ${heading}`);
  const level = heading.match(/^#+/)[0].length;
  const end = lines.findIndex((line, index) => index > start && /^#+ /.test(line) && line.match(/^#+/)[0].length <= level);
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

// GitHub's heading anchors: inline markup removed, lowercased, punctuation and
// symbols dropped (letters of every script, digits, _ and - stay), spaces to -,
// and -1, -2 ... for repeats.
function anchors(markdown) {
  const seen = new Map();
  const result = new Set();
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    const match = !fenced && line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (!match) continue;
    const text = match[1].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*]/g, "");
    const slug = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replace(/ /g, "-");
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    result.add(count ? `${slug}-${count}` : slug);
  }
  return result;
}

function tableRows(text) {
  return text.split("\n").filter((line) => line.startsWith("|") && !/^\|\s*-/.test(line))
    .map((line) => line.slice(1, line.trimEnd().endsWith("|") ? line.trimEnd().length - 1 : undefined)
      .split(/(?<!\\)\|/).map((cell) => cell.trim()));
}

const offending = (files, pattern) => files.flatMap((file) => read(file).split("\n")
  .flatMap((line, index) => pattern.test(line) ? [`${file}:${index + 1}`] : []));

test("hand-written docs make no live-run status claim", () => {
  assert.deepEqual(offending(HAND_WRITTEN, /has not yet been run live|아직 실측하지 않/), []);
});

test("README headings describe criteria, not a verified outcome", () => {
  assert.deepEqual(offending(["README.md"], /^### Verified\s*$|three passing retests/), []);
  assert.deepEqual(offending(["README_KO.md"], /^### 검증한 것\s*$/), []);
});

test("COMPATIBILITY statuses agree with the live-matrix column in both languages", () => {
  const statusKo = { "Supported": "지원함", "Supported, differs": "지원함, 차이 있음", "Expected": "예상 동작",
    "Not supported": "지원하지 않음", "Not possible": "불가능" };
  const rows = (file, heading) => tableRows(section(read(file), heading))
    .filter((cells) => cells.length === 4).slice(0);
  const en = rows("docs/COMPATIBILITY.md", "## Feature Lookup").filter(([feature]) => feature !== "Feature");
  const ko = rows("docs/COMPATIBILITY_KO.md", "## 기능별 확인").filter(([feature]) => feature !== "기능");
  assert.ok(en.length > 40, "feature rows parsed");
  assert.equal(ko.length, en.length, "EN and KO list the same features");
  en.forEach(([feature, status, , live], index) => {
    const [, statusK, , liveK] = ko[index];
    assert.ok(status in statusKo, `${feature}: unknown status ${status}`);
    assert.equal(statusK, statusKo[status], `${feature}: KO status`);
    // Expected means outside the live matrix; Not supported/possible rows have nothing to run.
    if (status === "Expected") assert.equal(live, "no", `${feature}: Expected but live-checked`);
    if (status.startsWith("Not ")) assert.equal(live, "—", `${feature}: live column`);
    if (status.startsWith("Supported")) assert.notEqual(live, "—", `${feature}: live column`);
    assert.equal(live === "no" || live.startsWith("no:"), liveK === "없음" || liveK.startsWith("없음:"), `${feature}: KO live column`);
    assert.equal(live === "—", liveK === "—", `${feature}: KO live column`);
    const scenarios = (text) => [...new Set(text.match(/\bV\d{2}\b/g) ?? [])].sort();
    assert.deepEqual(scenarios(liveK), scenarios(live), `${feature}: KO scenario references`);
  });
});

test("DIAGNOSTICS lists every bridge event the source emits", () => {
  const events = new Set();
  for (const name of fs.readdirSync(path.join(root, "src")).filter((file) => file.endsWith(".mjs"))) {
    for (const [, event] of read(`src/${name}`).matchAll(/["'`](bridge\.[a-z_]+)["'`]/g)) {
      // bridge.json, bridge.lock and bridge.log are daemon file names, not events.
      if (!/^bridge\.(json|lock|log)$/.test(event)) events.add(event);
    }
  }
  assert.ok(events.has("bridge.verify_model_state") && events.has("bridge.shutdown_forced"), "emitters found");
  for (const [file, heading] of [["docs/DIAGNOSTICS.md", "### Event reference"], ["docs/DIAGNOSTICS_KO.md", "### 이벤트 목록"]]) {
    const reference = section(read(file), heading);
    for (const event of events) assert.ok(reference.includes(`\`${event}\``), `${file} omits ${event}`);
  }
});

test("ARCHITECTURE Key Files names every src module", () => {
  const modules = fs.readdirSync(path.join(root, "src")).filter((file) => file.endsWith(".mjs"));
  for (const [file, heading] of [["docs/ARCHITECTURE.md", "## Key Files"], ["docs/ARCHITECTURE_KO.md", "## 주요 파일"]]) {
    const table = section(read(file), heading);
    for (const name of modules) assert.ok(table.includes(`src/${name}`), `${file} Key Files omits src/${name}`);
  }
});

test("every relative link and anchor in README and docs resolves", () => {
  const anchorCache = new Map();
  const anchorsOf = (file) => {
    if (!anchorCache.has(file)) anchorCache.set(file, anchors(fs.readFileSync(file, "utf8")));
    return anchorCache.get(file);
  };
  const problems = [];
  let checked = 0;
  for (const file of ALL_DOCS) {
    const source = path.join(root, file);
    for (const line of prose(read(file))) {
      for (const [, target] of line.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        checked += 1;
        const [rawPath, rawAnchor] = target.split("#");
        const resolved = rawPath ? path.resolve(path.dirname(source), decodeURIComponent(rawPath)) : source;
        if (/VERIFICATION_HISTORY/.test(rawPath)) problems.push(`${file}: links to removed ${rawPath}`);
        if (!fs.existsSync(resolved)) { problems.push(`${file}: missing ${target}`); continue; }
        if (rawAnchor !== undefined && !anchorsOf(resolved).has(decodeURIComponent(rawAnchor))) {
          problems.push(`${file}: no anchor ${target}`);
        }
      }
    }
  }
  assert.ok(checked > 100, "links found");
  assert.deepEqual(problems, []);
});

// Lines inside fenced code blocks.
const code = (markdown) => {
  let fenced = false;
  return markdown.split("\n").filter((line) => /^\s*(```|~~~)/.test(line) ? (fenced = !fenced, false) : fenced);
};
// The paragraph or list item containing needle, joined onto one line.
function block(markdown, needle) {
  const lines = markdown.split("\n");
  const at = lines.findIndex((line) => line.includes(needle));
  assert.notEqual(at, -1, `missing ${needle}`);
  const edge = (line) => !line.trim() || /^\s*(- |\||#)/.test(line);
  let start = at, end = at + 1;
  while (start > 0 && !/^\s*(- |\||#)/.test(lines[start]) && !edge(lines[start - 1])) start -= 1;
  while (end < lines.length && !edge(lines[end])) end += 1;
  return lines.slice(start, end).join(" ").replace(/\s+/g, " ");
}
const sentenceWith = (text, needle) => text.split(/(?<=\.)\s+/).find((part) => part.includes(needle)) ?? "";

test("DIAGNOSTICS says the terminal recording shows typed prompts and replies", () => {
  const en = block(read("docs/DIAGNOSTICS.md"), "`terminal-output-<launchId>.jsonl`");
  const ko = block(read("docs/DIAGNOSTICS_KO.md"), "`terminal-output-<launchId>.jsonl`");
  assert.doesNotMatch(en, /never holds[^.]*prompts/);
  assert.doesNotMatch(ko, /프롬프트[^.]*담지 않습니다/);
  assert.match(en, /typed prompt[^.]*model's replies/);
  assert.match(ko, /입력한 프롬프트[^.]*모델 응답/);
  assert.match(block(read("docs/TESTING.md"), "render-recording.mjs --spec"), /prompts and replies[^.]*not redacted/i);
  assert.match(block(read("docs/TESTING_KO.md"), "render-recording.mjs --spec"), /프롬프트와 응답은 가리지 않습니다/);
});

test("doc commands never put the bridge token or LiteLLM key in curl's arguments", () => {
  const leaks = HAND_WRITTEN.flatMap((file) => code(read(file))
    .filter((line) => /(?:-H|--header)\s+(?!@)[^\n]*\$\{?(?:GHCP_BRIDGE_TOKEN|LITELLM_API_KEY)\b/.test(line))
    .map((line) => `${file}: ${line.trim()}`));
  assert.deepEqual(leaks, []);
  for (const file of pair("LITELLM")) {
    assert.equal(code(read(file)).filter((line) => /curl [^\n]*-H @-/.test(line)).length, 3, `${file} stdin header checks`);
  }
});

test("README does not say claude-ghcp-stop removes the claude-litellm settings", () => {
  assert.doesNotMatch(read("README.md"), /claude-ghcp-stop`[^\n]*all per-launch settings files/);
  assert.doesNotMatch(read("README_KO.md"), /실행별 설정 파일을 모두 지웁니다/);
  for (const file of ["README.md", "README_KO.md"]) {
    assert.match(block(read(file), "litellm-settings"), /`claude-ghcp-stop`/, `${file} litellm-settings paragraph`);
  }
});

test("settings reaping names only the launches that reap", () => {
  const env = read(".env.example").replace(/\n#\s*/g, " ");
  assert.match(sentenceWith(env, "older than 7 days"), /other than (?:-p|print mode)|such launch/);
  const en = block(read("docs/ARCHITECTURE.md"), "| `<daemon dir>/settings/<random>.json`");
  const ko = block(read("docs/ARCHITECTURE_KO.md"), "| `<데몬 디렉터리>/settings/<random>.json`");
  assert.match(sentenceWith(en, "older than 24 hours"), /other than print mode/);
  assert.match(sentenceWith(ko, "24시간이 지난"), /print 모드가 아닌/);
});

test("bridge.shutdown_forced covers a retired bridge's own exit", () => {
  for (const file of pair("DIAGNOSTICS")) {
    assert.match(block(read(file), "| `bridge.shutdown_forced`"), /bridge\.retired_exit/, `${file} event row`);
  }
  assert.match(block(read("docs/ARCHITECTURE.md"), "**Shutdown.**"), /bridge\.retired_exit/);
  assert.match(block(read("docs/ARCHITECTURE_KO.md"), "**종료.**"), /bridge\.retired_exit/);
});

test("TESTING states the offline Python prerequisite before npm test", () => {
  for (const [file, heading, dryRun] of [
    ["docs/TESTING.md", "## Offline checks and dry-run", /`--dry-run`[^.]*does not require Python/],
    ["docs/TESTING_KO.md", "## 오프라인 검사와 dry-run", /`--dry-run`[^.]*Python이 필요하지 않습니다/],
  ]) {
    const offline = section(read(file), heading);
    assert.ok(code(offline).includes("npm test"), `${file}: offline test command`);
    const prerequisites = offline.split("```")[0].replace(/\s+/g, " ");
    for (const required of ["`npm test`", "Python 3.9", "`python3`", "PATH", "PTY"]) {
      assert.ok(prerequisites.includes(required), `${file}: ${required} before the command`);
    }
    assert.match(prerequisites, dryRun, `${file}: dry-run alone does not need Python`);
  }
});

test("TESTING keeps the recommended live command aligned and report writing optional", () => {
  const commands = [];
  for (const file of pair("TESTING")) {
    const markdown = read(file);
    const blocks = [...markdown.matchAll(/^```bash\n([\s\S]*?)^```\s*$/gm)]
      .map(([, body]) => body);
    const live = blocks.find((body) => /npm run verify --/.test(body) && !/--dry-run/.test(body));
    assert.ok(live, `${file}: live command`);
    assert.doesNotMatch(live, /CLAUDE_CODE_BIN/, `${file}: optional CLI override is separate`);
    const command = live.replace(/\\\n\s*/g, " ").trim();
    assert.match(command, /^PENDING_TOOL_WAIT_MS=30000 npm run verify --\s+--model-concurrency 1\s+--timeout-scale 2$/,
      `${file}: full recommended run, without a focused selection`);
    commands.push(command.replace(/\s+/g, " "));

    const report = blocks.find((body) => /npm run verify:report --/.test(body));
    const write = blocks.find((body) => /npm run verify:doc --/.test(body));
    assert.ok(report && write, `${file}: inspect and regenerate commands`);
    assert.notEqual(report, write, `${file}: reading must not overwrite recorded results`);
    assert.doesNotMatch(report, /verify:doc|--write-docs/, `${file}: read-only report block`);
    for (const body of [report, write]) {
      assert.match(body, /npm run verify:(?:report|doc) -- "\$run_dir"/, `${file}: explicit selected run`);
    }
  }
  assert.equal(commands[0], commands[1], "EN and KO recommend the same live options");
});

test("TESTING names every Escape purpose the verifier writes", () => {
  const sources = fs.readdirSync(path.join(root, "scripts/verify")).filter((name) => name.endsWith(".mjs"))
    .map((name) => read(`scripts/verify/${name}`));
  const purposes = new Set();
  for (const source of sources) {
    const list = source.match(/ESCAPE_PURPOSES = \[([^\]]*)\]/);
    for (const [, purpose] of list ? list[1].matchAll(/"([^"]+)"/g) : []) purposes.add(purpose);
    for (const [, purpose] of source.matchAll(/kind: "escape", purpose: "([^"]+)"/g)) purposes.add(purpose);
  }
  assert.ok(purposes.size >= 4, `found ${[...purposes]}`);
  const en = block(read("docs/TESTING.md"), "each Escape is labelled");
  const ko = block(read("docs/TESTING_KO.md"), "Escape마다");
  for (const purpose of purposes) {
    assert.ok(en.includes(`\`${purpose}\``), `TESTING.md Escape purposes lack ${purpose}`);
    assert.ok(ko.includes(`\`${purpose}\``), `TESTING_KO.md Escape purposes lack ${purpose}`);
  }
});

test("TESTING says the long-token redaction needs letters and digits", () => {
  assert.match(block(read("docs/TESTING.md"), "render-recording.mjs --spec"), /32 or more characters that contain both letters and digits/);
  assert.match(block(read("docs/TESTING_KO.md"), "render-recording.mjs --spec"), /문자와 숫자를 모두 포함한 32자 이상/);
});

test("identity_stale covers a forgotten family record and the PTY helper names Python 3.9", () => {
  const source = read("src/session-manager.mjs");
  assert.match(source, /const MAX_FAMILY_TURNS = 16;/);
  assert.match(source, /since < family\.floor/);
  assert.match(block(read("docs/DIAGNOSTICS.md"), "| `bridge.history_reconciled`"), /more than 16 other states/);
  assert.match(block(read("docs/DIAGNOSTICS_KO.md"), "| `bridge.history_reconciled`"), /16개 넘게/);
  assert.match(block(read("docs/ARCHITECTURE.md"), "Native interaction uses"), /Python 3\.9 or newer/);
  assert.match(block(read("docs/ARCHITECTURE_KO.md"), "native 조작에는"), /Python 3\.9 이상/);
});
