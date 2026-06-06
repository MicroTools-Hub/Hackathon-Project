import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [];

function collect(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") collect(full);
    if (entry.isFile() && entry.name.endsWith(".js")) files.push(full);
  }
}

collect(root);

for (const file of files) {
  if (file.endsWith("scripts\\check-modules.js") || file.endsWith("scripts/check-modules.js")) continue;
  if (file.endsWith("\\index.js") || file.endsWith("/index.js")) continue;
  await import(`file://${file.replaceAll("\\", "/")}`);
}

console.log(`Imported ${files.length} backend modules`);
