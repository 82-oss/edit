// A small MP4 laid out as our proxies are (H.264 + AAC, faststart, half-second keyframes) whose bitrate isn't a
// straight line: 3 s of a still grey (a few KB a second) then 3 s of noise (megabytes a second), and ffprobe's
// own word on every packet, to check the index against.

import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

export const ffmpeg = Bun.which("ffmpeg");
export const ffprobe = Bun.which("ffprobe");

export interface Packet {
  stream: number;
  pts: number;
  pos: number;
  size: number;
  key: boolean;
}

/** Makes the file (`bframes`: B-frames, so presentation and decode order differ; `faststart` false: its index at its end). */
export function makeVbr(options: { bframes?: number; faststart?: boolean } = {}): { path: string; bytes: Uint8Array; packets: Packet[]; cleanup(): void } {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "edit-vbr-"));
  const path = join(dir, "vbr.mp4");
  const made = Bun.spawnSync([
    ffmpeg!, "-v", "error", "-y",
    "-f", "lavfi", "-i", "color=c=gray:s=640x360:r=30:d=3",
    "-f", "lavfi", "-i", "nullsrc=s=640x360:r=30:d=3,geq=random(1)*255:128:128",
    "-f", "lavfi", "-i", "sine=f=440:d=6",
    "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-map", "2:a",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-g", "15", "-bf", `${options.bframes ?? 0}`, "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k",
    ...(options.faststart === false ? [] : ["-movflags", "+faststart"]),
    path,
  ]);
  if (made.exitCode !== 0) throw new Error(made.stderr.toString());
  const probed = Bun.spawnSync([ffprobe!, "-v", "error", "-show_entries", "packet=stream_index,pts_time,pos,size,flags", "-of", "csv=p=0", path]).stdout.toString().trim();
  const packets = probed.split("\n").map((line) => {
    const [stream, pts, size, pos, flags] = line.split(",");
    return { stream: Number(stream), pts: Number(pts), pos: Number(pos), size: Number(size), key: (flags ?? "").startsWith("K") };
  });
  return { path, bytes: new Uint8Array(fs.readFileSync(path)), packets, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
