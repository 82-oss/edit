# Boyfriends intro: their subtitles out with MiniMax (Nov 19)

Intro of p1794942765038-42080 ("When Cops Rescue Boyfriends…") run in a hidden test copy (p1795081076902-4597) on prod Edit, mandalorian.

- **Stop didn't stop the blur queue.** Two stopped compilations kept ~190 tracks queued ahead of everything else. Fixed in ce2e7814 (Stop lets go of the project's queued tracks).
- **Same stretch cleaned twice.** Two `ensure` calls at once each queued it (4 of 13). Fixed: text_inpaint ensure runs one at a time a project.
- **ARRESTFLIX came back under the cleaned words.** The model cleaned the original picture, and its strip sat over the watermark strip. Fixed: the worker lays the file's watermark strips on the picture first; a stretch waits while its watermark piece is still being made; the strip's name says which watermark strips it went over.
- **Not fixed (detection, the tracker):** a short "No" in the 0.80x B-roll copy read as no words; a subtitle under the glitch transition isn't planned (fillsFrame counts the transition as covering). CCTV 1 / CAM 1 are the camera's own labels, kept by the rule.
