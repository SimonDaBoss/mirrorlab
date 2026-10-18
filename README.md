# Mirrorlab

**Windows 10/11 x64.** [Download the portable app](https://github.com/SimonDaBoss/mirrorlab/releases/latest) · [Setup and troubleshooting](docs/SUPPORT.md)

Download the Windows ZIP from Releases, extract the whole folder, and open **Mirrorlab.exe**. No Node.js installation is needed for the portable download. Android needs USB debugging; iPhone USB needs Apple's USB driver and the app's optional per-device setup; AirPlay needs Bonjour. Other operating systems are not currently packaged.

Open-source **Android and iPhone** mirroring for your PC: a free, no-watermark, no-time-limit alternative to ApowerMirror, with extras for people who take apps apart — a UI inspector, live logcat, an evidence timeline, and an endpoint that lets Claude (or any MCP client) see and use the phone.

Two engines, one app:
- **Android** — built on the [scrcpy](https://github.com/Genymobile/scrcpy) v5 device server (USB or Wi-Fi, full control, no app installed on the phone).
- **iPhone / iPad** — bundled native helpers for **AirPlay and direct USB QuickTime capture** (view-only, no phone app). [UxPlay](https://github.com/FDH2/UxPlay) handles Bonjour discovery, RTSP, pairing, FairPlay, NTP, encrypted H.264 and AAC-ELD/ALAC. The USB helper uses the pinned [iPhoneMirror](https://github.com/RayrenSX/iPhoneMirror) protocol implementation with its libusb-win32 capture filter. Decrypted H.264 crosses a reliable framed localhost TCP stream into the mirror window; AirPlay audio uses local RTP, USB audio uses framed float PCM.

Video decodes through WebCodecs (GPU-accelerated where available). iPhone audio is decoded by GStreamer and played through Web Audio, including in recordings.

## Discord / OBS streaming

Window capture is clean by default. The phone display is one borderless window; the controls sit in an attached strip beside it. You see one mirror with its controls. Sharing the phone window excludes the strip, side panels, and app notifications, without opening a second video window or enabling a streaming mode.

- **Discord:** Share Your Screen → Applications → choose the phone's **Mirrorlab** window.
- **OBS:** add a **Window Capture** source and select the phone's **Mirrorlab** window. Disable **Capture Cursor** if you do not want your mouse in the stream. Set OBS output to 60 fps if desired; actual phone frame rate still varies.
- Select the phone window rather than **Mirrorlab Controls**, the launcher, or your entire display. Keep the phone window open and restored while capturing.
- Phone sound continues through Mirrorlab once, without duplicate playback. In OBS, enable audio capture on the window source where available, or add an **Application Audio Capture** source for Mirrorlab. Avoid capturing the same audio again through Desktop Audio.
- Drag the grip above the controls to move both together. The small minimize and close buttons apply to the mirror. Resizing the phone or rotating it keeps the controls attached.

See the [OBS window capture guide](https://obsproject.com/kb/window-capture-sources), [OBS application audio guide](https://obsproject.com/kb/application-audio-capture-guide), and [Discord screen sharing guide](https://support.discord.com/hc/en-us/articles/360040816151-Go-Live-and-Screen-Share).

## iPhone / iPad (AirPlay)

1. Turn on **Receive AirPlay** in Mirrorlab (on by default) — it advertises your PC on the network.
2. iPhone and PC on the **same Wi-Fi**.
3. On the iPhone: **Control Center → Screen Mirroring → Mirrorlab**.

iOS mirroring is **view-only**, with sound, mute, screenshots, recording, and the evidence timeline. One iPhone/iPad can stream at a time. Stop Screen Mirroring on the phone to disconnect; select Mirrorlab again to reconnect. Closing the mirror window restarts the receiver for the next connection.

The native Windows x64 receiver is included in the portable build. It uses the existing **Bonjour Service** (already present on the development machine); another PC needs Apple's Bonjour service installed and running. If Windows Firewall prompts, allow the bundled `resources/airplay/win32/uxplay.exe` receiver on your private network. Guest Wi-Fi and client isolation can prevent discovery. DRM-protected apps may show black video; protected-content playback is not implemented.

The iOS display path preserves every compressed H.264 reference frame and paces decoded output by sender timestamps with a short jitter buffer. It catches up after stalls by discarding decoded display frames. Tests exercise encrypted native AirPlay at 60 fps, a forced display stall, audio, screenshots, recording and reconnect. The sender controls its actual capture rate and can send fewer frames on a stationary screen.

## iPhone / iPad (USB — experimental)

USB capture uses the same per-device driver approach as iPhoneMirror: the signed libusb-win32 1.2.6.0 filter is added to your iPhone only, on top of Apple's own USB driver (nothing is replaced). That filter can switch the phone into its hidden QuickTime capture configuration (5 on current iPhones). The previous UsbDk backend could never do this, because UsbDk only builds pipes for configuration 1.

1. Install Apple Devices (Microsoft Store) or iTunes so Windows has Apple's USB driver. Connect a data cable, unlock the phone, and accept **Trust This Computer**.
2. Its card appears automatically. Choose **Set up USB** once and approve the Windows administrator prompt. If the card then says to reconnect, unplug and replug the iPhone.
3. Choose **Mirror with USB**. No Screen Mirroring selection or Wi-Fi connection is needed for this path.
4. Closing the mirror or quitting the app ends the QuickTime session and returns the iPhone to its normal USB mode.

**Repair USB** re-runs setup for that iPhone. To remove the filter, run `resources\usb\win32\usb-driver.ps1 -Serial <UDID> -Result out.json -Remove` from an administrator PowerShell. The helper writes a diagnostic log to `%TEMP%\mirrorlab-usb.log`. If Windows Memory Integrity blocks `libusb0.sys`, Windows will show a driver-blocked notice; use AirPlay in that case.

## Quick start (Windows)

1. On the phone: **Settings → About phone →** tap **Build number** 7 times, then **Developer options → USB debugging** on.
2. Plug the phone in and accept **Allow USB debugging**.
3. **Close ApowerMirror.** It ships its own adb, and two different adb versions keep killing each other's server.
4. Double-click **`Start Mirrorlab.cmd`**. The first run installs dependencies (needs [Node.js 20+](https://nodejs.org)). Then press **Mirror**.

To get a standalone `Mirrorlab.exe` without Node, run **`Build portable app.cmd`**. The result lands in `out\Mirrorlab-win32-x64\`.

adb and the scrcpy server are bundled, so there's nothing else to install.

**No cable?** Android 11+: Developer options → Wireless debugging → *Pair device with pairing code*, then use **Pair** and **Connect** in Mirrorlab. If the phone is plugged in, **Go wireless** switches it to Wi-Fi for you.

**LDPlayer / BlueStacks:** enable ADB in the emulator's settings, then connect to `127.0.0.1:5555`.

## What you get

| | Mirrorlab | ApowerMirror |
|---|---|---|
| Price | Free; Apache-2.0 app with separate GPL native receiver | Free tier + paid VIP |
| Watermark / session limit | None | Free tier: watermark, 10-minute sessions (reported) |
| Resolution | Native or capped (presets) | Free tier: low resolution (reported) |
| Mouse + keyboard control | Yes, including IME/emoji text and multi-touch from touchscreens | Yes (Android) |
| Several phones at once | Yes, one window each | Up to 4 (VIP) |
| Screenshot / recording | PNG (also copied) / MP4 or WebM with phone audio | Yes |
| Phone audio on PC | Yes (Android 11+ and iPhone/iPad) | Not listed in the reviews used |
| Clipboard sync | Both directions; Ctrl+V pastes PC → phone | Not listed |
| Phone screen off while mirroring | Yes | Not listed |
| Drag-and-drop | APKs install, files go to Download/ | Not listed |
| UI inspector, live logcat, evidence timeline | Yes | No |
| AI agent control (MCP) | Yes, local and token-protected | No |
| Auto-start, pop-ups | No | Reported by users |
| iPhone | AirPlay + USB capture; sound, screenshots and recording | Yes (mirroring only, no control) |

The ApowerMirror column comes from third-party reviews (one by a competitor, AirDroid), so check the current tiers yourself.

## Controls

| Input | Does |
|---|---|
| Left click / drag | Tap / swipe |
| Right click | Back (or wake screen) |
| Middle click | Home |
| Wheel | Scroll |
| Typing | Text goes to the focused field (works with IMEs) |
| Ctrl+V | Paste PC clipboard on the phone |
| Alt+H / B / S | Home / Back / Recents |
| Alt+P, Alt+↑/↓ | Power, volume |
| Alt+R | Rotate |
| Alt+N | Notifications |
| Alt+O | Phone screen off/on (mirroring continues) |
| Alt+K | Screenshot |
| Alt+I / L / T | Inspector / Logcat / Timeline panel |
| Alt+F | Fullscreen |
| F12 | Stream stats |

## Reverse-engineering extras

* **Inspector**: captures the accessibility tree. Turn on pick mode, hover the mirror to see element bounds, and click to get class, text, resource ID and content description, each with a copy button.
* **Logcat**: a live device log with tag/text/PID filter and level filter.
* **Timeline**: records every input (yours and the agent's), notes, and screenshots, saved continuously to `Documents\Mirrorlab\Timelines\`. *Evidence mode* adds a screenshot after each of your taps, and *Export report* writes one self-contained HTML file you can share.

For deeper work (decompiling the APK, Frida hooks, network captures), run [REA](https://github.com/morluto/rea) next to Mirrorlab. Both are MCP servers, so one agent can drive the app through Mirrorlab while it inspects the code with REA, and leave notes on the same timeline.

## AI agent (MCP)

Mirrorlab listens on `http://127.0.0.1:47800/mcp` (localhost only, bearer token, Host-header check). Copy the setup command from the main window. For Claude Code:

```
claude mcp add --transport http mirrorlab http://127.0.0.1:47800/mcp --header "Authorization: Bearer <token>"
```

Tools: `list_devices`, `screenshot`, `tap`, `swipe`, `type_text`, `press_key`, `ui_tree`, `tap_element`, `launch_app`, `list_packages`, `logcat`, `timeline`.

The agent can only act on a device whose mirror window is open, and every action flashes purple on the mirror and lands on the timeline. Coordinates are in screenshot pixels (longest edge ≤ 1280).

## Develop

```
npm install
npm run build:airplay # Windows x64 native receiver; only needed if rebuilding native components
npm run build:usb     # Windows x64 QuickTime USB helper and libusb0 capture driver payload
npm start            # build + run
npm test             # unit + fake-device integration tests
npm run test:e2e     # full app under Playwright (Linux needs xvfb-run)
```

`test/fake-adb.mjs` emulates adb plus the scrcpy server. It streams real H.264 video and Opus audio, records every control byte, and serves a UI dump, so the whole app can be tested without a phone. Point the app at it with `MIRRORLAB_ADB=test/fake-adb.mjs`. To use a different real adb, set `MIRRORLAB_ADB` to its path.

```
src/shared/protocol.ts     scrcpy v5 wire protocol (control, device messages, media demuxer)
src/main/scrcpy/session.ts push server → adb forward → sockets → demux
src/main/controller.ts     tap/swipe/type/keys over the control socket
src/main/extras/           inspector, logcat, timeline, MCP agent endpoint
src/renderer/              launcher, mirror window, WebCodecs video/audio
```

## License

The Mirrorlab application is Apache-2.0. scrcpy-server and adb are Apache-2.0. The separate UxPlay and USB helper programs are GPL-3.0-or-later; dependencies retain their licenses. Corresponding sources and build details accompany them under `resources/airplay/source/` and `resources/usb/source/`; see `NOTICE`.
