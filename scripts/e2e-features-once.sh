#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL="${GHCP_E2E_MODEL:-claude-haiku-4.5}"
MULTIMODAL_MODEL="${GHCP_E2E_MULTIMODAL_MODEL:-claude-sonnet-5}"
MCP_MODEL="${GHCP_E2E_MCP_MODEL:-claude-sonnet-5}"
SETTINGS_PATH="${HOME}/.claude/settings.json"
PROJECT="$(mktemp -d "${TMPDIR:-/tmp}/claude-ghcp-features.XXXXXX")"
CONFIG_DIR="$PROJECT/claude-config"
PLUGIN="$PROJECT/e2e-plugin"
FIXTURE="$PROJECT/feature.txt"
WRITTEN="$PROJECT/written.txt"
NOTEBOOK="$PROJECT/notebook.ipynb"
HOOK_LOG="$PROJECT/hook.log"
IMAGE="$PROJECT/pixel.png"
PDF="$PROJECT/document.pdf"
IMAGE_INPUT="$PROJECT/image-input.jsonl"
PDF_INPUT="$PROJECT/pdf-input.jsonl"
MARKER="CLAUDE_CODE_GHCP_FEATURE_E2E_OK"
CALL_TIMEOUT_SECONDS="${GHCP_E2E_CALL_TIMEOUT_SECONDS:-120}"

run_claude() {
  node "$ROOT_DIR/scripts/run-with-timeout.mjs" \
    "$CALL_TIMEOUT_SECONDS" "$@"
}

step() {
  printf 'FEATURE_E2E_STEP=%s\n' "$1" >&2
}

cleanup() {
  rm -rf "$PROJECT"
}
trap cleanup EXIT

mkdir -p "$PROJECT/.claude/skills/e2e-skill"
mkdir -p "$CONFIG_DIR"
mkdir -p "$PLUGIN/.claude-plugin" "$PLUGIN/skills/plugin-e2e"
printf '%s\n' 'before' >"$FIXTURE"
cat >"$NOTEBOOK" <<'JSON'
{
  "cells": [
    {
      "cell_type": "markdown",
      "metadata": {},
      "source": ["before"]
    }
  ],
  "metadata": {},
  "nbformat": 4,
  "nbformat_minor": 5
}
JSON
node -e '
  const fs = require("node:fs");
  const zlib = require("node:zlib");
  const table = Array.from({ length: 256 }, (_, value) => {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return crc >>> 0;
  });
  const crc32 = (buffer) => {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const name = Buffer.from(type);
    const body = Buffer.concat([name, data]);
    const output = Buffer.alloc(data.length + 12);
    output.writeUInt32BE(data.length, 0);
    body.copy(output, 4);
    output.writeUInt32BE(crc32(body), data.length + 8);
    return output;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  fs.writeFileSync(process.argv[1], Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    chunk("IEND", Buffer.alloc(0)),
  ]));
' "$IMAGE"
node -e '
  const fs = require("node:fs");
  const stream = "BT /F1 12 Tf 72 720 Td (PDF_E2E_CONTENT) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(process.argv[1], pdf);
' "$PDF"
node -e '
  const fs = require("node:fs");
  const [image, output] = process.argv.slice(1);
  const message = {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: "Return only the dominant color as one lowercase English word.",
        },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: fs.readFileSync(image).toString("base64"),
          },
        },
      ],
    },
  };
  fs.writeFileSync(output, `${JSON.stringify(message)}\n`);
' "$IMAGE" "$IMAGE_INPUT"
node -e '
  const fs = require("node:fs");
  const [pdf, output] = process.argv.slice(1);
  const message = {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: "Return only the exact all-caps token printed in the document.",
        },
        {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: fs.readFileSync(pdf).toString("base64"),
          },
        },
      ],
    },
  };
  fs.writeFileSync(output, `${JSON.stringify(message)}\n`);
' "$PDF" "$PDF_INPUT"
cat >"$CONFIG_DIR/settings.json" <<'JSON'
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit",
        "hooks": [
          {
            "type": "command",
            "command": "printf HOOK_E2E_OK >> \"$HOOK_LOG\""
          }
        ]
      }
    ]
  }
}
JSON
cat >"$PROJECT/.claude/skills/e2e-skill/SKILL.md" <<'MARKDOWN'
---
name: e2e-skill
description: Returns a deterministic compatibility marker.
---

Reply with exactly SKILL_E2E_OK.
MARKDOWN
cat >"$PLUGIN/.claude-plugin/plugin.json" <<'JSON'
{
  "name": "ghcp-e2e-plugin",
  "version": "1.0.0",
  "description": "Deterministic compatibility fixture"
}
JSON
cat >"$PLUGIN/skills/plugin-e2e/SKILL.md" <<'MARKDOWN'
---
name: plugin-e2e
description: Returns a deterministic plugin marker.
---

Reply with exactly PLUGIN_E2E_OK.
MARKDOWN
cat >"$PROJECT/.mcp.json" <<JSON
{
  "mcpServers": {
    "e2e": {
      "command": "$(command -v node)",
      "args": ["$ROOT_DIR/test/fixtures/mcp-echo-server.mjs"]
    }
  }
}
JSON

BEFORE_SETTINGS_STATE="$(
  node "$ROOT_DIR/src/settings-file-state.mjs" "$SETTINGS_PATH"
)"
export CLAUDE_CONFIG_DIR="$CONFIG_DIR"

SCHEMA='{"type":"object","properties":{"status":{"const":"STRUCTURED_E2E_OK"},"value":{"const":42}},"required":["status","value"],"additionalProperties":false}'
step structured
STRUCTURED_OUTPUT="$(
  cd "$PROJECT"
  run_claude "$ROOT_DIR/bin/claude-ghcp" \
    --ghcp-model "$MODEL" \
    -p \
    --no-session-persistence \
    --output-format json \
    --json-schema "$SCHEMA" \
    'Return status STRUCTURED_E2E_OK and numeric value 42 using the required schema.'
)"
node -e '
  const value = JSON.parse(process.argv[1]).structured_output;
  if (value?.status !== "STRUCTURED_E2E_OK" || value?.value !== 42) process.exit(1);
' "$STRUCTURED_OUTPUT"

step edit_hook
(
  cd "$PROJECT"
  export HOOK_LOG
  run_claude "$ROOT_DIR/bin/claude-ghcp" \
    --ghcp-model "$MODEL" \
    -p \
    --no-session-persistence \
    --allowedTools Edit Read \
    --permission-mode acceptEdits \
    "Use Edit to replace the entire contents of $FIXTURE with exactly: $MARKER"
) >/dev/null
grep -Fx "$MARKER" "$FIXTURE" >/dev/null
HOOK_OK=0
for _ in {1..50}; do
  if [[ -f "$HOOK_LOG" ]] && grep -F "HOOK_E2E_OK" "$HOOK_LOG" >/dev/null; then
    HOOK_OK=1
    break
  fi
  sleep 0.1
done
[[ "$HOOK_OK" == "1" ]]

step write
(
  cd "$PROJECT"
  run_claude "$ROOT_DIR/bin/claude-ghcp" \
    --ghcp-model "$MODEL" \
    -p \
    --no-session-persistence \
    --allowedTools Write \
    --permission-mode acceptEdits \
    "Use Write to create $WRITTEN with exactly WRITE_E2E_OK"
) >/dev/null
grep -Fx "WRITE_E2E_OK" "$WRITTEN" >/dev/null

step notebook
(
  cd "$PROJECT"
  run_claude "$ROOT_DIR/bin/claude-ghcp" \
    --ghcp-model "$MODEL" \
    -p \
    --no-session-persistence \
    --allowedTools NotebookEdit \
    --permission-mode acceptEdits \
    "Use NotebookEdit to replace the source of cell 0 in $NOTEBOOK with exactly NOTEBOOK_E2E_OK"
) >/dev/null
grep -F "NOTEBOOK_E2E_OK" "$NOTEBOOK" >/dev/null

step bash
BASH_OUTPUT="$(
  cd "$PROJECT"
  run_claude "$ROOT_DIR/bin/claude-ghcp" \
    --ghcp-model "$MODEL" \
    -p \
    --no-session-persistence \
    --output-format stream-json \
    --verbose \
    --allowedTools Bash \
    --permission-mode dontAsk \
    'Use Bash to run printf BASH_E2E_OK, then return only its stdout.'
)"
node -e '
  const events = process.argv[1].split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const usedBash = events.some((event) =>
    event.type === "assistant" &&
    event.message?.content?.some((block) =>
      block.type === "tool_use" && block.name === "Bash"
    )
  );
  const returnedMarker = events.some((event) =>
    event.type === "user" &&
    JSON.stringify(event.message?.content || "").includes("BASH_E2E_OK")
  );
  if (!usedBash || !returnedMarker) process.exit(1);
' "$BASH_OUTPUT"

step skill
SKILL_OUTPUT="$(
  cd "$PROJECT"
  run_claude "$ROOT_DIR/bin/claude-ghcp" \
    --ghcp-model "$MODEL" \
    -p \
    --no-session-persistence \
    '/e2e-skill'
)"
grep -F "SKILL_E2E_OK" <<<"$SKILL_OUTPUT" >/dev/null

step plugin
PLUGIN_OUTPUT="$(
  cd "$PROJECT"
  run_claude "$ROOT_DIR/bin/claude-ghcp" \
    --ghcp-model "$MODEL" \
    -p \
    --no-session-persistence \
    --plugin-dir "$PLUGIN" \
    '/plugin-e2e'
)"
grep -F "PLUGIN_E2E_OK" <<<"$PLUGIN_OUTPUT" >/dev/null

step mcp_tool_search
MCP_OUTPUT="$(
  cd "$PROJECT"
  run_claude "$ROOT_DIR/bin/claude-ghcp" \
    --ghcp-model "$MCP_MODEL" \
    -p \
    --no-session-persistence \
    --allowedTools 'mcp__e2e__*' \
    --permission-mode dontAsk \
    'Use the e2e MCP tool named echo_34 and return only its result.'
)"
grep -F "MCP_E2E_OK" <<<"$MCP_OUTPUT" >/dev/null

step plan
PLAN_OUTPUT="$(
  cd "$PROJECT"
  run_claude "$ROOT_DIR/bin/claude-ghcp" \
    --ghcp-model "$MODEL" \
    -p \
    --no-session-persistence \
    --output-format stream-json \
    --verbose \
    --allowedTools Read \
    --permission-mode plan \
    "Use Read to inspect $FIXTURE without modifying it, then return exactly PLAN_E2E_OK."
)"
node -e '
  const events = process.argv[1].split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const usedRead = events.some((event) =>
    event.type === "assistant" &&
    event.message?.content?.some((block) =>
      block.type === "tool_use" && block.name === "Read"
    )
  );
  const returnedFixture = events.some((event) =>
    event.type === "user" &&
    JSON.stringify(event.message?.content || "").includes(process.argv[2])
  );
  if (!usedRead || !returnedFixture) process.exit(1);
' "$PLAN_OUTPUT" "$MARKER"
grep -Fx "$MARKER" "$FIXTURE" >/dev/null

step subagent
AGENT_OUTPUT="$(
  cd "$PROJECT"
  run_claude "$ROOT_DIR/bin/claude-ghcp" \
    --ghcp-model "$MODEL" \
    -p \
    --no-session-persistence \
    --output-format stream-json \
    --verbose \
    --allowedTools Agent Read \
    --permission-mode dontAsk \
    "Use one general-purpose Agent. Tell it to Read $FIXTURE and return only the contents. Return only the subagent result."
)"
node -e '
  const events = process.argv[1].split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const toolUses = events.flatMap((event) =>
    event.type === "assistant"
      ? (event.message?.content || [])
          .filter((block) => block.type === "tool_use")
          .map((block) => ({
            name: block.name,
            nested: Boolean(event.parent_tool_use_id),
          }))
      : []
  );
  const usedAgent = toolUses.some((tool) => tool.name === "Agent" && !tool.nested);
  const nestedRead = toolUses.some((tool) => tool.name === "Read" && tool.nested);
  const returnedSecret = events.some((event) =>
    event.type === "user" &&
    JSON.stringify(event.message?.content || "").includes(process.argv[2])
  );
  if (!usedAgent || !nestedRead || !returnedSecret) {
    process.exit(1);
  }
' "$AGENT_OUTPUT" "$MARKER"

step image
IMAGE_OK=0
for _ in 1 2 3; do
  if ! IMAGE_OUTPUT="$(
    cd "$PROJECT"
    run_claude "$ROOT_DIR/bin/claude-ghcp" \
      --ghcp-model "$MULTIMODAL_MODEL" \
      -p \
      --no-session-persistence \
      --input-format stream-json \
      --output-format stream-json \
      --verbose <"$IMAGE_INPUT"
  )"; then
    continue
  fi
  if node -e '
    const events = process.argv[1].split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const result = events.findLast((event) => event.type === "result");
    if (!/\b(red|pink)\b/i.test(result?.result || "")) process.exit(1);
  ' "$IMAGE_OUTPUT"; then
    IMAGE_OK=1
    break
  fi
done
[[ "$IMAGE_OK" == "1" ]]

step pdf
PDF_OK=0
for _ in 1 2 3; do
  if ! PDF_OUTPUT="$(
    cd "$PROJECT"
    run_claude "$ROOT_DIR/bin/claude-ghcp" \
      --ghcp-model "$MULTIMODAL_MODEL" \
      -p \
      --no-session-persistence \
      --input-format stream-json \
      --output-format stream-json \
      --verbose <"$PDF_INPUT"
  )"; then
    continue
  fi
  if node -e '
    const events = process.argv[1].split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const result = events.findLast((event) => event.type === "result");
    if (!result?.result?.includes("PDF_E2E_CONTENT")) process.exit(1);
  ' "$PDF_OUTPUT"; then
    PDF_OK=1
    break
  fi
done
[[ "$PDF_OK" == "1" ]]

step cron
CRON_OUTPUT="$(
  cd "$PROJECT"
  run_claude "$ROOT_DIR/bin/claude-ghcp" \
    --ghcp-model "$MODEL" \
    -p \
    --no-session-persistence \
    --output-format stream-json \
    --verbose \
    --allowedTools CronCreate CronList CronDelete \
    --permission-mode dontAsk \
    'Create a temporary */10 * * * * scheduled task, list it, delete it immediately, verify the list is empty, then return exactly CRON_E2E_OK.'
)"
node -e '
  const events = process.argv[1].split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const tools = events.flatMap((event) =>
    event.type === "assistant"
      ? (event.message?.content || [])
          .filter((block) => block.type === "tool_use")
          .map((block) => block.name)
      : []
  );
  const result = events.findLast((event) => event.type === "result");
  for (const required of ["CronCreate", "CronList", "CronDelete"]) {
    if (!tools.includes(required)) process.exit(1);
  }
  if (!result?.result?.includes("CRON_E2E_OK")) process.exit(1);
' "$CRON_OUTPUT"

AFTER_SETTINGS_STATE="$(
  node "$ROOT_DIR/src/settings-file-state.mjs" "$SETTINGS_PATH"
)"
[[ "$BEFORE_SETTINGS_STATE" == "$AFTER_SETTINGS_STATE" ]] || {
  echo "Claude user settings state changed during feature E2E." >&2
  exit 1
}

printf 'PASS model=%s multimodal_model=%s mcp_model=%s structured=true edit=true write=true notebook=true bash=true hook=true skill=true plugin=true mcp=true plan=true subagent=true image=true pdf=true cron=true settings_unchanged=true\n' "$MODEL" "$MULTIMODAL_MODEL" "$MCP_MODEL"
