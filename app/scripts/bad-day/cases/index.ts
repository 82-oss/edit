// Every bad-day case: what it sets up, what it breaks, what it checks. A case
// with `stub: true` has its spec written and isn't run yet.

import type { Cloud } from "../cloud.ts";
import type { Edit } from "../edit.ts";
import type { footage } from "../footage.ts";
import type { Line } from "../line.ts";

import { scriptCases } from "./script_mode.ts";
import { change7Cases } from "./change7.ts";
import { coldCases } from "./cold.ts";
import { cutCases } from "./cuts.ts";
import { handoffCases } from "./handoff.ts";
import { stubs } from "./stubs.ts";

export type Verdict = "pass" | "fail" | "stub";

export interface Context {
  /** The case's own folder in the run. */
  dir: string;
  /** Edit's home (its realpath). */
  home: string;
  cloud: Cloud;
  line: Line;
  edit: Edit;
  footage: ReturnType<typeof footage>;
  log(line: string): void;
  started: number;
  check(name: string, ok: boolean, detail: string): void;
  /** Edit and everything under it frozen `ms`, the line cut at the same moment and back `lineBackAfterMs` after the wake. */
  freeze(ms: number, lineBackAfterMs?: number): Promise<void>;
  /** `test` until it gives something (not false/null), once a second, at most `ms`; null if it never did. */
  waitFor<T>(label: string, test: () => Promise<T | false | null | undefined> | T | false | null | undefined, ms: number): Promise<T | null>;
  sleep(ms: number): Promise<unknown>;
}

export interface Case {
  name: string;
  /** Which change in final.md it proves. */
  change: string;
  /** What it does and checks, in a sentence or three (shown with --list). */
  spec: string;
  stub?: boolean;
  /** How long a sign-in lives here (s); 3600 if unset. */
  signInSeconds?: number;
  /** Edit's home on the 256 MB disk. */
  smallDisk?: boolean;
  env?: Record<string, string>;
  /** Log patterns the common "nothing asked" check lets through for this case (its own checks judge them). */
  allowed?: RegExp[];
  /** Check 6: paid calls at most (hearings, voices, model). */
  paidAtMost?: Record<string, number>;
  run(context: Context): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** An answer from Edit slower than this is a freeze a person feels: the page asks it things all the time. */
const ANSWER_MS = 2_000;
/** After a start Edit may be slow for this long (reading its state back) without it counting here. */
const STARTING_MS = 10_000;

/**
 * Every case also checks that Edit answered throughout (Nov 20: Sphe's Linux Edit answered nothing for 20 to 30
 * seconds of every minute, Script mode's cloud round writing its ledger once a script, and no case could see it: they
 * all look at how work ends, none at whether Edit answers meanwhile). `/api/health` is asked four times a second from
 * outside Edit, straight to it (never through the bad line); an answer slower than two seconds fails the case, unless
 * the harness itself had Edit frozen, killed or starting then.
 */
function answering(one: Case): Case {
  if (one.stub === true) return one;
  return {
    ...one,
    async run(context) {
      const { edit } = context;
      /** When the harness itself kept Edit from answering: [from, until]. */
      const ours: [number, number][] = [];
      const during = async <T>(work: () => Promise<T>, after = 0): Promise<T> => {
        const from = Date.now();
        try {
          return await work();
        } finally {
          ours.push([from, Date.now() + after]);
        }
      };
      const freeze = context.freeze.bind(context);
      context.freeze = (ms, back) => during(() => freeze(ms, back), 2_000);
      const kill = edit.kill.bind(edit);
      const start = edit.start.bind(edit);
      const stop = edit.stop.bind(edit);
      edit.kill = () => during(kill, 1_000);
      edit.stop = () => during(stop, 1_000);
      edit.start = () => during(start, STARTING_MS);
      const slow: { at: number; ms: number }[] = [];
      let asked = 0;
      let going = true;
      // And when the harness itself had no turn (it compares two videos with FFmpeg run synchronously, seconds at a
      // time): an ask outstanding then is answered late on this side of the wire, not Edit's (Nov 21: 4.8 s at the end
      // of cold-export-drop, check 7's own time, with no hold in Edit's log).
      let beatAt = Date.now();
      const beat = setInterval(() => {
        const now = Date.now();
        if (now - beatAt > 600) ours.push([beatAt, now + 250]);
        beatAt = now;
      }, 100);
      const pulse = (async () => {
        while (going) {
          const at = Date.now();
          try {
            const answer = await fetch(`${edit.url}/api/health`, { signal: AbortSignal.timeout(180_000) });
            await answer.text();
            asked++;
            const ms = Date.now() - at;
            if (answer.ok && ms >= ANSWER_MS) slow.push({ at, ms });
          } catch {
            // Not up (killed, starting): the case's own checks judge that.
          }
          await sleep(250);
        }
      })();
      try {
        await one.run(context);
      } finally {
        going = false;
        await pulse;
        clearInterval(beat);
        if (Date.now() - beatAt > 600) ours.push([beatAt, Date.now() + 250]);
        edit.kill = kill;
        edit.start = start;
        edit.stop = stop;
        const felt = slow.filter((one) => !ours.some(([from, until]) => one.at <= until && one.at + one.ms >= from));
        const worst = felt.reduce((most, one) => Math.max(most, one.ms), 0);
        context.check(
          "Edit answered throughout",
          felt.length === 0,
          felt.length === 0
            ? `${asked} asks of /api/health, none slower than ${ANSWER_MS / 1000} s${slow.length > 0 ? ` but ${slow.length} while the harness had it frozen or starting` : ""}`
            : `${felt.length} of ${asked} asks took ${ANSWER_MS / 1000} s or more (the worst ${(worst / 1000).toFixed(1)} s): at ${felt.slice(0, 6).map((one) => `+${Math.round((one.at - context.started) / 1000)} s for ${(one.ms / 1000).toFixed(1)} s`).join(", ")}`,
        );
      }
    },
  };
}

export const cases: Case[] = [...scriptCases, ...cutCases, ...change7Cases, ...coldCases, ...handoffCases, ...stubs].map(answering);
