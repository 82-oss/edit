// A Script import waiting by itself is followed from its row in the job table, not from memory (Nov 20: a restart
// during a wait emptied the map that held its line, and Home showed "Importing 37%" creeping with nothing said until
// its next try, up to half an hour later).

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import * as jobs from "../../src/jobs.ts";
import * as steps from "../../src/import_steps.ts";
import * as imports from "../../src/writer/imports.ts";

test("a wait read back after a restart still says what it waits on and when it goes again, and a time gone by reads now", () => {
  const home = fs.mkdtempSync(join(os.tmpdir(), "import-progress-"));
  try {
    // As a run left it before a restart: the import's row waiting on a dropped line, with where it had got to.
    const key = jobs.begin(home, "script", "s1", { waiting_on: "import", title: "Mom Of 4" }, "", "importing");
    const at = jobs.wait(home, key, new Error("could not reach Edit's relay: The socket connection was closed unexpectedly."))!;
    jobs.patch(home, key, { waiting_on: "passing", stage: "downloading", percent: 37, moved_ms: at - 120_000 });
    // Nothing in this process's memory knows of it (the restart): the row alone says it.
    const shown = imports.progress(home, at - 60_000).find((one) => one.id === "s1");
    expect(shown).toBeDefined();
    expect(shown!.title).toBe("Mom Of 4");
    expect(shown!.percent).toBe(37);
    expect(shown!.retryAt).toBe(at);
    expect(shown!.movedAt).toBe(at - 120_000);
    expect(shown!.detail).toBe(`Waiting for the connection: Edit tries again by itself at ${steps.clock(at)}.`);
    // Read after its time: "now", never a time gone by.
    expect(imports.progress(home, at + 3_600_000).find((one) => one.id === "s1")!.detail).toBe("Waiting for the connection: Edit tries again by itself now.");
    // Cut short by restarts (jobs.ts put it off): said as that, not as a connection.
    const crashy = jobs.begin(home, "script", "s2", { waiting_on: "import", title: "Other" }, "", "importing");
    jobs.wait(home, crashy, "cut short by 3 restarts in a row");
    expect(imports.progress(home).find((one) => one.id === "s2")!.detail).toStartWith("Edit was closed part-way through this import: it goes on by itself at");
    // Its exact hearing's row isn't an import.
    const exact = jobs.begin(home, "script", "s3", { waiting_on: "exact" }, "exact");
    jobs.wait(home, exact, "busy");
    expect(imports.progress(home).some((one) => one.id === "s3")).toBe(false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the page's progress reads this Edit's own job table, even before Script mode has started here (Nov 21)", async () => {
  const { fixtureHome } = await import("../helpers/home.ts");
  const { Router } = await import("../../src/http/router.ts");
  const { respond } = await import("../../src/http/server.ts");
  const store = await import("../../src/writer/store.ts");
  const writerRoutes = await import("../../src/writer/routes.ts");
  const fx = fixtureHome("import-progress-route");
  try {
    const id = "0c0ffee0-0000-4000-8000-0000000000aa";
    const dir = store.scriptDir(store.dataDir(fx.app.store.home), id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, "script.json"), JSON.stringify({ id, title: "Waiting case", sourceKind: "drive", status: "processing", stage: "downloading", progress: 20, words: [], clips: [], createdAt: 0, updatedAt: 0 }));
    const key = jobs.begin(fx.app.store.home, "script", id, { waiting_on: "import", title: "Waiting case" }, "", "importing");
    jobs.wait(fx.app.store.home, key, new Error("could not reach Edit's relay: The socket connection was closed unexpectedly."));
    // Nothing has told Script mode where home is (streamed.start, an import here): the route says it.
    const router = new Router<typeof fx.app>();
    writerRoutes.routes(router);
    const response = (await respond(fx.app, router, new Request("http://localhost:7700/api/writer/progress", { headers: { host: "localhost:7700" } }), null))!;
    expect(response.status).toBe(200);
    const shown = (await response.json()) as { id: string; detail: string }[];
    expect(shown.find((one) => one.id === id)?.detail).toStartWith("Waiting for the connection: Edit tries again by itself");
  } finally {
    fx.cleanup();
  }
});
