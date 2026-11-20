// Puts what the rented CPU machines run on R2 (apps/relay/src/remover.ts RUNTIME): Edit's engine (the Linux addon,
// built for current x86: `RUSTFLAGS="-C target-cpu=x86-64-v3" cargo build --release -p edit-native`, ~20% fewer
// cycles on the watermark engine, Nov 20) and Edit's FFmpeg and FFprobe. Run under the relay's env (its R2):
//
//   infisical run --projectId=979fe56c-c4d0-4809-b64f-5ebc75eeaf05 --env=prod --path=/edit-relay -- \
//     bun app/scripts/remover-runpod/runtime.ts <libedit_native.so> <edit-ffmpeg> <edit-ffprobe>
//
// A new engine goes to a new folder (RUNTIME's date), so machines already running keep theirs.
import { S3Client } from "bun";

import { RUNTIME } from "../../apps/relay/src/remover_runtime.ts";

const [addon, ffmpeg, ffprobe] = process.argv.slice(2);
if (!addon || !ffmpeg || !ffprobe) throw new Error("bun runtime.ts <libedit_native.so> <edit-ffmpeg> <edit-ffprobe>");
const e = process.env;
const s3 = new S3Client({ accessKeyId: e.R2_ACCESS_KEY_ID!, secretAccessKey: e.R2_SECRET_ACCESS_KEY!, bucket: e.R2_BUCKET!, endpoint: `https://${e.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` });
// Gzipped (163 MB, not 412, Nov 20): quicker up, and quicker to every machine that boots.
for (const [name, file] of [["edit-native.node", addon], ["edit-ffmpeg", ffmpeg], ["edit-ffprobe", ffprobe]] as const) {
  const key = `${RUNTIME}/${name}.gz`;
  await s3.write(key, Bun.gzipSync(await Bun.file(file).bytes(), { level: 6 }));
  console.log(`${key}: ${((await s3.file(key).stat()).size / 1e6).toFixed(1)} MB`);
}
