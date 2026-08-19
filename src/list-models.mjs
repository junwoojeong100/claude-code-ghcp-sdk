import os from "node:os";
import path from "node:path";

import { CopilotClient } from "@github/copilot-sdk";

import { adapterModels } from "./model-map.mjs";

const json = process.argv.includes("--json");
const all = process.argv.includes("--all");
const configuredHome = process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
const baseDirectory = configuredHome.startsWith("~/")
  ? path.join(os.homedir(), configuredHome.slice(2))
  : path.resolve(configuredHome);
const client = new CopilotClient({
  mode: "empty",
  baseDirectory,
  logLevel: "error",
});

try {
  await client.start();
  const models = await client.listModels();
  const selected = all ? models : adapterModels(models);

  if (json) {
    console.log(JSON.stringify(selected, null, 2));
  } else {
    for (const model of selected) {
      const status = model.policy?.state || model.releaseStatus || "";
      console.log([model.id, model.name || "", status].filter(Boolean).join("\t"));
    }
  }
} finally {
  await client.stop().catch(() => {});
}
