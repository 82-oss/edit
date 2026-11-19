# Fix next

Issues Sphe hits on the stable Linux prod Edit (nightly-90, 4fa7450f, on mandalorian :7790 / Tailscale :8444). Newest at the bottom; strike through or remove one once it's fixed.

- **Linux tests fail every Linux build, so a release can't pass its Linux check** (Nov 19, run 44527865648 on nightly-90; the same in every `linux-prod-tmp` run since Nov 18). The app runs; the tests are wrong on Linux CI:
  - `apps/server/test/export_ahead.test.ts:305`: no "chunks … already made" line is found in the last 400 log lines after the export made ahead.
  - `apps/server/test/proxy_pieces.test.ts:570`: the PSNR compare of piece 1 reports 31 frames, not 30.
