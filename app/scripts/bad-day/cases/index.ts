// Every bad-day case: what it sets up, what it breaks, what it checks. A case
// with `stub: true` has its spec written and isn't run yet.

import type { Cloud } from "../cloud.ts";
import type { Edit } from "../edit.ts";
import type { footage } from "../footage.ts";
import type { Line } from "../line.ts";

import { scriptCases } from "./script_mode.ts";
import { change7Cases } from "./change7.ts";
import { cutCases } from "./cuts.ts";
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

export const cases: Case[] = [...scriptCases, ...cutCases, ...change7Cases, ...stubs];
