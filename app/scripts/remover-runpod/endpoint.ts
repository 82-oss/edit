// Makes (or brings up to date) the RunPod Serverless endpoint that cleans Edit's subtitles: bootstrap.sh and
// handler.py go in its env, so nothing it runs expires (each job brings Edit's own minimax_worker.py). Prints the
// endpoint's id: wrangler.toml's REMOVER_ENDPOINT (prod and dev share it; it only computes).
//
//   infisical run --projectId=979fe56c-c4d0-4809-b64f-5ebc75eeaf05 --env=prod --path=/edit-relay -- bun app/scripts/remover-runpod/endpoint.ts
//
// GPUs, fastest first (Sphe, Nov 19): 5090, 4090, L40 group, A40 group, 3090 group, A4000 group; each card measured on
// the same 8 s clip (16–52 s, about a cent each). The model needs ~13 GB, so the 16 GB cards are the smallest.
import * as fs from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const NAME = "edit-remover";
const KEY = process.env.RUNPOD_API_KEY;
if (!KEY) throw new Error("RUNPOD_API_KEY isn't set: run this under `infisical run … --path=/edit-relay`");

async function rp(method: string, path: string, body?: unknown) {
  const res = await fetch(`https://api.runpod.io${path}`, { method, headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

const b64 = (file: string) => Buffer.from(fs.readFileSync(join(HERE, file))).toString("base64");
const config = {
  name: NAME,
  type: "QUEUE",
  image: "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404",
  entrypoint: ["/bin/bash", "-c"],
  cmd: ['mkdir -p /tmp/remover && echo "$BOOTSTRAP_B64" | base64 -d > /tmp/remover/bootstrap.sh && echo "$HANDLER_B64" | base64 -d > /tmp/remover/handler.py && exec bash /tmp/remover/bootstrap.sh'],
  disk: 25,
  // The image is built on CUDA 12.8: a host with an older driver can't start it (Nov 19: workers looped there).
  gpu: { pools: ["ADA_32_PRO", "ADA_24", "ADA_48_PRO", "AMPERE_48", "AMPERE_24", "AMPERE_16"], count: 1, minCudaVersion: "12.8" },
  // The account's 10; a worker stays a minute after its last stretch, so a project's next ones find it warm.
  workers: { min: 0, max: 10, idleTimeout: 60 },
  scaling: { type: "QUEUE_DELAY", queueDelay: 1 },
  // The plan allows 3 FlashBoot endpoints; this one starts in ~20 s without it.
  flashboot: "OFF",
  timeout: 3_600_000,
  env: { BOOTSTRAP_B64: b64("bootstrap.sh"), HANDLER_B64: b64("handler.py") },
};

const listed = await rp("GET", "/v2/serverless");
const existing = (listed.endpoints ?? []).find((one: { name: string }) => one.name === NAME);
const endpoint = existing === undefined ? await rp("POST", "/v2/serverless", config) : await rp("PATCH", `/v2/serverless/${existing.id}`, config);
console.log(`${existing === undefined ? "made" : "updated"} ${NAME}: ${endpoint.id}`);
