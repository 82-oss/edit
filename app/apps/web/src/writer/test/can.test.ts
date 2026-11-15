import { expect, test } from "vitest";
import { CAN, grantsOf } from "../can";

test("offers only what was granted; admins everything, bodycam compilations included", () => {
  const writer = grantsOf(["use", CAN.interrogationCompilation, "cloud"], false);
  expect(writer.singleKinds).toEqual([]);
  expect(writer.compilationKinds).toEqual(["interrogation"]);
  expect(writer.shares).toBe(true);
  const admin = grantsOf([], true);
  expect(admin.singleKinds).toEqual(["interrogation", "foia", "courtroom"]);
  expect(admin.compilationKinds).toEqual(["interrogation", "foia", "courtroom"]);
});
