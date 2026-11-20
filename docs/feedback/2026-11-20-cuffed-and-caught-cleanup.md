# Cuffed & Caught cleanup

Edit retried several failed cleaning stretches in Boyfriends and SMART Cops on a rented worker that kept returning `CUDA unknown error`. The worker now reports the failure, then retires so the relay can send the retry to another pod. A simulated worker run verified this sequence, and verified that successful jobs and other failures leave the pod available. The production retry still needs verification on the deployed worker.
