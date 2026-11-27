// A project an export waits on has its removal pieces taken first (removal_priority.ts): Nov 27's Gen Alpha.
import { expect, test } from "bun:test";

import { isWaitedOn, takeNext, waitedOn } from "../src/removal_priority.ts";

test("pieces of a project an export waits on go first, in their order; the rest keep theirs", () => {
  const queue = [
    { project: "at-work", n: 1 },
    { project: "parents", n: 2 },
    { project: "gen-alpha", n: 3 },
    { project: "at-work", n: 4 },
    { project: "gen-alpha", n: 5 },
  ];
  expect(takeNext([...queue])?.n).toBe(1);
  const release = waitedOn("gen-alpha");
  expect(isWaitedOn("gen-alpha")).toBe(true);
  const taken = [takeNext(queue), takeNext(queue), takeNext(queue)].map((one) => one?.n);
  expect(taken).toEqual([3, 5, 1]);
  release();
  release();
  expect(isWaitedOn("gen-alpha")).toBe(false);
  expect([takeNext(queue)?.n, takeNext(queue)?.n, takeNext(queue)]).toEqual([2, 4, undefined]);
});

test("two waits on one project: it stays first until both let go", () => {
  const one = waitedOn("p");
  const two = waitedOn("p");
  one();
  expect(isWaitedOn("p")).toBe(true);
  two();
  expect(isWaitedOn("p")).toBe(false);
});
