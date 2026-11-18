import { describe, expect, it } from "vitest";

import { layoutFor } from "./home-layout";

// Home's table at every width Edit's window can be (960 px at the least: the
// table is then about 700 px), Mine and Everyone: a name always keeps its
// room, columns go in their order, and the columns are as many as a row draws.
describe("Home's table at every width", () => {
  const nameOf = (columns: string, width: number) => {
    // Each column's room: "160px", or "fit-content(160px)" for one as wide as what it holds.
    const tracks = columns.split(" ").slice(1).map((one) => Number.parseFloat(/(\d+(?:\.\d+)?)px/.exec(one)![1]!));
    return width - 24 - tracks.reduce((sum, px) => sum + px, 0) - tracks.length * 16;
  };
  for (const solo of [true, false]) {
    it(`a name keeps at least 260 px from a 960 px window up (${solo ? "Mine" : "Everyone"})`, () => {
      for (let width = 700; width <= 2000; width += 10) {
        const layout = layoutFor(width, solo);
        expect(nameOf(layout.columns, width), `at ${width}`).toBeGreaterThanOrEqual(260);
        // A row draws name, status and updated always (its buttons over its end, no column); channel, by and length when shown.
        const cells = 3 + (layout.slim ? 0 : 1) + (solo ? 0 : 1) + (layout.compact ? 0 : 1);
        expect(layout.columns.split(" ").length, `at ${width}`).toBe(cells);
      }
    });
  }
  it("goes without Length first, then Channel, then By's names; Status (beside Channel) and Channel as wide as what they hold", () => {
    expect(layoutFor(1400, true).columns).toBe("minmax(0,1fr) fit-content(236px) fit-content(160px) 64px 76px");
    expect(layoutFor(1400, false)).toMatchObject({ compact: false, slim: false, faces: false });
    expect(layoutFor(1000, false)).toMatchObject({ compact: true, slim: false, faces: false });
    expect(layoutFor(900, false)).toMatchObject({ compact: true, slim: true, faces: false });
    expect(layoutFor(750, false)).toMatchObject({ compact: true, slim: true, faces: true });
  });
});
