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

`lookcam_sync/` downloads the camera's own **alarm clips** (motion, ~3 min each) from its SD card, over the local P2P
protocol, every `interval_minutes` (default 60), into `/media/boite_aux_lettres/YYYY-MM-DD/`. Read-only on the camera
(LoginDev, GetTfVideoList, DownloadFile); resumes interrupted downloads; deletes only its own copies after `keep_days`.
Prebuilt image `ghcr.io/badroum/lookcam-sync-{arch}` (nodejs only, nothing is built on the host).

The camera handles one P2P session badly at a time: don't run the live bridge or another downloader in parallel.
A PC can then copy the clips from the `media` Samba share and run the ROI motion analysis locally.
