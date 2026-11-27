// What a failed project sync call leads to (cloud_projects.ts), checked over generated cases.

import { expect, test } from "bun:test";

import { Arbitrary, Effect, Schema } from "effect";

import { afterLost, decideFailure, isOwnSave, nextAttempt } from "../src/cloud_projects.ts";

async function always<A>(name: string, schema: Schema.Codec<A>, holds: (value: A) => boolean): Promise<void> {
  const result = await Effect.runPromise(Arbitrary.checkEffect(Arbitrary.schema(schema), holds, { runs: 2000 }));
  if (result._tag === "Falsified") throw new Error(`${name}: ${JSON.stringify(result.shrunkInput)}`);
  expect(result._tag).not.toBe("Falsified");
}

const Failure = Schema.Struct({
  kind: Schema.Literals(["unreachable", "relay", "function"]),
  code: Schema.NullOr(Schema.Literals(["locked", "conflict", "invalid", "missing_body"])),
  heldBy: Schema.NullOr(Schema.Literals(["kenobi", "mathiass-macbook-pro"])),
  message: Schema.String,
  me: Schema.Literals(["kenobi", "mathiass-macbook-pro"]),
});

test("offline is only ever offline; this machine's own lock is never someone else's; another's always is", () =>
  always("failure", Failure, (seen) => {
    const decision = decideFailure(seen, seen.me);
    if (seen.kind === "unreachable") return decision.do === "offline";
    if (decision.do === "lost") return decision.holder !== seen.me && seen.code === "locked";
    if (seen.kind === "function" && seen.code === "locked" && seen.heldBy !== null && seen.heldBy !== seen.me) return false;
    return true;
  }));

const Rev = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 5 })));
const Hash = Schema.Literals(["a", "b", "c"]);
const Saved = Schema.Struct({
  attempt: Schema.UndefinedOr(Schema.Struct({ base: Rev, hash: Hash, earlier: Schema.UndefinedOr(Schema.Array(Hash)) })),
  cloud: Schema.NullOr(Schema.Struct({ rev: Rev, bodyHash: Schema.NullOr(Hash) })),
});

test("a conflict is taken as this machine's own save only when the cloud's next rev is exactly one of the pushes it sent on that base", () =>
  always("own save", Saved, ({ attempt, cloud }) => {
    const own = isOwnSave(attempt === undefined ? undefined : { ...attempt, earlier: attempt.earlier === undefined ? undefined : [...attempt.earlier] }, cloud);
    const sent = attempt === undefined ? [] : [attempt.hash, ...(attempt.earlier ?? [])];
    const exactly = attempt !== undefined && cloud !== null && cloud.bodyHash !== null && cloud.rev === attempt.base + 1 && sent.includes(cloud.bodyHash);
    return own === exactly;
  }));

test("two pushes on one base that both time out: whichever landed is this machine's own (Nov 27, Parents House)", () => {
  // The first push of rev 256 times out but lands as 257; the second, from 256 again with more in it, times out too.
  let attempt = nextAttempt(undefined, 256, "first");
  attempt = nextAttempt(attempt, 256, "second");
  expect(isOwnSave(attempt, { rev: 257, bodyHash: "first" })).toBe(true);
  expect(isOwnSave(attempt, { rev: 257, bodyHash: "second" })).toBe(true);
  // Someone else's body, or a rev that isn't the next one: not ours.
  expect(isOwnSave(attempt, { rev: 257, bodyHash: "theirs" })).toBe(false);
  expect(isOwnSave(attempt, { rev: 258, bodyHash: "first" })).toBe(false);
  // A push on a newer base forgets the older base's bodies.
  expect(nextAttempt(attempt, 257, "third")).toEqual({ base: 257, hash: "third" });
  // At most a handful are remembered.
  let many = nextAttempt(undefined, 1, "h0");
  for (let i = 1; i < 20; i++) many = nextAttempt(many, 1, `h${i}`);
  expect(many.earlier?.length).toBe(8);
  expect(isOwnSave(many, { rev: 2, bodyHash: "h18" })).toBe(true);
});

test("losing the lock with changes here always keeps them as a copy, and pulls what the other machine has", () =>
  always("lost changes", Schema.Struct({ hadChanges: Schema.Boolean, newer: Schema.Boolean }), ({ hadChanges, newer }) => {
    const plan = afterLost(hadChanges, newer);
    return plan.keep === hadChanges && plan.pull === (hadChanges || newer);
  }));
