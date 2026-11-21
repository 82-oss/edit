// Edit's small model questions, asked of Claude (through Claude Code, the
// person's own account): each caller builds an OpenAI-style chat request (a
// system prompt, text, images or a video as data URLs, a JSON schema) and gets
// the answer back in that shape. Oct 30, the user: Gemini cost $17 in a day;
// "move" the spill fix and the watermark check to Claude. Oct 31: the AI
// Gateway is gone; the watcher's second look (bridges.ts) was its last caller.

import * as fs from "node:fs";
import * as os from "node:os";

import { join } from "./paths.ts";
import * as tools from "./tools.ts";
import * as claude from "./writer/claude.ts";

type Part = { type?: string; text?: string; image_url?: { url?: string }; file?: { filename?: string; file_data?: string } };
type Message = { role?: string; content?: string | Part[] };
type Request = { messages?: Message[]; response_format?: { json_schema?: { schema?: Record<string, unknown> } }; reasoning?: { effort?: string } };

/** The tests' stand-in for Claude (test/setup.ts: their mock server answers); null everywhere else. */
export const standIn: { post: ((bodyFile: string) => Promise<unknown>) | null } = { post: null };

/** Asks the request in `bodyFile` of Claude (`model`, Opus by default); answers as `{choices: [{message: {content}}]}`. */
export async function post(bodyFile: string, model: string = claude.OPUS, label = "Claude opus answering a small question"): Promise<unknown> {
  if (standIn.post !== null) return standIn.post(bodyFile);
  // Off the server's thread (Nov 21): the watcher's request holds a few minutes of footage as base64, and its contact
  // sheets were cut by FFmpeg as a synchronous program, for every window of an import, every page waiting meanwhile.
  const request = JSON.parse(await fs.promises.readFile(bodyFile, "utf8")) as Request;
  const messages = request.messages ?? [];
  const system = messages.filter((message) => message.role === "system").map((message) => textOf(message.content)).join("\n\n");
  // Images go in a folder Claude may read, named in the prompt in their order.
  const folder = await fs.promises.mkdtemp(join(os.tmpdir(), "edit-claude-"));
  try {
    const images: string[] = [];
    const said: string[] = [];
    for (const message of messages) {
      if (message.role === "system") continue;
      if (typeof message.content === "string") {
        said.push(message.content);
        continue;
      }
      const parts: string[] = [];
      for (const part of message.content ?? []) parts.push(await partText(part, folder, images));
      said.push(parts.join("\n"));
    }
    const prompt = said.join("\n\n");
    const shown = images.length === 0 ? prompt : `${prompt}\n\nRead each image file above (in order) before answering.`;
    const schema = request.response_format?.json_schema?.schema;
    // How hard to think, as the caller asked (every one asks "low"): dropped here until Nov 5, so each
    // of these small questions thought at Claude Code's default, on the person's plan.
    const effort = effortOf(request.reasoning?.effort);
    const answer = await claude.askPatiently({ model, system: system || "Answer exactly as asked.", prompt: shown, label, ...(schema ? { schema } : {}), ...(images.length > 0 ? { read: folder } : {}), ...(effort ? { effort } : {}) });
    const content = answer.structured !== null ? JSON.stringify(answer.structured) : (answer.text ?? "");
    return { choices: [{ message: { content } }] };
  } finally {
    await fs.promises.rm(folder, { recursive: true, force: true });
  }
}

/** How long a window's contact sheets may take to cut (a few minutes of footage, a frame a second: seconds). */
const SHEETS_MS = 10 * 60_000;

/** One part of a request as the prompt says it: its text, or an image or a video put in `folder` (added to `images`) and named. */
async function partText(part: Part, folder: string, images: string[]): Promise<string> {
  // A video (a request's file part): contact sheets, a frame a second, as the watcher shows Claude (watch.ts).
  const video = part.type === "file" ? /^data:video\/\w+;base64,(.+)$/s.exec(part.file?.file_data ?? "") : null;
  if (video !== null) {
    const clip = join(folder, `video-${images.length + 1}.mp4`);
    await fs.promises.writeFile(clip, Buffer.from(video[1]!, "base64"));
    const first = images.length;
    try {
      await tools.run([tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-i", clip, "-vf", "fps=1,scale=320:-2,tile=4x3", "-q:v", "4", join(folder, `sheets-${first}-%02d.jpg`)], { timeoutMs: SHEETS_MS });
    } catch {
      throw new Error("the video's frames couldn't be taken");
    }
    const sheets = (await fs.promises.readdir(folder)).filter((name) => name.startsWith(`sheets-${first}-`)).sort();
    images.push(...sheets.map((name) => join(folder, name)));
    return `[The video, as contact sheets of 12 frames, one a second, left to right then top to bottom:\n${sheets.map((name, index) => `Sheet ${index + 1} (${join(folder, name)}): seconds ${index * 12} to ${index * 12 + 11}`).join("\n")}]`;
  }
  const data = part.type === "image_url" ? /^data:image\/(\w+);base64,(.+)$/s.exec(part.image_url?.url ?? "") : null;
  if (data === null) return part.text ?? "";
  const path = join(folder, `image-${images.length + 1}.${data[1] === "jpeg" ? "jpg" : data[1]}`);
  await fs.promises.writeFile(path, Buffer.from(data[2]!, "base64"));
  images.push(path);
  return `[Image ${images.length}: ${path}]`;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/** A request's effort as Claude Code takes it (none when it names none Claude Code knows). */
export const effortOf = (given: string | undefined): (typeof EFFORTS)[number] | undefined => EFFORTS.find((one) => one === given);

const textOf = (content: Message["content"]): string => (typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("\n"));

/** The spill fix's question (turns.ts), on Opus. */
export const spills = (bodyFile: string): Promise<unknown> => post(bodyFile, claude.OPUS, "Claude opus putting spilled words back");
