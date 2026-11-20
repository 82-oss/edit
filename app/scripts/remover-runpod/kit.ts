// Writes apps/relay/src/remover_kit.ts: the GPU's bootstrap.sh and pod.py, the CPU machines' bootstrap_cpu.sh and cpu.ts
// (bundled with Edit's text_track.ts), as base64, which the relay puts in each machine it rents
// (remover.ts), so a pod runs exactly what this commit has and nothing it reads expires.
//
//   bun app/scripts/remover-runpod/kit.ts           write it
//   bun app/scripts/remover-runpod/kit.ts --check   fail if it's out of date (CI)
import * as fs from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const OUT = join(HERE, "../../apps/relay/src/remover_kit.ts");
const b64 = (file: string) => Buffer.from(fs.readFileSync(join(HERE, file))).toString("base64");
// cpu.ts bundled with Edit's own text_track.ts (one file, nothing to install but Bun).
// From app/, so it comes out the same wherever it's run from (the bundle names its files from the working folder).
process.chdir(join(HERE, "../.."));
const built = await Bun.build({ entrypoints: [join(HERE, "cpu.ts")], target: "bun", minify: false });
if (!built.success) throw new Error(`cpu.ts didn't bundle: ${built.logs.join("; ")}`);
const cpu = Buffer.from(await built.outputs[0]!.text()).toString("base64");
const text = `// Made by app/scripts/remover-runpod/kit.ts from bootstrap.sh, pod.py, bootstrap_cpu.sh and cpu.ts: don't edit by hand.
export const BOOTSTRAP_B64 = "${b64("bootstrap.sh")}";
export const POD_B64 = "${b64("pod.py")}";
export const CPU_BOOT_B64 = "${b64("bootstrap_cpu.sh")}";
export const CPU_B64 = "${cpu}";
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
