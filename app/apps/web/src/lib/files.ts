// What the page makes for the person to keep (a thumbnail, a frame), and where
// it ends up. In Edit's window, or a browser on the Mac running Edit, the
// server writes it into Downloads and the page says so, with Show in Finder:
// a browser download there is a copy dropped somewhere unseen (Sphe, Nov 4).
// From another device it's that device's own download.

import { api } from "./api";
import { useEditor } from "./store";
import { FILE_MANAGER } from "./platform";

/** Whether this page runs on the Mac that holds Edit's files (its window, or a browser there). */
export const onThisMac = (): boolean => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(location.hostname);

/** Shows a file Edit made on this Mac in Finder, saying so when it can't. */
export function showInFinder(path: string): void {
  void api.reveal(path).catch((error: unknown) => useEditor.getState().toastError(error, `show it in ${FILE_MANAGER}`));
}

/** Keeps `blob` as `name`: in this Mac's Downloads (said, with Show in Finder), or as this device's download. */
export async function saveFile(name: string, blob: Blob): Promise<void> {
  if (!onThisMac()) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    return;
  }
  try {
    const response = await fetch(`/api/files/save?name=${encodeURIComponent(name)}`, { method: "POST", headers: { "content-type": blob.type || "application/octet-stream" }, body: blob });
    const answer = (await response.json()) as { path?: string; error?: string };
    if (!response.ok || answer.path === undefined) throw new Error(answer.error ?? `${response.status}`);
    const path = answer.path;
    useEditor.getState().toast(`Saved to Downloads as ${path.split("/").pop()}`, "info", { label: `Show in ${FILE_MANAGER}`, run: () => showInFinder(path) });
  } catch (error) {
    useEditor.getState().toastError(error, `save ${name}`);
  }
}

/** `picture` as a PNG, the one kind every clipboard takes as a picture (a JPEG or WebP is drawn again). */
export async function pngOf(picture: Blob): Promise<Blob> {
  if (picture.type === "image/png") return picture;
  const bitmap = await createImageBitmap(picture);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((png) => (png === null ? reject(new Error("the picture couldn't be made")) : resolve(png)), "image/png"));
}

/**
 * Onto the clipboard as a picture, so it pastes into Slack, Finder or a Doc.
 * `png` is handed over as a promise so the click still counts as the
 * person's: WebKit (Edit's window) and Chrome both allow that.
 */
export function copyImage(png: Promise<Blob>): void {
  const { toast, toastError } = useEditor.getState();
  if (typeof ClipboardItem === "undefined" || navigator.clipboard?.write === undefined) {
    png.catch(() => {});
    toastError(new Error("this page can't copy pictures (it needs Edit's window, or Edit's own address in a browser)"), "copy the image");
    return;
  }
  navigator.clipboard.write([new ClipboardItem({ "image/png": png })]).then(
    () => toast("Copied the image"),
    (error: unknown) => toastError(error, "copy the image"),
  );
}
