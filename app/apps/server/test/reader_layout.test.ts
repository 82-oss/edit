// The loopback reader's first look at a file (its size and index, `layoutOf`) has a time limit: a cloud that took the
// request and never answered held every cut of that file waiting for good (Nov 21 audit).

import { expect, test } from "bun:test";
import * as http from "node:http";

import * as cloudMedia from "../src/cloud_media.ts";

test("a cloud that never answers the reader's look at a file ends that read, rather than holding it for good", async () => {
  const silent = http.createServer(() => {});
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const port = (silent.address() as { port: number }).port;
  const before = cloudMedia.readerTiming.layoutMs;
  cloudMedia.readerTiming.layoutMs = 200;
  try {
    const reader = await cloudMedia.readerFor({ key: "edit/originals/test/never/a.mp4", name: "a.mp4" } as Parameters<typeof cloudMedia.readerFor>[0], `http://127.0.0.1:${port}/never.mp4`);
    try {
      // Ended without footage (the connection dropped: FFmpeg reads again), never left waiting.
      const read = fetch(reader.url, { headers: { range: "bytes=0-" } }).then(
        async (answer) => (answer.status === 206 ? "footage" : (await answer.arrayBuffer().catch(() => null), "ended")),
        () => "ended",
      );
      expect(await Promise.race([read, Bun.sleep(3_000).then(() => "still waiting")])).toBe("ended");
    } finally {
      reader.release();
    }
  } finally {
    cloudMedia.readerTiming.layoutMs = before;
    silent.closeAllConnections();
    silent.close();
  }
});
