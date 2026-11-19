# Boyfriends intro: their subtitles out with MiniMax (Nov 19)

Intro of p1794942765038-42080 ("When Cops Rescue Boyfriends…") run in a hidden test copy (p1795081076902-4597) on prod Edit, mandalorian.

- **Stop didn't stop the blur queue.** Two stopped compilations kept ~190 tracks queued ahead of everything else. Fixed in ce2e7814 (Stop lets go of the project's queued tracks).
- **Same stretch cleaned twice.** Two `ensure` calls at once each queued it (4 of 13). Fixed: text_inpaint ensure runs one at a time a project.
- **ARRESTFLIX under the subtitles.** The agent reported the model's strip putting the watermark back. Fixed in a35f668d/6bb32205 regardless (the worker cleans over the file's watermark strips; a stretch waits for its watermark piece; strips are told by name, since a cloud backup turns their path into a URL). In this intro, though, the bottom ARRESTFLIX was never found by the watermark engine (its strip is at the top of the picture), so it shows as in the source in v1 and v2 alike. Open: the engine finding that bottom mark.
- **Not fixed (detection, the tracker):** a short "No" in the 0.80x B-roll copy read as no words; a subtitle under the glitch transition isn't planned (fillsFrame counts the transition as covering). CCTV 1 / CAM 1 are the camera's own labels, kept by the rule.
