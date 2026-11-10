# LookCam sync (PC side)

Runs on a Windows/Linux PC, **not** on the Home Assistant host. Each run:

1. copies the finished recording segments written by the add-on (`/share/lookcam/v99`, Samba `\\<ha>\share\lookcam\v99`) that were not fetched yet;
2. detects motion **only inside the ROI** (e.g. the mailbox) using ffmpeg's scene score;
3. keeps a clip (`clips/YYYY-MM-DD/…mp4`, 5 s before → 10 s after) and a thumbnail, drops the raw copy.

If the share is unreachable (not on the network / VPN down) the run exits and the next one catches up,
as long as the add-on's `retention_days` is longer than your absence.

## Setup (Windows)

```powershell
winget install Gyan.FFmpeg          # if ffmpeg is missing (Node.js is required too)
cd <this folder>
powershell -ExecutionPolicy Bypass -File .\install-task.ps1
node lookcam-sync.cjs --preview     # writes C:\LookCam\preview.jpg with the ROI in red
```

Edit `config.json` → `roi` (fractions of the frame) until the red box covers the mailbox, and `threshold`
(lower = more sensitive). Logs: `C:\LookCam\sync.log`.
