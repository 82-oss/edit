export type ScriptToolCall = {
  id: string;
  /** Which tool ran; absent on turns saved before tools were recorded by name. */
  tool?: string;
  /** What the tool is doing while it runs, and what it did once settled. */
  label: string;
  /** What came of it: the tool's own summary, or why it failed. */
  detail?: string;
  state: "running" | "done" | "error";
};

/** What each tool is called while it runs, and once it has run. */
const TOOLS: Record<string, [doing: string, did: string]> = {
  build_script: [
    "Planning the clips and narration",
    "Built and cleaned up the script",
  ],
  plan_part: [
    "Planning a part of the footage",
    "Planned a part of the footage",
  ],
  read_timeline: ["Reading the timeline", "Read the timeline"],
  read_transcript: ["Reading the transcript", "Read the transcript"],
  read_passages: ["Reading the transcript", "Read the transcript"],
  read_video: ["Reading a video's transcript", "Read a video's transcript"],
  find_words: ["Searching the transcript", "Searched the transcript"],
  remove_words: ["Cutting words", "Cut words"],
  insert_words: ["Inserting words", "Inserted words"],
  arrange_word_clips: ["Arranging the timeline", "Arranged the timeline"],
  arrange_time_clips: ["Arranging the timeline", "Arranged the timeline"],
  insert_cut_in: ["Adding a cut-in", "Added a cut-in"],
  set_reuse_link: ["Linking a reused case", "Linked a reused case"],
  move_clips: ["Moving clips", "Moved clips"],
  reorder_clip: ["Reordering a clip", "Reordered a clip"],
  trim_clip: ["Trimming a clip", "Trimmed a clip"],
  split_clip: ["Splitting a clip", "Split a clip"],
  delete_items: ["Deleting items", "Deleted items"],
  close_gaps: ["Closing gaps", "Closed gaps"],
  set_label: ["Changing label colours", "Changed label colours"],
  correct_word: ["Fixing a word", "Fixed a word"],
  history: ["Undoing or redoing", "Undid or redid"],
  select_clips: ["Selecting clips", "Selected clips"],
  move_playhead: ["Moving the playhead", "Moved the playhead"],
  start_export: ["Starting an export", "Started an export"],
  inspect_frames: ["Looking at frames", "Looked at frames"],
  read_assets: ["Reading the research", "Read the research"],
  curate_assets: ["Choosing script assets", "Chose script assets"],
  read_doc_comments: ["Reading the Doc comments", "Read the Doc comments"],
  find_silences: ["Finding silences", "Found silences"],
  read_audio: ["Listening to the audio", "Listened to the audio"],
  review_cuts: ["Checking clip edges", "Checked clip edges"],
  polish_clips: ["Polishing clip edges", "Polished clip edges"],
  remove_silences: ["Removing silences", "Removed silences"],
  load_writing_skill: [
    "Reading the Cut-In writing framework",
    "Read the Cut-In writing framework",
  ],
  read_script: ["Reading the script", "Read the script"],
  write_cut_ins: ["Drafting narration changes", "Proposed narration changes"],
  // Edit's script build (server/src/writer/build.ts), in Repack's words.
  set_outline: ["Outlining the script", "Outlined the script"],
  set_opening: ["Choosing the opening", "Chose the opening"],
  add_section: ["Writing a section", "Wrote a section"],
  finish_section: ["Finishing a section", "Finished a section"],
  read_plan: ["Reading the script", "Read the script"],
  review_plan: ["Checking the script", "Checked the script"],
  replace_items: ["Rewriting clips and cut-ins", "Rewrote clips and cut-ins"],
  remove_items: ["Removing clips", "Removed clips"],
  finish: ["Finishing the script", "Finished the script"],
  // The chat's own tools (server/src/writer/turn_tools.ts).
  pull_feedback: ["Pulling the review's feedback", "Pulled the review's feedback"],
  search_web: ["Searching the web", "Searched the web"],
  read_page: ["Reading a page", "Read a page"],
  search_youtube: ["Searching YouTube", "Searched YouTube"],
  read_youtube: ["Reading a video's captions", "Read a video's captions"],
  find_images: ["Finding pictures", "Found pictures"],
};

/** A tool's name for the producer: what it is doing, or what it did. */
export function toolLabel(tool: string, settled: boolean) {
  const [doing, did] = TOOLS[tool] ?? [];
  return (settled ? did : doing) ?? tool.replaceAll("_", " ");
}

/** Tools the agent ran back to back, and where in its answer they happened. */
export type ScriptToolGroup = {
  /** Length of the answer written before these tools ran. */
  at: number;
  calls: ScriptToolCall[];
};
export type ScriptTurnPart =
  | { type: "text"; text: string }
  | { type: "tools"; calls: ScriptToolCall[] };

/** A turn as it happened: what the agent said and the tools it ran, in order. */
export function turnParts(
  text: string,
  trace: ScriptToolGroup[] = [],
): ScriptTurnPart[] {
  const parts: ScriptTurnPart[] = [];
  let from = 0;
  for (const group of trace) {
    const at = Math.min(Math.max(group.at, from), text.length);
    const said = text.slice(from, at).trim();
    if (said) parts.push({ type: "text", text: said });
    parts.push({ type: "tools", calls: group.calls });
    from = at;
  }
  const rest = text.slice(from).trim();
  if (rest) parts.push({ type: "text", text: rest });
  return parts;
}
