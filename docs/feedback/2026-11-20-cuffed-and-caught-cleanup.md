# Cuffed & Caught cleanup

Edit retried several failed cleaning stretches in Boyfriends and SMART Cops on a rented worker that kept returning `CUDA unknown error`. The worker now reports the failure, then retires so the relay can send the retry to another pod. A simulated worker run verified this sequence, and verified that successful jobs and other failures leave the pod available. The production retry still needs verification on the deployed worker.

On SMART Cops, watermark strips could cover cleaned subtitles, the subtitle detector missed red lines near the centre, and the watermark remover left readable outlines against dark backgrounds. The fixes in `2a55bb00` corrected the strip order on a copy of the project and reduced the residual watermark on three source samples. A new production render still needs checking.
