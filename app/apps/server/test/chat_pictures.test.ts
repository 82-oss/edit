import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

import { chatPictureAddress, inlinePictures, keepPicture, keptPicture, pictureFile } from "../src/chat_pictures.ts";

test("an answer's pictures get addresses the page can load; one that can't be placed is named, not broken", async () => {
  const text = "Here it is:\n\n![the hallway](/tmp/run/abc123.png)\n\nand ![again](/tmp/run/abc123.png \"title\") and ![the porch](xyz) and ![gone](/nowhere/x.png)";
  const asked: string[] = [];
  const out = await inlinePictures(text, async (source) => {
    asked.push(source);
    return source === "/tmp/run/abc123.png" ? "/api/thumbnails/t/images/abc123" : source === "xyz" ? "/api/thumbnails/t/images/xyz" : null;
  });
  expect(asked).toEqual(["/tmp/run/abc123.png", "xyz", "/nowhere/x.png"]);
  expect(out).toBe("Here it is:\n\n![the hallway](/api/thumbnails/t/images/abc123)\n\nand ![again](/api/thumbnails/t/images/abc123) and ![the porch](/api/thumbnails/t/images/xyz) and ![gone](unavailable:x.png)");
  expect(await inlinePictures("no pictures here", async () => "never")).toBe("no pictures here");
});

test("a picture file is only one inside the agent's own folders, and a picture", () => {
  const root = fs.mkdtempSync(`${os.tmpdir()}/pictures-`);
  fs.writeFileSync(`${root}/look.png`, "png");
  fs.writeFileSync(`${root}/notes.txt`, "text");
  expect(pictureFile(`${root}/look.png`, [root])).toBe(fs.realpathSync(`${root}/look.png`));
  expect(pictureFile(`${root}/notes.txt`, [root])).toBeNull();
  expect(pictureFile(`${root}/look.png`, ["/somewhere/else"])).toBeNull();
  expect(pictureFile(`${root}/../${root.split("/").pop()}/look.png`, ["/somewhere/else"])).toBeNull();
  expect(pictureFile("look.png", [root])).toBeNull();
  fs.rmSync(root, { recursive: true, force: true });
});

test("Edit's chat keeps a picture by its content, and shows only those, from the agent's own folders", () => {
  const root = fs.mkdtempSync(`${os.tmpdir()}/chat-pictures-`);
  const folder = `${root}/p1/chat-pictures`;
  const kept = keepPicture(folder, new Uint8Array([1, 2, 3]), "png");
  expect(kept).toMatch(/\/chat-pictures\/[0-9a-f]{16}\.png$/);
  expect(keepPicture(folder, new Uint8Array([1, 2, 3]), "png")).toBe(kept);
  const name = kept.split("/").pop()!;
  expect(keptPicture(folder, name)).toBe(kept);
  expect(keptPicture(folder, "../x.png")).toBeNull();
  // A tool's picture is shown as it is; an exported still is kept first; one elsewhere isn't shown.
  expect(chatPictureAddress("p1", folder, kept, [])).toBe(`/api/projects/p1/chat-pictures/${name}`);
  fs.mkdirSync(`${root}/exports`);
  fs.writeFileSync(`${root}/exports/Frame at 1m32.png`, "still");
  const still = chatPictureAddress("p1", folder, `${root}/exports/Frame at 1m32.png`, [`${root}/exports`])!;
  expect(still).toMatch(/^\/api\/projects\/p1\/chat-pictures\/[0-9a-f]{16}\.png$/);
  expect(keptPicture(folder, still.split("/").pop()!)).not.toBeNull();
  expect(chatPictureAddress("p1", folder, `${root}/exports/Frame at 1m32.png`, [])).toBeNull();
  fs.rmSync(root, { recursive: true, force: true });
});
