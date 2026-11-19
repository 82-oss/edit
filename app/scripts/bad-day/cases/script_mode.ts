// Script mode's import of a case from a Drive folder (writer/imports.ts),
// on its bad days: changes 2 and 3 of final.md.

import type { Case, Context } from "./index.ts";

const FOLDER = "1BadDayCaseFolder0000000001";
const IDS = ["1BadDayRecordingAAAAAAAAAA1", "1BadDayRecordingAAAAAAAAAA2", "1BadDayRecordingAAAAAAAAAA3"];

interface Missing {
  id: string;
  title: string;
  error: string;
  tries: number;
  nextAt: number;
}

interface Script {
  id: string;
  status: "processing" | "ready" | "needs_choice" | "error";
  stage?: string;
  error: string | null;
  missing?: Missing[];
  parts?: { title: string }[];
  decision?: { kind: string; summary: string } | null;
  notes?: string[];
}

/** Puts the three recordings in the folder (the second as `second`, if given) and starts the import as the page does. */
async function startImport(context: Context, second?: { path: string; size: number; md5: string; name: string }, options: { refuseSecond?: boolean } = {}): Promise<string> {
  const { cloud, edit, footage } = context;
  const [a, b, c] = footage.recordings;
  cloud.addFile(FOLDER, IDS[0]!, a!);
  cloud.addFile(FOLDER, IDS[1]!, second === undefined ? b! : { ...b!, ...second, seconds: 0 }, options.refuseSecond === true ? { refuse: 404 } : {});
  cloud.addFile(FOLDER, IDS[2]!, c!);
  const started = await edit.api<Script>("POST", "/api/writer/scripts/drive", { url: `https://drive.google.com/drive/folders/${FOLDER}` });
  if (started.status !== 200 || typeof started.body?.id !== "string") throw new Error(`starting the import answered ${started.status}: ${started.text.slice(0, 300)}`);
  context.log(`import started: script ${started.body.id}`);
  return started.body.id;
}

async function script(context: Context, id: string): Promise<Script> {
  const answer = await context.edit.api<Script>("GET", `/api/writer/scripts/${id}`);
  if (answer.status !== 200) throw new Error(`GET script answered ${answer.status}`);
  return answer.body;
}

function describe(one: Script): string {
  const missing = (one.missing ?? []).map((item) => `${item.title} (tries ${item.tries}: ${item.error})`).join(", ");
  return `status ${one.status}${one.stage ? `/${one.stage}` : ""}${one.error ? `, error "${one.error}"` : ""}, ${one.parts?.length ?? 0} part(s)${missing ? `, missing ${missing}` : ""}`;
}

/** The import's end, however it ends: ready with nothing missing (`whole`), or anything settled. */
async function settled(context: Context, id: string, ms: number, whole: boolean): Promise<Script | null> {
  return context.waitFor(
    whole ? "the import whole" : "the import to settle",
    async () => {
      const one = await script(context, id);
      if (one.status === "error" || one.status === "needs_choice") return one;
      if (one.status !== "ready") return null;
      return !whole || (one.missing ?? []).length === 0 ? one : null;
    },
    ms,
  );
}

const signInWords = /sign(ed)? in|\b401\b|renew/i;

/** Check 5: each recording came down from Drive about once (the bytes Edit got, at most 1.3 times the files). */
function fetchedOnce(context: Context): void {
  const files = IDS.map((id) => context.cloud.drive.get(id)).filter((file) => file !== undefined);
  const sent = files.reduce((sum, file) => sum + context.line.sent(`/www.googleapis.com/drive/v3/files/${file!.id}`), 0);
  const size = files.reduce((sum, file) => sum + file!.size, 0);
  context.check("each recording fetched about once", sent <= size * 1.3, `${(sent / 1e6).toFixed(1)} MB came down from Drive for ${(size / 1e6).toFixed(1)} MB of recordings`);
}

export const scriptCases: Case[] = [
  {
    name: "signin-after-freeze",
    change: "2",
    spec:
      "Sign-ins last 20 s. A Script import of three recordings has the second refused once by Drive, so a retry falls due a minute later. " +
      "Edit and everything under it is frozen for 40 s across the retry's time and the sign-in's end, with the line cut; woken, the line back 5 s later. " +
      "Checks: the stand-ins saw no call without a sign-in or with a run-out one; Edit's log has no 'need you signed in' and no '(401)'; " +
      "the recording comes in on the first try after the wake; no script holds a sign-in error.",
    signInSeconds: 20,
    paidAtMost: { hearings: 3 },
    async run(context) {
      const { cloud } = context;
      // The second recording is refused (Drive's 404: not shared yet) until it waits for its retry, then given.
      const id = await startImport(context, undefined, { refuseSecond: true });
      // The rest comes in, the second waits for its retry.
      const waiting = await context.waitFor(
        "the second recording to wait for its retry",
        async () => {
          const one = await script(context, id);
          if (one.status === "error") return one;
          return (one.missing ?? []).length > 0 && one.status === "ready" ? one : null;
        },
        180_000,
      );
      if (waiting === null || waiting.status === "error") {
        context.check("the import reached its retry", false, waiting === null ? `never did: ${describe(await script(context, id))}` : describe(waiting));
        return;
      }
      context.check("the import reached its retry", true, describe(waiting));
      delete cloud.drive.get(IDS[1]!)!.refuse;
      const due = waiting.missing![0]!.nextAt;
      const triesBefore = waiting.missing![0]!.tries;
      // Frozen from 20 s before the retry's time to 20 s after, across at least one sign-in's end.
      const freezeAt = Math.max(Date.now() + 2000, due - 20_000);
      await context.sleep(freezeAt - Date.now());
      context.log(`freezing 40 s; the retry was due at +${Math.round((due - context.started) / 1000)} s`);
      await context.freeze(40_000, 5000);
      const woke = Date.now();
      // The first try after the wake brings it in: no failed try in between.
      let failedTry: Missing | null = null;
      const whole = await context.waitFor(
        "the recording after the wake",
        async () => {
          const one = await script(context, id);
          const still = (one.missing ?? []).find((item) => item.id === IDS[1]);
          if (still !== undefined && still.tries > triesBefore && failedTry === null) {
            failedTry = still;
            context.log(`a try after the wake failed: ${still.error}`);
          }
          if (one.status === "error") return one;
          return one.status === "ready" && (one.missing ?? []).length === 0 ? one : null;
        },
        150_000,
      );
      const last = whole ?? (await script(context, id));
      context.check(
        "the recording came in on the first try after the wake",
        whole !== null && whole.status === "ready" && failedTry === null,
        whole === null || whole.status !== "ready"
          ? `not in ${Math.round((Date.now() - woke) / 1000)} s after the wake: ${describe(last)}`
          : failedTry !== null
            ? `came in only after a failed try: ${(failedTry as Missing).error}`
            : `in ${Math.round((Date.now() - woke) / 1000)} s after the wake, ${last.parts?.length ?? 0} parts`,
      );
      const errors = [last.error ?? "", ...(last.missing ?? []).map((item) => item.error)].filter((text) => signInWords.test(text));
      context.check("no script holds a sign-in error", errors.length === 0, errors.length === 0 ? "none" : errors.join(" | "));
      context.log(`renewals at the accounts site: ${cloud.renewals}`);
      fetchedOnce(context);
    },
  },
  {
    name: "signin-site-slow",
    change: "2",
    spec:
      "Sign-ins last 20 s. While a Script import runs, the accounts site answers 25 s late for a minute (Edit gives it 20 s), then is quick again. " +
      "Checks: no call went without a good sign-in; nothing says sign in; the import finishes whole by itself.",
    signInSeconds: 20,
    paidAtMost: { hearings: 3 },
    async run(context) {
      const { cloud } = context;
      const id = await startImport(context);
      await context.sleep(3000);
      context.log("the accounts site answers 25 s late for 60 s");
      cloud.accountsDelayMs = 25_000;
      await context.sleep(60_000);
      cloud.accountsDelayMs = 0;
      context.log("the accounts site is quick again");
      const end = await settled(context, id, 180_000, true);
      const last = end ?? (await script(context, id));
      context.check("the import finished whole by itself", end !== null && end.status === "ready" && (end.missing ?? []).length === 0, describe(last));
      const errors = [last.error ?? "", ...(last.missing ?? []).map((item) => item.error)].filter((text) => signInWords.test(text));
      context.check("nothing says sign in", errors.length === 0, errors.length === 0 ? "no sign-in error on the script" : errors.join(" | "));
      fetchedOnce(context);
    },
  },
  {
    name: "signin-ended",
    change: "2",
    spec:
      "Sign-ins last 330 s (renewed every 30 s). A Script import waits to try its second recording again; then the sign-in is ended at the accounts site (invalid_grant), " +
      "and 40 s after Edit has signed out, the person signs in again (the device code approved). " +
      "Checks: one sign-in screen (Edit signed out, asking for one code); work waits (the script isn't stopped and its retry isn't spent on the missing sign-in); " +
      "it carries on within 30 s of signing in and the case is whole.",
    signInSeconds: 330,
    // Signed out for real, Edit may say so: once, on the sign-in screen, which this case checks itself.
    allowed: [/need you signed in/i],
    paidAtMost: { hearings: 3 },
    async run(context) {
      const { cloud, edit } = context;
      const id = await startImport(context, undefined, { refuseSecond: true });
      const waiting = await context.waitFor(
        "the second recording to wait for its retry",
        async () => {
          const one = await script(context, id);
          return one.status === "error" || ((one.missing ?? []).length > 0 && one.status === "ready") ? one : null;
        },
        180_000,
      );
      if (waiting === null || waiting.status === "error") {
        context.check("the import reached its retry", false, waiting === null ? describe(await script(context, id)) : describe(waiting));
        return;
      }
      delete cloud.drive.get(IDS[1]!)!.refuse;
      const triesBefore = waiting.missing![0]!.tries;
      context.log("the sign-in is ended at the accounts site");
      cloud.endSignIn();
      const out = await context.waitFor(
        "Edit to sign out",
        async () => {
          const account = await edit.api<{ signed_in: boolean; signing_in: boolean; device: unknown }>("GET", "/api/account");
          return account.body.signed_in === false ? account.body : null;
        },
        90_000,
      );
      context.check("Edit shows the sign-in screen", out !== null, out === null ? "it never signed out" : JSON.stringify(out).slice(0, 200));
      // Signed out past the retry's time and one look of the job table after it (Fable's last look: 40 s alone could
      // end before the retry fell due, so it passed by its timing); at most six minutes.
      const dueAt = waiting.missing![0]!.nextAt;
      await context.sleep(Math.min(Math.max(40_000, dueAt - Date.now() + 35_000), 360_000));
      context.log(`signed out until ${Math.round((Date.now() - dueAt) / 1000)} s after the retry was due`);
      const during = await script(context, id);
      const spent = (during.missing ?? []).find((item) => item.id === IDS[1]);
      context.check(
        "work waits for the sign-in",
        during.status !== "error" && (spent === undefined || spent.tries === triesBefore),
        `${describe(during)}${spent !== undefined && spent.tries > triesBefore ? `: a try was spent signed out (${spent.error})` : ""}`,
      );
      // The person signs in on the sign-in screen: the page asks for a code (a headless Edit's way), the person types it.
      const asked = await edit.api("POST", "/api/account/device", {});
      context.log(`the sign-in screen asked for a code: ${asked.status}`);
      await context.waitFor("the code to be asked of the accounts site", () => cloud.devices.size > 0 || null, 20_000);
      const signedIn = Date.now();
      context.log(`the person signs in (${cloud.approveDevices()} code(s) approved)`);
      const whole = await context.waitFor(
        "the case whole after signing in",
        async () => {
          const one = await script(context, id);
          return one.status === "ready" && (one.missing ?? []).length === 0 ? one : null;
        },
        120_000,
      );
      const seconds = Math.round((Date.now() - signedIn) / 1000);
      context.check("one sign-in screen", cloud.deviceCodes <= 1, `${cloud.deviceCodes} device code(s) asked for`);
      context.check("it carries on within 30 s of signing in", whole !== null && seconds <= 30, whole === null ? `not whole after ${seconds} s: ${describe(await script(context, id))}` : `whole ${seconds} s after signing in`);
      fetchedOnce(context);
    },
  },
  {
    name: "unreadable-recording",
    change: "3",
    spec:
      "A Drive folder of three recordings. The line drops just as the join reads the second from the cloud (its copy here already gone), for 45 s. " +
      "Checks: the import ends ready with the others; the second is listed as missing with its real reason; it comes in by itself once the line is back; nothing says 'import stopped'.",
    paidAtMost: { hearings: 3 },
    async run(context) {
      const { cloud, line } = context;
      // The join reads each recording's original from the cloud by its presigned URL: the line drops on the second's first read there.
      let dropped = false;
      cloud.beforeR2Get = (key) => {
        if (dropped || !key.includes(IDS[1]!)) return;
        dropped = true;
        context.log(`the line drops as ${key} is read from the cloud`);
        line.set("down");
        setTimeout(() => line.set("up"), 45_000);
      };
      const id = await startImport(context);
      const first = await settled(context, id, 240_000, false);
      const at = first ?? (await script(context, id));
      // Not a check: since change 3 the join uses what the fetch read and reads a recording again only when it must.
      context.log(dropped ? "the line dropped as the second was read from the cloud" : "the second was never read back from the cloud (the join used what the fetch read)");
      const others = (at.parts ?? []).length;
      context.check("the import ended ready with the others", at.status === "ready" && others >= 2, describe(at));
      const listed = (at.missing ?? []).find((item) => item.id === IDS[1]);
      context.check(
        "the second is listed as missing with its real reason",
        at.status === "ready" ? listed === undefined || !/^Could not read/.test(listed.error) : false,
        listed === undefined ? (at.status === "ready" ? "it came in already" : describe(at)) : `"${listed.error}"`,
      );
      const whole = at.status === "ready" ? await settled(context, id, 420_000, true) : null;
      context.check("it came in by itself once the line was back", whole !== null, describe(whole ?? (await script(context, id))));
      fetchedOnce(context);
    },
  },
  {
    name: "unreadable-recording-noise",
    change: "3",
    spec:
      "A Drive folder of three recordings, the second a megabyte of noise named .mp4. " +
      "Checks: the import ends ready with the other two; the noise is listed as missing with its real reason; nothing says 'import stopped'.",
    paidAtMost: { hearings: 3 },
    async run(context) {
      const { footage } = context;
      const id = await startImport(context, { ...footage.noise });
      const end = await settled(context, id, 240_000, false);
      const at = end ?? (await script(context, id));
      context.check("the import ended ready with the other two", at.status === "ready" && (at.parts ?? []).length >= 2, describe(at));
      const listed = (at.missing ?? []).find((item) => item.id === IDS[1]);
      context.check(
        "the noise is listed as missing with its real reason",
        listed !== undefined && !/^Could not read/.test(listed.error),
        listed === undefined ? `not listed: ${describe(at)}` : `"${listed.error}"`,
      );
      fetchedOnce(context);
    },
  },
];
