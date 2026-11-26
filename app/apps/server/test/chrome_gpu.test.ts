import { afterEach, expect, test } from "bun:test";

import * as devtools from "../src/chrome_devtools.ts";

// Linux: headless Chrome draws on Vulkan only where it can (chrome_devtools.ts `gpuChecked`). Where it can't
// (mandalorian under WSL, Nov 25: no Vulkan driver for its NVIDIA card), `--use-angle=vulkan` left Chrome with no
// WebGL at all and every map effect failed "The browser supports WebGL, but initialization failed".

const asked = devtools.gpuHooks.webglOnVulkan;

afterEach(() => {
  devtools.gpuHooks.webglOnVulkan = asked;
  devtools.gpuHooks.vulkan = null;
});

const angle = (command: string[] | null) => (command ?? []).filter((one) => one.startsWith("--use-angle"));

test.if(process.platform === "linux")("a Chrome that draws on the card leaves out Vulkan where it gives no WebGL, and asks once", async () => {
  let asks = 0;
  devtools.gpuHooks.webglOnVulkan = async () => {
    asks++;
    return false;
  };
  await Promise.all([devtools.gpuChecked(), devtools.gpuChecked()]);
  await devtools.gpuChecked();
  expect(asks).toBe(1);
  if (devtools.headlessBinary() === null) return;
  expect(angle(devtools.headlessCommand(["about:blank"], { gpu: true }))).toEqual([]);
});

test.if(process.platform === "linux")("where Vulkan draws, or it can't be told, a Chrome on the card draws on Vulkan", async () => {
  devtools.gpuHooks.webglOnVulkan = async () => {
    throw new Error("no answer");
  };
  await devtools.gpuChecked();
  expect(devtools.gpuHooks.vulkan).toBe(true);
  if (devtools.headlessBinary() === null) return;
  expect(angle(devtools.headlessCommand(["about:blank"], { gpu: true }))).toEqual(["--use-angle=vulkan"]);
});

test.if(process.platform === "linux" && devtools.headlessBinary() !== null)("the real question gets an answer from this computer's Chrome", async () => {
  const vulkan = await asked();
  expect(typeof vulkan).toBe("boolean");
  console.log(`this computer's Chrome draws WebGL on Vulkan: ${vulkan}`);
}, 30_000);

// The question can answer yes: Chrome draws WebGL on the CPU (SwiftShader) wherever it runs. Matching the whole dumped
// DOM found the page's own "GL:no" and answered no everywhere (PR #14's Codex review).
test.if(process.platform === "linux" && devtools.headlessBinary() !== null)("a page that draws is read as drawn", async () => {
  expect(await devtools.webglDraws([])).toBe(true);
}, 30_000);
