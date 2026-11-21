# V1 to V2

Everything needed to make Edit V2 the only way Edit works: out of Beta, no switch, nothing of V1 left to fall back on, and nobody's work broken on the way. Written Nov 21 2026 from the code and from prod's live lists. Update it as steps land; delete it when the last step is done.

Paths are relative to `app/`.

## What the two are

- **V1**: a project has a style (bodycam, interrogation, courtroom, commentary, horror, shorts). The agent works from the files in the repo's `agent/` folder, has a timeline, and lays the house's built-in graphics.
- **V2**: a project belongs to a channel. A channel (or its group) is taught through lessons kept in the cloud, one lane each for ideas, scripts, edits and thumbnails. The agent writes every graphic as code and keeps the good ones in a shared library. There is no timeline.

## Where things stand (prod, Nov 21)

| | Total | On a channel | V1 | V1 touched in the last 7 days |
|---|---|---|---|---|
| Edits | 116 | 11 | 105 | 18 |
| Scripts | 126 | 13 | 113 | 19 |
| Ideas | 42 | 6 | 36 | 1 |
| Thumbnails | 1 | 0 | 1 | 0 |

V1 edits by style: bodycam 44 (12 of them subtitled videos), interrogation 38 (1 subtitled video), courtroom 16, commentary 5, horror 1, shorts 1. V1 scripts: interrogation 32, interrogation compilation 21, FOIA 20, FOIA compilation 18, courtroom 14, courtroom compilation 8. JJ and Marc both made V1 work between Nov 18 and 20.

**The channels**

| Channel | Group | Narration voice | Compilation | Watermark |
|---|---|---|---|---|
| Inspector Ted | with Sam's Bodycam | Andrew | no | yes (Drive) |
| Sam's Bodycam | with Inspector Ted | Andrew | no | yes (Drive) |
| Sam's Interrogations | with Sam's Compilations | Andrew | no | yes (Drive) |
| Sam's Compilations | with Sam's Interrogations | Andrew | yes | yes (Drive) |
| Cuffed & Caught | with Snax Dirt | Andrew | yes | none |
| Snax Dirt | with Cuffed & Caught | Andrew | yes | none |
| GTA 6 Channel | none | Andrew | no | none |
| InternetJanitor | none | none | no | none |
| Female Felons | none | none | no | none |

**What each has been taught**

| | Ideas | Script | Edit | Thumbnails |
|---|---|---|---|---|
| Ted + Sam's Bodycam (group) | 2 | 19 | 23 lessons, 17 effects (14 `v1-`) | empty |
| Cuffed & Caught + Snax Dirt (group) | 2 | 21 | 28 lessons, 21 effects (14 `v1-`), the removal lesson | empty |
| Sam's Interrogations + Compilations (group) | 2 | 10 (+5 and +6 of their own) | 24 lessons, 25 effects (22 `v1-`) | empty |
| Female Felons | 2 | 24 | 24 lessons, 17 effects (14 `v1-`) | empty |
| GTA 6 | none | none | 1 | empty |
| InternetJanitor | none | none | none | empty |

No channel has a Trello board, so channel ideas fall back to the V1 boards (`apps/server/src/ideas/board.ts`). No channel's narration is "recorded", so every channel project has the bodycam style, Sam's Interrogations included.

## How the app decides

**Two switches, and they are different things.**

1. **The Beta switch, per computer, off unless turned on** (Settings › Beta › Edit V2; `<home>/beta.json`, `apps/server/src/beta.ts`, `apps/web/src/lib/beta.ts`). It decides what can be *made*:
   - Off: the Kind (niche) picker, no channels anywhere, the "Niche" column on Home.
   - On: a channel must be picked for every new edit, script, idea and thumbnail (`components/NewWork.tsx`); Home gets the Channels section, the channel filter and the "Channel" column. Commentary scripts and Shorts can't be made (`Home.tsx`: both need no channel). Someone with no channel given to them can make nothing.
   - The server refuses a channel on new work when it's off (`channels.ts` `channelFor`).
2. **`hq` on the project, set when it's made and never after** (`crates/edit-core/src/model.rs`; `store.ts` `createAs`, `routes.ts`, `writer_handoff.ts`). It decides which editor and which agent a project gets, whatever the Beta switch says: the instructions (`agent.ts` `agentInstructions`), the tool list (`mcp/registry.ts` `toolsFor`), coded effects (`effect_tools.ts`), the teaching gate (`teaching_gate.ts`), the passes after each turn (`hq_ears.ts`, `house_words_pass.ts`), and on the page no timeline, video comments instead of notes, the queue with steer and cancel, and the Fable/Opus menu (`Editor.tsx`, `Viewer.tsx`, `AgentPanel.tsx`, `ChatComposer.tsx`).

**Two traps in today's switch.**

- With Beta off on a Mac, an edit made from a channel's script is silently a V1 edit (`writer_handoff.ts` `channelOfImport`).
- With Beta on, V1 scripts' lessons stop reaching the lessons inbox (`writer/lesson_note.ts`): the switch changes V1 too.

**A channel project still has a style**, worked out from its narration: "recorded" is interrogation, anything else bodycam (`channels.ts` `styleOf`). Style-branching code still runs for it (teasers, beds, framing, levels), and access is still granted by style (`kinds.ts`: a channel project needs `edit.bodycam` or `edit.interrogation` as well as the channel).

## What V2 can't do yet

| Area | The gap | Kind |
|---|---|---|
| Courtroom, commentary, horror, shorts | A channel can only be bodycam or interrogation. The code for the other four (`horror_look.ts`, `commentary_*.ts`, `cutin.ts`, parts of `edit_plan.ts`, `onscreen.ts`, `people.ts`) can't be reached from a channel project | Missing feature |
| Subtitled videos | 13 live projects. The `subtitle-video` skill reaches the agent only through the `skill` tool, which channel projects don't have; the kind is tied to style (`kinds.ts`) | Missing feature |
| Commentary and courtroom scripts | A channel script's kind is forced to interrogation (`writer/formats.ts`); commentary scripts need no channel | Missing feature |
| Converting existing work | Nothing sets `hq` on an existing project, and the one route that moves a project to a channel refuses V1 projects and has no button (`channels.ts`, `POST /api/channels/{key}/projects/{id}`). Scripts, ideas and thumbnails can't be given a channel after they're made. The only bridge: New edit › pick a channel › pick a V1 script, which makes a new V2 edit | Missing feature |
| Idea to script | "Write the script" drops the idea's channel (`apps/web/src/ideas/page.tsx`) | Bug |
| Voice-over | The voice comes from the project's style (`voiceover.ts`, four calls to `voiceFor(style)`); the channel's narration voice is only told to the agent in words | Missing wiring |
| Thumbnails | Every Thumbnails lane is empty; channel thumbnails still read `agent/thumbnails/guide.md` (`thumbnails/run.ts`) | Missing content |
| Ideas | No channel has its own Trello board | Missing content |
| Watermarks | Five channels have none. V1's Drive dropdown and per-style default still serve no-channel projects (`channel_marks.ts` `offerFor`, `reviews.ts` `styleWatermark`) | Missing content |
| The lessons inbox | 103 open V1 lessons (bodycam 49, interrogation 23, courtroom 14, FOIA 10, shorts 4, commentary 3) with nowhere to go in V2 | Missing content |
| Timeline | Not in V2; the team wants it (see "The timeline in V2") | By design, never decided |
| Note boxes, changing a project's category | Not in V2 | Deliberate |
| The house's graphics tools (`add_text`, `map_view`, `highlight_evidence`, `reframe`, the commentary tools…) | Removed from the channel tool list (`mcp/registry.ts` `NOT_IN_HQ`); replaced by `v1-<name>` effects in the library. GTA 6 and InternetJanitor have none | Deliberate |

## What the team gains

Graphics written as code with version history, a library the whole team shares, teaching per channel and per group with exceptions, an untaught channel that won't edit until it's taught, text and watermark removal by the channel's own lesson, the passes after each turn (both ears, house words), undo of any change by anyone, a message queue with steer and cancel, and the viewer pinned to the last render while the agent works.

## The timeline in V2

The team wants it back. Looked into on Nov 21 against the code and three real channel projects (one of 3,173 clips on 28 tracks, 2 h 6 min).

**Why there is none.** It was part of V2's first design (Nov 10, "an HQ editor is the viewer and the chat"), with the reasons in the code: "its timeline is the agent's to work" and "a stray S would split a clip nobody can see" (`apps/web/src/components/Editor.tsx`). Nobody decided the team shouldn't see their edit.

**What the V1 timeline would do with a channel project today.** It is one canvas that draws the project's tracks and clips, and almost all of it is generic (`components/Timeline.tsx`, `lib/edit.ts`, `lib/timelineView.ts`). Footage, sound, voice-over, music and made sounds would draw correctly. Four things would draw wrongly:

- An effect is an ordinary video clip that is a window into one render, so it draws as footage, with nothing saying it's an effect or whether its render is current.
- A see-through effect's render holds the picture above its mask at twice the height, and thumbnails are made from the whole frame (`media.ts`), so its strip shows both squashed together.
- Subtitles drawn by effects leave their text clips at opacity 0 (2,028 in one project), and the timeline draws those like visible ones.
- Removal strips and blurs are separate clips on separate tracks, with nothing showing which footage they belong to.

**Why hand edits aren't safe yet.** The agent's effect code stores positions on the timeline inside itself (one project's cut-in graphic holds a list of timeline frames; its subtitles hold "timeline second, words"). The model stays valid when a clip is moved by hand, but nothing knows the graphic is now timed to the wrong moment, and nothing re-renders it. Also: what's beneath an effect is remade only for that effect's first clip (`effect_inputs.ts`); a single-track move, trim or ripple delete leaves effects, subtitles and voice-over behind; the passes after a turn (both ears, house words) don't run after a hand edit; during a turn the viewer plays a pinned version while the timeline would draw the live one; and V1's menus and the T key add the house's text, which V2 forbids.

**The order.**

1. **The timeline shown, read only** (2 to 3 days): see every track and clip, scrub, zoom; nothing can be changed. During a turn it draws the version on screen.
2. **Made exact**: effect clips marked with their render's state, the see-through thumbnails fixed, hidden subtitles dimmed, removal and blurs drawn with their footage.
3. **Select a clip to point the agent at it**: a chip in the chat naming the clip, its time and its effect.
4. **Hand edits on footage and sound** (about a week more): outside a turn only, effect clips locked, the agent told with the next message what the person changed and which effects it touches, the passes run after a hand edit, and the server refusing a save that changes an effect clip.
5. **What's beneath an effect remade for every clip of it**, not only the first.
6. **Only if the team needs it, hand edits on effects** (2 to 4 weeks): effects are handed their place on the timeline instead of storing it, which means the agent's notes and every existing effect taught again.

**What the team wants it for** (Sphe, Nov 21): not mainly to edit by hand, but a quick look over the whole project at where the footage, graphics, sound effects and the rest are placed. So steps 1 to 3 are the ask, and they need none of the hard part. Drawn that way from a real project's data: one row per kind of thing (graphics, captions, cut-ins, footage, looks, subtitles, voice-over, music, sound effects) rather than V1's rows per track, the whole edit fitted to the width, with zoom. The model already says which is which: an effect is a media with `effect`, music and sound effects are `library: "music"` or `"sfx"`, subtitles are the text clips on the subtitles track.

**Pictures and waveforms, asked for on Nov 21 ("like V1, but reliable this time").** Why V1's aren't reliable, from the code and one real project on one machine:

- A picture strip is one sheet per source file, at most 120 pictures spread over its whole length, keyframes only (`apps/server/src/media.ts` `makeThumbs`): a long source gets one every half minute or more, so short clips show a neighbour's picture.
- Sheets and waveforms are made once per file on each computer, as part of import. A sound played from the cloud's library never gets a waveform here: 32 of that project's 181 sound clips (all its music) had none. Two of its graphics had no sheet: 35 of 59 graphics clips.
- The page asks once. A sheet or waveform that fails to load is marked missing until the page is reloaded (`apps/web/src/components/Timeline.tsx` `sprite`, `waveform`), so one slow answer blanks a clip for the session.
- A see-through graphic's sheet shows its picture and its mask squashed together, and nothing remakes a sheet when a graphic is rendered again.

What "reliable" needs: pictures asked for by clip and moment (the frame at that clip's own source time, from the preview already on the Mac or the cloud's), only for what is on screen at the current zoom, kept by the file's content and the moment so every computer and every reopening reuses them; a waveform for any sound wherever it is played from; a graphic's picture cut from the top half of its render and keyed by the render, so a new render brings new pictures; and a miss tried again by itself, never remembered as missing. A close-up drawn this way from the same project needed 397 pictures and 59 waveforms, fetched in 13 seconds.

**Being built** (Sphe's go, Nov 21): the read-only timeline under the viewer of every channel project, a row per kind of thing, pictures and waveforms as above, and the Subtitles row first and locked in place under the ruler so the words are always in view. V2 keeps its video-player keys.

## The `agent/` folder

All 71 files are read into the binary at build time (`agent_files.ts`, a Bun macro; `agent_text.ts` hands them out).

| Files | Read today by | In the channels | Can go when |
|---|---|---|---|
| `writer/cut-in`, `judgment`, `house`, `foia`, `compilation` | V1 scripts only (`writer/formats.ts`) | Yes, word for word, as Script lessons (Nov 18) | V1 scripts end |
| `ideas/bodycam`, `ideas/interrogation`, `shared/thumbnail-frames` | V1 ideas only (`ideas/run.ts`) | Yes, word for word, as `ideas-guide` and `ideas-checks` | V1 ideas end |
| Ten house edit skills (`cut-ins`, `edit-workflow`, `feedback`, `final-pass`, `intro`, `music-and-sound`, `outro`, `research`, `subtitles`, `transitions`) | V1 edits only, through the `skill` tool | Only as a short rewrite (3,260 words against 12,200) | V1 edits end |
| `writer/courtroom`, `writer/commentary` | V1; `commentary` by channel scripts too (`writer/commentary.ts`) | No | A channel can be those kinds |
| `thumbnails/guide` | Every thumbnail, channel or not | No | A Thumbnails lane is taught |
| `skills/subtitle-video`, `skills/resume-edit`, `shared/names-first` | V1 only | No (`resume-edit` as one line) | Subtitled videos have a V2 home |
| All 45 files of `styles/` | V1 only; the style's voice by every project | No | Styles are channels, or dropped |
| `instructions.md` | Every session, channel projects too (`mcp/index.ts`), with a list of skills for a tool they don't have | Not channel material | Trimmed to what V2 needs |
| `hq/notes.md` | Channel projects only | Not channel material: it's how V2 works | Stays |

Deleting `agent/writer` today stops Edit from starting, for everyone: its guides are read as the module loads (`writer/formats.ts`, `writer/commentary.ts`). Deleting `agent/styles` crashes nothing but V1 projects quietly lose their kind's rules. One limit of this check: no route serves a lesson's text, so the comparison used what agents were sent in recent sessions; a lesson a teacher changed after Nov 18 wouldn't show.

## Where the data lives

- **Channels and groups**: the accounts cloud (Convex `channels:*` and `groups:*`, through the relay, `apps/relay/src/authz.ts`), served by `channels.ts`. Dev and prod share one list: the dev relay forwards these calls to the live one (`apps/relay/src/live_channels.ts`). Uploaded watermarks are on R2 under `edit/channels/<key>/watermark/`.
- **Lessons and effects**: the V2 library (`v2_cloud.ts`): a lesson is `skill:@<channel>--<lane>/<name>` (a group's `@gr-<id>--<lane>`), an effect is `effect:<project>/<name>`; versions in Convex (`edit:listLibrary` and friends), files on R2 under `edit/library/sha256/`. The library is per environment, so dev's teaching is its own. Removal is not a lane: it's a lesson named `removal` in the edit lane.
- **An effect's working files** are on the Mac: `<home>/media/<project>/effects/<name>/`.

## What breaks if V2 became the only mode today

- The 105 V1 edits can't be opened as V2 and can't be converted. Flagged `hq` by hand they would lose the timeline and notes, and a running conversation would name tools that no longer exist.
- The 13 subtitled videos, the courtroom, commentary, horror and shorts work, and the 113 V1 scripts' formats have no V2 shape.
- Anyone without a channel given to them, or signed out, could make nothing (`/api/channels` answers an empty list without the cloud).
- V1 shares would lose their watermark (the per-style default).
- Edit wouldn't start if `agent/writer` were removed, and the release build fails if `agent/` is gone.
- About 40 server test files and five web ones pin V1 behaviour (among them `agent_text`, `skills`, `kinds`, `commentary`, `horror`, `shorts`, `edit_plan`, `edit_tools`, `writer/formats`, `writer/plan`, `writer_handoff`); they go or change with each step.

## The order

A proposal, each step small enough for one nightly, each with what proves it.

1. **Shut the silent downgrade.** A channel's script makes a V2 edit or is refused, never a V1 edit (`writer_handoff.ts`); "Write the script" keeps the idea's channel. Proof: a handoff test, and one idea taken to a script by hand.
2. **The channel's voice is the voice-over's voice.** Proof: a voice test, and a spoken line on a channel with its own voice.
3. **Fill what the channels lack**, with no code: watermarks for Cuffed & Caught, Snax Dirt, Female Felons, GTA 6 and InternetJanitor; a Trello board each; a Thumbnails lane taught from `thumbnails/guide.md`; narration for Female Felons and InternetJanitor. Proof: each channel's page shows them; one share carries the mark.
4. **Move to a channel**: a button for scripts, ideas and thumbnails, and for a V2 project (its route exists). Proof: a moved script writes from its lane.
5. **V1 edits in flight**: either they finish as V1, or a conversion that sets the channel and `hq`, keeps the clips and starts a new chat, never during a turn. Proof: a converted copy of a real V1 project opens, plays, exports and shares on dev.
6. **A shape for what V2 can't express**: courtroom, commentary, horror, shorts, subtitled videos. For example a channel carries its kind, which becomes its projects' style instead of the two values of `styleOf`, with the tools those kinds need given back. Proof: a courtroom channel's edit, end to end on dev.
7. **Empty the lessons inbox** into the lanes, and stop `note_lesson`. Proof: the inbox is empty and the lessons are in the lanes.
8. **Beta on for everyone**, the switch kept for one nightly. First: everyone on the team has a channel given to them. Proof: JJ's Mac after the nightly.
9. **Remove the switch and the ways to make V1 work.** V1 projects still open until none has been touched for some weeks.
10. **Remove V1's agent text, tools and tests last.** Proof: a green Check with `agent/` trimmed, and the release build starts.

## For Sphe to decide

- What happens to the 105 V1 edits (18 touched this week) and 113 V1 scripts: finish as V1, convert, or archive.
- Whether a style becomes a channel or something a channel has, and which channel courtroom (16 edits, 22 scripts), commentary (5 edits, 3 scripts: InternetJanitor?), horror, shorts and the 13 subtitled videos belong to.
- The timeline: which of the steps under "The timeline in V2" to build, and how far.
- Whether the house's graphics stay code-only `v1-` effects, and whether GTA 6 and InternetJanitor get them.
- Whether access stays by style or moves to channels alone.
- What becomes of the 103 inbox lessons, and of `instructions.md`.
- Whether someone signed out, or with no channel, may still make anything.

## Not known

Which of the team's Macs have Beta on (it's per computer). Who has been given which channel. How a V1 conversation behaves if its project is made `hq` mid-way. Whether the house's graphics laid through `apply_edit_plan` draw correctly in a channel project (nothing in code blocks them; only `agent/hq/notes.md` tells the agent not to).
