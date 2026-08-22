import { CopilotClient } from "@github/copilot-sdk";

import { resolveCopilotHome } from "./copilot-home.mjs";
import { adapterModels } from "./model-map.mjs";

const json = process.argv.includes("--json");
const all = process.argv.includes("--all");
const client = new CopilotClient({
  mode: "empty",
  baseDirectory: resolveCopilotHome(process.env.COPILOT_HOME),
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
