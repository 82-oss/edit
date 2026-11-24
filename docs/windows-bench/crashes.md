# mandalorian's crashes, Nov 7–24, 2026

From `journalctl --list-boots`, the kernel log, sysstat (`sar`, every 10 min, kept from Nov 16) and the notes the
sessions left at the time. Machine: Ryzen 9 5900XT (32 threads), 31 GB RAM, RTX 4060 8 GB, NVIDIA 615, Ubuntu 26.04.
No per-process VRAM history is kept; the driver's own errors say when the card ran out.

## Summary

6 unplanned restarts in 17 days, all between Nov 15 and Nov 23. None since (current boot: Nov 23 00:09, 41 h+).

| # | when it went down | cause | RAM free before | CPU | GPU |
|---|---|---|---|---|---|
| 1 | Nov 15 19:04 | unknown (12-minute boot, log just stops) | no data | no data | no errors |
| 2 | Nov 17 09:43 | **RAM** ran out → froze; power key, hard reboot | 22.4 → 0.55 GB in 30 min, 8 GB swap full | 91% idle (thrashing, load 17) | VRAM full (`NV_ERR_NO_MEMORY`) from 09:24 |
| 3 | Nov 19 10:52 | **RAM** ran out → froze after 35 OOM kills | 4.2 → 0.24 GB, 8 GB swap full all morning | 48% iowait, load 81, 41 tasks stuck | a few BAR1 errors |
| 4 | Nov 19 16:10 | unknown (log just stops) | 14.7 GB, swap 4% | 77% idle | no errors |
| 5 | Nov 22 21:13 | **GPU driver wedged** (BAR1 address space) | 19.8 GB | 96% idle, load 65 (stuck tasks) | ~890k errors a second at the end |
| 6 | Nov 23 00:08 | **GPU driver wedged** again, a minute after #5's reboot | 20.9 GB | 96% idle, load 105 (stuck tasks) | same flood |

The two kinds share one shape: many agents and test runs on one box with nothing capping their sum, beside prod
Edit's own work. CPU was never the problem (idle while it hung).

## What took the most

**#2, Nov 17 (no kernel dump: the OOM killer never fired before it froze).** From that session: the watermark-lab
Python holding whole clips as float32, ~14–18 GB (13.8 GB again right after the reboot, killed); one Claude agent's
scope peaking 8.3 GB; a trial Edit server 3.1 GB; `/tmp` (RAM-backed tmpfs) up to 12 GB; commit 169% of RAM.

**#3, Nov 19 (kernel's task table at the last OOM kill, 10:39, summed by process name):**

| process | RSS |
|---|--:|
| edit (Edit servers: prod + trials) | 10.9 GB |
| chrome | 7.7 GB |
| edit-ffmpeg | 2.2 GB |
| python (MiniMax GPU benches) | 2.1 GB |
| node | 0.9 GB |
| cubo | 0.65 GB |
| helium | 0.6 GB |
| claude | 0.6 GB |
| bun | 0.5 GB |

The 35 kills before it, from 08:13: python 12.8 GB and 5.1 GB, then a run of ~2 GB benches killed one after another
(10:20–10:39), each under its own 6–8 GB cap: a per-job cap doesn't save the machine when the sum exceeds RAM.
Commit was 348% of RAM.

**#5 and #6, Nov 22–23.** The whole server test suite (Chrome/WebGPU, CUDA FFmpeg, RIFE) beside prod's text
removal and exports. The driver ran out of BAR1 mapping space (what the CPU maps of the 8 GB card), not RAM. Tasks
stuck for good: chrome ×4, Xwayland, gnome-shell, ffmpeg, nvidia-modeset (#5); chrome ×4, gnome-shell, Bun,
tokio, a Vulkan worker (#6). SIGKILL can't clear those; only a reboot does. The first such error that day came at
08:36, with only prod's work running, so prod's load alone gets near it too.

## Raw log, the last lines before each

```
#2 Nov 17
09:24:23 kernel: NVRM: GPU0 nvCheckOkFailedNoLog: Check failed: Out of memory [NV_ERR_NO_MEMORY] ... mem_desc.c:1348
09:42:47 gnome-shell: libinput error: ... event processing lagging behind by 39ms, your system is too slow
09:42:51 at-spi2-registryd: Disabling unresponsive app with pid 12985
09:42:54 systemd-logind: Power key pressed short.
sar 09:40  kbavail 552140   swap used 8388604 (100%)   %commit 168.66

#3 Nov 19
08:40:52 kernel: Out of memory: Killed process (python) anon-rss:12.8GB
10:39:06 kernel: Out of memory: Killed process 858355 (python) total-vm:40755576kB, anon-rss:2031920kB ...
sar 10:51  kbavail 244508   swap 100%   %commit 348.48   %iowait 47.89   load 81, blocked 41
10:52:06 tailscaled: creating dns cleanup: route ip+net: no such network interface   (last line)

#4 Nov 19
sar 16:10  kbavail 14703804   swap 4.14%   idle 76.6%
16:10:38 tailscaled: magicsock: new contact: peer=[ACVeP] ... via=direct   (last line)

#5 Nov 22
08:36:03 kernel: NVRM: dmaAllocMapping_GM107: can't alloc VA space for mapping.   (first of the day)
20:12:00 kernel: NVRM: nvAssertOkFailedNoLog: Assertion failed: Out of memory ... kbusMapFbAperture_HAL
21:13:08 kernel: NVRM: --- last print repeated 891154 times ---   (last line)

#6 Nov 23
21:14:57 kernel: NVRM: dmaAllocMapping_GM107: can't alloc VA space for mapping.   (a minute after boot)
21:27     29 more as the --parallel test run started; then the flood
00:08:32 kernel: NVRM: --- last print repeated 901893 times ---   (last line)
```

## What changed after

- Heavy jobs and test runs under `systemd-run --scope -p MemoryMax=6G`, one at a time, scratch in `~/.cache` not `/tmp`.
- Swap grew from 8 GB to 23 GB (by Nov 19 afternoon).
- `gpu-guard` frees the card (kills Edit's drawing Chromes) before the driver wedges: 0 trips since Nov 23
  (`~/.cache/gpu-guard.log` empty); 2 address-space errors since, Nov 23 00:55, no wedge.
- GPU tests never run beside prod's GPU work; the whole suite goes to CI.

## On Windows / WSL2

The same load would hit the same 31 GB and the same 8 GB card. What changes is how it fails: WSL2's `.wslconfig`
memory cap kills inside the VM while Windows stays up (cap it at ~20–24 GB), and Windows resets a hung GPU driver
in seconds (TDR) instead of needing a reboot. Neither makes the load fit; the caps above still apply inside WSL.
