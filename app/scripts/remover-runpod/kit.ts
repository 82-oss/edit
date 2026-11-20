// Writes apps/relay/src/remover_kit.ts: bootstrap.sh and pod.py as base64, which the relay puts in each pod it rents
// (remover.ts), so a pod runs exactly what this commit has and nothing it reads expires.
//
//   bun app/scripts/remover-runpod/kit.ts           write it
//   bun app/scripts/remover-runpod/kit.ts --check   fail if it's out of date (CI)
import * as fs from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const OUT = join(HERE, "../../apps/relay/src/remover_kit.ts");
const b64 = (file: string) => Buffer.from(fs.readFileSync(join(HERE, file))).toString("base64");
const text = `// Made by app/scripts/remover-runpod/kit.ts from bootstrap.sh and pod.py: don't edit by hand.
export const BOOTSTRAP_B64 = "${b64("bootstrap.sh")}";
export const POD_B64 = "${b64("pod.py")}";
`;
if (process.argv.includes("--check")) {
  if (!fs.existsSync(OUT) || fs.readFileSync(OUT, "utf8") !== text) {
    console.error("apps/relay/src/remover_kit.ts is out of date: bun app/scripts/remover-runpod/kit.ts");
    process.exit(1);
  }
} else {
  fs.writeFileSync(OUT, text);
  console.log(`wrote ${OUT}`);
}
