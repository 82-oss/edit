import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

import * as devtools from "../src/chrome_devtools.ts";
import * as seams from "../src/seams.ts";

// Edit's own headless shell on a Mac (chrome_devtools.ts): fetched from Chrome for Testing's index, checked against
// the MD5 Google's storage gives and its own signature, then the Chrome every headless start runs, with no
// `--headless` switch (Sphe's M4, Nov 17: Google Chrome started headless popped into the Dock with each look).

const work = fs.mkdtempSync(join(os.tmpdir(), "chrome-shell-"));
const wanted = devtools.shellHooks.wanted;
const index = devtools.shellHooks.index;
const verify = devtools.shellHooks.verify;

/** A zip shaped like Chrome for Testing's: the shell program in its platform's folder. */
function shellZip(name: string): Uint8Array {
  const dir = join(work, `zip-${name}`);
  const inner = join(dir, `chrome-headless-shell-${devtools.SHELL_PLATFORM}`);
  fs.mkdirSync(inner, { recursive: true });
  fs.writeFileSync(join(inner, "chrome-headless-shell"), "#!/bin/sh\n", { mode: 0o755 });
  const zip = join(work, `${name}.zip`);
  const made = Bun.spawnSync(["zip", "-qr", zip, "."], { cwd: dir });
  if (made.exitCode !== 0) throw new Error(made.stderr.toString());
  return new Uint8Array(fs.readFileSync(zip));
}

const zips = new Map<string, { bytes: Uint8Array; md5: string }>();
let stable = "157.0.8103.78";
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  for (const version of ["157.0.8103.78", "158.0.1.2"]) {
    const bytes = shellZip(version);
    zips.set(version, { bytes, md5: createHash("md5").update(bytes).digest("base64") });
  }
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/index.json") {
        const download = (platform: string) => ({ platform, url: `http://127.0.0.1:${server.port}/${stable}/${platform}.zip` });
        return Response.json({ channels: { Stable: { version: stable, downloads: { "chrome-headless-shell": [download("linux64"), download(devtools.SHELL_PLATFORM)] } } } });
      }
      const [, version, file] = url.pathname.split("/");
      const zip = zips.get(version ?? "");
      if (zip === undefined || file !== `${devtools.SHELL_PLATFORM}.zip`) return new Response("no", { status: 404 });
      const md5 = url.searchParams.has("wrong") || request.headers.get("x-wrong") !== null ? "AAAAAAAAAAAAAAAAAAAAAA==" : zip.md5;
      return new Response(zip.bytes, { headers: { "x-goog-hash": `crc32c=mA15+Q==,md5=${md5}` } });
    },
  });
  devtools.shellHooks.wanted = true;
  devtools.shellHooks.index = `http://127.0.0.1:${server.port}/index.json`;
});

afterEach(() => {
  devtools.shellHooks.verify = async () => null;
  stable = "157.0.8103.78";
});

afterAll(() => {
  devtools.shellHooks.wanted = wanted;
  devtools.shellHooks.index = index;
  devtools.shellHooks.verify = verify;
  // No shell left as this run's Chrome for the files after it.
  devtools.findShell(join(work, "none"));
  void server.stop(true);
  fs.rmSync(work, { recursive: true, force: true });
});

test("the shell is fetched, checked and unpacked once, becomes the headless Chrome with no --headless switch, and a newer stable replaces it", async () => {
  devtools.shellHooks.verify = async () => null;
  const home = join(work, "home");
  devtools.findShell(home);
  // Nothing there yet: Google Chrome (or none) until the fetch is done.
  expect(devtools.headlessBinary()).toBe(seams.broll.chrome());
  const path = await devtools.fetchShell(home);
  expect(path).toBe(join(home, "bin", "chrome-headless-shell", "157.0.8103.78", `chrome-headless-shell-${devtools.SHELL_PLATFORM}`, "chrome-headless-shell"));
  expect(fs.existsSync(path!)).toBe(true);
  expect(devtools.headlessBinary()).toBe(path);
  const command = devtools.headlessCommand(["--user-data-dir=/x", "about:blank"], { gpu: true })!;
  expect(command[0]).toBe(path!);
  expect(command).not.toContain("--headless=new");
  expect(command.at(-1)).toBe("about:blank");
  // Nothing of the download left beside it.
  expect(fs.readdirSync(join(home, "bin", "chrome-headless-shell")).sort()).toEqual(["157.0.8103.78", "checked"]);

  // A later start finds it without fetching.
  devtools.findShell(join(work, "none"));
  devtools.prepareShell(home);
  expect(devtools.headlessBinary()).toBe(path);

  // Chrome's next stable: fetched, and the old one (no Chrome runs from it) removed.
  stable = "158.0.1.2";
  const newer = await devtools.fetchShell(home);
  expect(newer).toContain("/158.0.1.2/");
  expect(devtools.headlessBinary()).toBe(newer);
  expect(fs.readdirSync(join(home, "bin", "chrome-headless-shell")).sort()).toEqual(["158.0.1.2", "checked"]);
});

test("a download that doesn't match Google's checksum, or isn't the shell, is never used", async () => {
  const home = join(work, "refused");
  devtools.findShell(home);
  devtools.shellHooks.verify = async () => "it isn't Chrome's headless shell";
  await expect(devtools.fetchShell(home)).rejects.toThrow("it isn't Chrome's headless shell");
  expect(devtools.headlessBinary()).toBe(seams.broll.chrome());
  expect(fs.readdirSync(join(home, "bin", "chrome-headless-shell"))).toEqual([]);

  devtools.shellHooks.verify = async () => null;
  const zip = zips.get("157.0.8103.78")!;
  const right = zip.md5;
  zip.md5 = "AAAAAAAAAAAAAAAAAAAAAA==";
  try {
    await expect(devtools.fetchShell(home)).rejects.toThrow("didn't match its checksum");
  } finally {
    zip.md5 = right;
  }
  expect(devtools.headlessBinary()).toBe(seams.broll.chrome());
  expect(fs.readdirSync(join(home, "bin", "chrome-headless-shell"))).toEqual([]);
});

test("Google Chrome is started --headless=new, its graphics switches before its page", () => {
  devtools.findShell(join(work, "none"));
  const chrome = seams.broll.chrome();
  const command = devtools.headlessCommand(["about:blank"], { gpu: true });
  if (chrome === null) {
    expect(command).toBeNull();
    return;
  }
  expect(command!.slice(0, 2)).toEqual([chrome, "--headless=new"]);
  expect(command!.at(-1)).toBe("about:blank");
});

test("on the graphics card, Chrome draws with Metal on a Mac, Vulkan on Linux, and OpenGL on Direct3D 12 under WSL", () => {
  devtools.findShell(join(work, "none"));
  if (seams.broll.chrome() === null) return;
  const angle = () => devtools.headlessCommand(["about:blank"], { gpu: true })!.filter((part) => part.startsWith("--use-angle="));
  expect(devtools.headlessCommand(["about:blank"])!.some((part) => part.startsWith("--use-angle="))).toBe(false);
  const wsl = devtools.gpuHooks.wsl;
  try {
    devtools.gpuHooks.wsl = false;
    expect(angle()).toEqual(process.platform === "darwin" ? ["--use-angle=metal"] : process.platform === "linux" ? ["--use-angle=vulkan"] : []);
    expect(devtools.headlessEnv(true)).toBeUndefined();
    if (process.platform !== "linux") return;
    // WSL: Vulkan there is only the CPU's; Mesa's D3D12 driver, which Chrome is started with, is the card.
    devtools.gpuHooks.wsl = true;
    expect(angle()).toEqual(["--use-angle=gl-egl"]);
    expect(devtools.headlessEnv(true)?.GALLIUM_DRIVER).toBe(process.env.GALLIUM_DRIVER ?? "d3d12");
    expect(devtools.headlessEnv(true)?.PATH).toBe(process.env.PATH);
    expect(devtools.headlessEnv(false)).toBeUndefined();
  } finally {
    devtools.gpuHooks.wsl = wsl;
  }
});
