# Nov 20: the Lazarus script's review feedback ("Friendly" Cop…, 104f16c3)

Sphe's notes, from JJ's two review notes the script chat couldn't do:

- **"Do you see the feedback left on the feedback site?"** The chat said nothing reached it. Fixed: the script chat's turns have tools (`writer/turn_tools.ts`); `pull_feedback` takes the script's open review notes. The edit agent's `pull_feedback` now names the same everyday asks.
- **Ready for changes posted one chat message per note.** Fixed: exact notes (suggested words, cuts, editor notes) are still carried out with no model; the rest go to one agent turn that pulls them, fixes them all and answers once. Each note is then resolved, answered or left open with why and released (`fixing.ts settle`); left-open notes used to stay claimed ("Writer is working on it" for good).
- **#5 "search up the other videos… Red File has covered this case".** Fixed: `search_youtube` / `read_youtube`. The caption reader shared with the edit agent's `read_broll_source` never wrote captions (`--dump-single-json` simulates): `--no-simulate`, and empty cached reads are read again.
- **#10 "find a lot of assets and images surrounding the case".** Fixed: `find_images` shows a numbered sheet with each picture's link and page; the agent leaves each one as an `edit:` note on the words it belongs under, which the edit agent already follows.
- **Share dialog showed the comments and a comment box; hovering the green bands popped a glitchy card.** Removed both, and the Fix N notes button and the Ready for changes line with them.

Checked: a copy of the script on its own server with a stand-in relay (nothing reached prod). "Do you see any feedback…? Please apply it." and "Can you please just apply the feedback?" both pulled the two notes, read a video on the case (Red File's in the first run; another channel's captions in the second), added a fact the sources back, left 12 and 14 photo notes across the script, and resolved both notes. The two automatic replies on the live review were deleted. JJ's notes stay open on prod until this ships.
