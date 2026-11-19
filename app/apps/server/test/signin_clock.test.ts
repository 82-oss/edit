// The numbers of signing in, on one clock (honest council, Fable's check 6, Nov 19): JJ's false-sign-in loop was four
// numbers in two programs (the token's hour, a 30 s renewal window that sent nothing, the relay's 60 s of skew, an
// hourly retry beside the renewal at each wake). They must agree; this holds them together.

import { expect, test } from "bun:test";

import { SKEW_SECONDS } from "../../relay/src/auth.ts";
import { RENEW_BEFORE_MS, TOKEN_WAIT_MS, WAKE_RENEW_UNDER_MS } from "../src/accounts.ts";
import { PASSING_WAITS } from "../src/failure.ts";
import { WAKE_MS } from "../src/jobs.ts";
import { GAP_MS } from "../src/wake.ts";

const TOKEN_LIFE_MS = 60 * 60_000;

test("the sign-in's numbers agree on one clock", () => {
  // A token in its renewal window is still good at the relay, so a call in that window is never refused.
  expect(RENEW_BEFORE_MS).toBeLessThan(SKEW_SECONDS * 1000);
  // A call waits for a renewal under way longer than a renewal's window, and far less than a token's life.
  expect(TOKEN_WAIT_MS.value).toBeLessThan(TOKEN_LIFE_MS / 10);
  // A wake renews only near the end, and that is still well inside a token's life.
  expect(WAKE_RENEW_UNDER_MS).toBeGreaterThan(RENEW_BEFORE_MS);
  expect(WAKE_RENEW_UNDER_MS).toBeLessThan(TOKEN_LIFE_MS);
  // The table's look comes often enough that its late tick after a sleep is told from an ordinary one by the wake detector.
  expect(WAKE_MS.value * 2 + 10_000).toBeGreaterThan(GAP_MS.value);
  // A passing failure's first retry never lands inside the window a renewal takes after a wake (it's minutes on).
  expect(PASSING_WAITS.value[0]!).toBeGreaterThan(RENEW_BEFORE_MS);
});
