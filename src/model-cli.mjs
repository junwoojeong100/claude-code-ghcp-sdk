import { frontendModelFor } from "./model-map.mjs";

const [command, value] = process.argv.slice(2);
if (command !== "frontend" || !value) {
  console.error("Usage: node src/model-cli.mjs frontend <copilot-model-id>");
  process.exit(2);
}
console.log(frontendModelFor(value));
