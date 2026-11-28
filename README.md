# LookCam Bridge (Home Assistant add-on)

Local, cloud-free bridge for cheap P2P cameras that use the **LookCam** app (PPPP / CS2 protocol, e.g. MEIQ V99).
It talks to the camera on the LAN, pulls the H.264 stream and republishes it as RTSP with MediaMTX:

```
rtsp://<home-assistant-host>:8554/v99
```

Then add it in Home Assistant as a *Generic Camera* (stream source `rtsp://127.0.0.1:8554/v99`).

## Install

1. Settings > Applications > Store > ⋮ > Repositories > add `https://github.com/badroum/lookcam-bridge`.
2. Install **LookCam Bridge**. The image is prebuilt (`ghcr.io/badroum/lookcam-bridge-{arch}`): nothing is compiled on the host.
3. Options: `camera_ip`, `password` (camera password from the LookCam app), `state` (`1` = HD, `2` = SD).

Supported: `aarch64` (Raspberry Pi 3/4/5 64-bit), `amd64`.

## Security notes

These cameras are insecure by design (weak PPPP obfuscation, password not enforced by firmware, plaintext cloud uploads).
Keep the camera **off the internet** (block it on your router) and only reach it locally through this bridge.

## Protocol (LookCam 1.3.12)

- Handshake: LAN search `F1 30` → camera `PunchPkt (F1 41)` → client `PunchPkt` + `P2pRdy (F1 42)` → camera `P2pRdy`.
- Commands: DRW channel 1, `A0 AF AF AF | 00 | tz | u64le ts | 8×00 | u32le len | JSON | F4 F3 F2 F1`
  (`LoginDev`, `OpenVideo` with `state` 1/2/0).
- Video: DRW channel 0, 83-byte frame header (`01 AF AF AF`), then H.264 Annex-B.
- DrwAck sub-type `0xD1`.

Builds on ideas from [cam-reverse](https://github.com/DavidVentura/cam-reverse) and
[Wladimir Palant's PPPP research](https://palant.info/2025/11/05/an-overview-of-the-pppp-protocol-for-iot-cameras).

## LookCam Sync (second add-on)

`lookcam_sync/` downloads every recording from the camera's SD card (whatever the segment length set in the camera app), oldest first, over the local P2P
protocol, every `interval_minutes` (default 60), into `/media/boite_aux_lettres/YYYY-MM-DD/`. Read-only on the camera
(LoginDev, GetTfVideoList, DownloadFile); resumes interrupted downloads; deletes only its own copies after `keep_days`.
It remembers fetched clips in `/data/fetched.json`, so a consumer may move clips off the share (e.g. `robocopy /MOV`, excluding `*.part`) without them being fetched again.
Prebuilt image `ghcr.io/badroum/lookcam-sync-{arch}` (nodejs only, nothing is built on the host).

The camera handles one P2P session badly at a time: don't run the live bridge or another downloader in parallel.
Option `max_gb` caps the share (~6.5 GB per day of footage): once reached, the round stops and the rest waits for the next one.
Names listed in `/media/boite_aux_lettres/already_on_pc.txt` (one per line, written by the PC) are never fetched.
At start-up, a first round lists the whole SD card and fetches every missing recording (oldest first). The regular rounds
then list only the SD pages recorded after the newest clip already fetched or already on the PC (the list is
newest-first), with a full listing once a day to catch older gaps. Option `log_level` (`debug`, `info`, `warning`,
`error`; default `info`) sets the detail of the log: `info` shows the listing progress, the plan and each download with
what is left; `debug` adds every page, every skipped file and the download progress every 15 s.
Option `download_order`: `oldest_first` (default; the SD card overwrites its oldest files first) or `newest_first`.
The add-on keeps the point up to which everything is fetched in `/data/complete_until.txt`, so a regular round lists
down to it, and older recordings still waiting (newest_first, storage budget) are not skipped.

A PC can then copy the clips from the `media` Samba share and run the ROI motion analysis locally.

### Motion segments (0.4.0)

Home Assistant can send a motion time (`YYYYMMDDHHMMSS`, local time) on the add-on stdin:

```yaml
action: hassio.addon_stdin
data:
  addon: <slug>_lookcam_sync
  input: "{{ now().strftime('%Y%m%d%H%M%S') }}"
```

The add-on waits until the segment covering that time is finished on the SD card, downloads it into
`/media/boite_aux_lettres_mouvements/YYYY-MM-DD/` (never purged, outside `max_gb`, not emptied by the PC) and fires
the event `lookcam_sync_mouvement` (`heure`, `ok`, `fichiers`, `jour`, `dossier`, or `erreur`).

### File server for the PC (LookCam Sync 0.5.0)

Set `pc_transfer: http` and `http_token` (at least 16 characters) to let the PC fetch the recordings over HTTP instead of the Samba add-on.
LAN only, `Authorization: Bearer <token>` on every request, port `http_port` (8099):
`GET /list` (`{files:[{day,name,size,mtime}], parts:["day/name"]}`), `GET /file/<day>/<name>` (Range supported),
`POST /done {"files":["day/name" | {day,name,size}]}` (deletes copied files; with a size, only if it matches),
`POST /have {"names":[...]}` or `PUT /have` (one name per line), both replace `already_on_pc.txt`, `GET /health`.

### Camera settings (LookCam Sync 0.5.7)

The add-on reads the camera settings at every round (SD card, alarm, image, infrared LED; never `GetDevInfo`, which
returns the Wi-Fi credentials) into `/data/camera/config.json`, keeps a dated copy in `/data/camera/backup/` on every
change and before every write, and publishes `sensor.lookcam_sync_camera` (recording / not recording / recording off /
no card / card error). It writes settings only on request, each value checked against an allow-list
(`camera.cjs`), then read back:

- options `camera_*` (all optional, empty = unchanged), sent once at the first round after they change;
- stdin: `input: {"camera": {"carte": {"openRes": 1}, "image": {"brightness": 30}}}`, or `{"camera": "read"}`;
- file server: `POST /camera {"changes": {...}}` or `{"read": true}` (202, then applied between two downloads),
  `GET /camera` (`{config, result, pending}`).

Sections and fields: `carte` (`openRes`, `alarmRes`, `loopRes`, `audio` 0/1, `videoCycle` 60-3600 s by 60),
`alarme` (`sensitivity` 0-3, `putalarm`, `osd`, `audio`, `flag` 0/1, `goptime` 0-600, `starttime`, `endtime`,
`twotime`, `twoend` "HH:MM"), `image` (`brightness`, `saturation`, `contrast`, `hue` 0-63), `ir` (`control` 0-2,
times, `flag`). Never sent: reboot, reset, clock, SD format, file deletion, password, Wi-Fi, exposure. Each write
fires `lookcam_sync_camera` (`ok`, `source`, `demande`, `avant`, `apres`, `refus`). A due motion goes first.

### Camera clock (LookCam Sync 0.5.8)

Without internet the camera restarts at 01/01/1970 after a power cut and names its recordings `19700101-…`.
With `camera_clock_sync: auto` (default) the add-on sends `AppointDev` with `state: 3` only (SYNC_TIME; states 1,
2 and 4 restart or reset the camera and are never sent), `time` = local time in seconds counted as UTC, `zone` =
offset in hours, `zone_s` = offset in seconds, from the Home Assistant time zone. It does so when the recording in
progress has a 1970 name, when the newest recording is far behind or ahead of the host clock (at most every 6 h),
when the daylight saving offset changed since the last sync, and once after the update (`/data/camera/clock.json`).
1970 recordings are still downloaded (folder `1970-01-01`) but kept out of the watermark and the lag.
