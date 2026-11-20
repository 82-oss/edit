// A script's conversation as the editor chat's entries, so the script,
// ideas, thumbnails and editor chats all render through the same turns
// and composer (ChatTurns + ChatComposer). Only the words differ: a
// script tool's label is its entry text, named by toolLabel.

import type { AgentEntry } from "../../lib/agent";
import type { BuildStatus, ChatTurn } from "../types";
import { toolLabel, turnParts } from "./turn";

type LiveTurn = { text: string; trace?: ChatTurn["trace"]; parts?: NonNullable<BuildStatus["turn"]>["parts"] };

function assistantEntries(prefix: string, text: string, trace: ChatTurn["trace"], at: number, failed?: boolean, workedMs?: number): AgentEntry[] {
  if (failed) return [...assistantEntries(prefix, "", trace, at, false, workedMs), { id: `${prefix}-error`, kind: "error", text, at }];
  const entries: AgentEntry[] = [];
  const updated = workedMs !== undefined ? at + workedMs : undefined;
  turnParts(text, trace ?? []).forEach((part, index) => {
    if (part.type === "text") {
      entries.push({ id: `${prefix}-text-${index}`, kind: "assistant", text: part.text, at, updated });
    } else {
      part.calls.forEach((call) => {
        entries.push({
          id: `${prefix}-tool-${call.id}`,
          kind: "tool",
          tool: call.tool,
          text: call.label || toolLabel(call.tool ?? "", call.state !== "running"),
          title: call.label || toolLabel(call.tool ?? "", call.state !== "running"),
          detail: call.detail,
          status: call.state === "error" ? "failed" : call.state === "running" ? "running" : "done",
          at,
          updated,
        });
      });
    }
  });
  return entries;
}

/** The footage files a message carried, shown above its words as the editor's are (sound by its name, the rest as video). */
const attachments = (names: readonly string[]): Pick<AgentEntry, "attachments"> =>
  names.length === 0 ? {} : { attachments: names.map((name) => ({ name, kind: /\.(mp3|m4a|wav|aac|ogg|oga|opus|flac|wma|amr)$/iu.test(name) ? ("audio" as const) : ("video" as const), url: null })) };

/**
 * Saved turns, the turn being written (`live`, with what was just asked
 * as `sent`), in the editor chat's shape. Reset asks are left out: the
 * caller shows them in the composer's tray, as the editor does.
 */
export function scriptEntries(chat: ChatTurn[], live?: LiveTurn | null, sent?: string | null, since = Date.now(), sentFiles: readonly string[] = []): AgentEntry[] {
  const entries: AgentEntry[] = [];
  chat.forEach((turn, index) => {
    if (turn.reset) return;
    if (turn.role === "producer") {
      entries.push({ id: `saved-${index}-user`, kind: "user", text: turn.text, at: turn.at, ...attachments(turn.files ?? []) });
    } else {
      entries.push(...assistantEntries(`saved-${index}`, turn.text, turn.trace, turn.at, turn.failed, turn.workedMs));
    }
  });
  // Stamped when it was sent, not on every render, so its time and the thinking words keep counting.
  if (sent) entries.push({ id: "live-user", kind: "user", text: sent, at: since, ...attachments(sentFiles) });
  if (live?.parts !== undefined) entries.push(...liveParts(live.parts, since));
  else if (live) entries.push(...assistantEntries("live", live.text, live.trace, since));
  return entries;
}

/** The live turn's words, reasoning and tools in the order they happened (the server's live.partsOf): its thinking shows as it comes. */
function liveParts(parts: NonNullable<LiveTurn["parts"]>, at: number): AgentEntry[] {
  return parts.flatMap((part, index): AgentEntry[] => {
    if (part.kind === "text") return [{ id: `live-text-${index}`, kind: "assistant", text: part.text, at }];
    if (part.kind === "thinking") return [{ id: `live-think-${index}`, kind: "thinking", text: part.text, status: part.active ? "running" : "done", at }];
    return part.calls.map((call) => ({
      id: `live-tool-${call.id}`,
      kind: "tool" as const,
      tool: call.tool,
      text: call.label || toolLabel(call.tool ?? "", call.state !== "running"),
      title: call.label || toolLabel(call.tool ?? "", call.state !== "running"),
      detail: call.detail,
      status: call.state === "error" ? ("failed" as const) : call.state === "running" ? ("running" as const) : ("done" as const),
      at,
    }));
  });
}
