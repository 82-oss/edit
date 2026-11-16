// A one-off measurement (Nov 16, CI speed): where a look's frame goes on CI's Mac, with and without the graphics card.
// bun scripts/chrome-probe.ts. Removed once read.
import * as devtools from "../apps/server/src/chrome_devtools.ts";

const page = (width: number, height: number) =>
  `data:text/html,${encodeURIComponent(`<!doctype html><body style="margin:0;background:#222"><canvas id="c" width="${width}" height="${height}"></canvas><script>
const c = document.getElementById("c").getContext("2d");
window.seek = (t) => { c.fillStyle = "#222"; c.fillRect(0, 0, ${width}, ${height}); c.fillStyle = "#fff"; c.font = "${Math.round(height / 3)}px monospace"; c.fillText(String(Math.round(t * 30)), 40, ${Math.round(height / 2)}); };
</script></body>`)}`;

async function timed<T>(work: () => Promise<T>): Promise<[T, number]> {
  const began = performance.now();
  const value = await work();
  return [value, performance.now() - began];
}

for (const gpu of [true, false]) {
  for (const [width, height] of [
    [640, 360],
    [1920, 1080],
  ] as const) {
    const [tab, launch] = await timed(() => devtools.open({ profile: "edit-probe-", width, height, gpu, what: "Probing" }));
    try {
      await tab.call("Page.navigate", { url: page(width, height) });
      await Bun.sleep(500);
      const sums = { seek6: 0, shot: 0, jpeg: 0 };
      const n = 10;
      for (let frame = 0; frame < n; frame++) {
        const t = frame / 30;
        sums.seek6 += (await timed(() => tab.evaluate(`(() => { for (let i = 0; i < 6; i++) window.seek(${t} + i / 30); })()`)))[1];
        const [shot, took] = await timed(() => tab.call("Page.captureScreenshot", { format: "png", optimizeForSpeed: true, clip: { x: 0, y: 0, width, height, scale: 1 } }));
        sums.shot += took;
        const data = shot.data as string;
        sums.jpeg += (
          await timed(() =>
            tab.evaluate(`(async () => { const bytes = Uint8Array.from(atob(${JSON.stringify(data)}), (c) => c.charCodeAt(0)); const shot = await createImageBitmap(new Blob([bytes], { type: "image/png" })); const canvas = new OffscreenCanvas(shot.width, shot.height); const ctx = canvas.getContext("2d"); ctx.drawImage(shot, 0, 0); ctx.getImageData(0, 0, shot.width, shot.height); return (await canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 })).size; })()`),
          )
        )[1];
      }
      console.log(`probe gpu=${gpu} ${width}x${height}: launch ${launch.toFixed(0)} ms; a frame: 6 seeks ${(sums.seek6 / n).toFixed(0)} ms, screenshot ${(sums.shot / n).toFixed(0)} ms, png→jpeg ${(sums.jpeg / n).toFixed(0)} ms`);
    } finally {
      tab.close();
    }
  }
}
process.exit(0);
