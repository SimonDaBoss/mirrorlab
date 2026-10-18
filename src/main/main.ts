import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, screen, shell, type WebContents } from "electron";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Adb, resolveAdb, shellQuote } from "./adb";
import { DeviceController } from "./controller";
import { MirrorSession } from "./scrcpy/session";
import { startAgentEndpoint, type AgentEndpoint, type AgentHub, type MirrorHandle } from "./extras/agent";
import { dumpUi } from "./extras/inspector";
import { LogcatStream } from "./extras/logcat";
import { Timeline } from "./extras/timeline";
import { AirplayReceiver, type AirplayDevice } from "./airplay/receiver";
import { TestKeyProvider, type KeyProvider } from "./airplay/crypto";
import { NativeAirplayReceiver } from "./airplay/native";
import { UsbIphoneSession, listUsbIphones, usbSupport, installUsbDriver, type UsbIphone } from "./ios/usb";
import { CodecId, ControlType, codecName, encodeScanFile, encodeSimple, type StreamEvent } from "../shared/protocol";
import { defaultSettings, type DoctorReport, type Settings, type WireStreamEvent } from "../shared/types";

const appRoot = path.join(__dirname, "..", "..");
const resourcesDir = app.isPackaged ? process.resourcesPath : path.join(appRoot, "resources");
const rendererDir = path.join(appRoot, "dist", "renderer");
const preload = path.join(appRoot, "dist", "preload", "preload.js");
const serverJar = path.join(resourcesDir, "scrcpy-server");

// For tests: isolate user data.
if (process.env.MIRRORLAB_USER_DATA) app.setPath("userData", process.env.MIRRORLAB_USER_DATA);

const adbInfo = resolveAdb(resourcesDir);
const adb = new Adb(adbInfo.file);

// ------------------------------------------------------------------ settings

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
let settings: Settings;

function loadSettings(): Settings {
  let stored: Partial<Settings> = {};
  try {
    stored = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
  } catch {
    /* first run */
  }
  const s = { ...defaultSettings(), agentToken: randomBytes(24).toString("base64url"), ...stored } as Settings;
  saveSettings(s);
  return s;
}

function saveSettings(s: Settings) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}

// ------------------------------------------------------------------ mirrors

interface Mirror {
  serial: string;
  kind: "android" | "ios";
  window: BrowserWindow;
  controlsWindow?: BrowserWindow;
  controlsWidth?: number;
  placeControls?: () => void;
  session?: MirrorSession;
  controller?: DeviceController;
  logcat?: LogcatStream;
  timeline?: Timeline;
  captures: Map<number, (png: Buffer) => void>;
  recording?: { stream: fs.WriteStream; file: string };
  lastClipboard: string;
  evidenceMode: boolean;
  /** iOS only: the receiver feeding this window. */
  airplay?: AirplayReceiver | NativeAirplayReceiver | UsbIphoneSession;
  videoSize?: { width: number; height: number };
  rendererReady?: boolean;
  pendingVideo?: WireStreamEvent[];
  pendingVideoBytes?: number;
}

const mirrors = new Map<string, Mirror>();
let launcher: BrowserWindow | undefined;
let agent: AgentEndpoint | undefined;
let agentError: string | undefined;
let captureSeq = 0;

// The iOS AirPlay receiver (one per app; each mirroring iPhone gets a window).
let receiver: AirplayReceiver | NativeAirplayReceiver | undefined;
let receiverError: string | undefined;
let iosKeyProvider: KeyProvider | undefined;
const usbSessions = new Map<string, UsbIphoneSession>();
const usbErrors = new Map<string, string>();
let usbDevices: UsbIphone[] = [];
let usbScan: Promise<UsbIphone[]> | undefined;
async function scanUsbIphones() {
  const withErrors = (list: UsbIphone[]) => list.map((d) => ({ ...d, captureError: usbErrors.get(d.serial) }));
  if (usbSessions.size) return withErrors(usbDevices);
  return usbScan ??= listUsbIphones(resourcesDir).then((list) => withErrors(usbDevices = list)).finally(() => usbScan = undefined);
}

const timelineRoot = () => path.join(app.getPath("documents"), "Mirrorlab", "Timelines");
const shotsDir = () => path.join(app.getPath("pictures"), "Mirrorlab");
const videosDir = () => path.join(app.getPath("videos"), "Mirrorlab");

function toWire(ev: StreamEvent): WireStreamEvent {
  if (ev.kind === "packet") return { ...ev, pts: ev.pts === null ? null : Number(ev.pts) };
  if (ev.kind === "session") return { kind: "session", width: ev.width, height: ev.height };
  return ev;
}

function send(wc: WebContents, channel: string, ...args: unknown[]) {
  if (!wc.isDestroyed()) wc.send(channel, ...args);
}

// The phone window itself is the capture target. Controls live in an attached
// native window, so window capture never includes the toolbar or side panels.
function attachControls(m: Mirror) {
  const controlsUrl = pathToFileURL(path.join(rendererDir, "controls.html")).href;
  m.controlsWidth = 52;
  let placing = false;
  let onLeft = false;
  const place = () => {
    const controls = m.controlsWindow;
    if (!controls || controls.isDestroyed() || m.window.isDestroyed()) return;
    const b = m.window.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    const width = m.controlsWidth ?? 52;
    onLeft = b.x + b.width + width > area.x + area.width;
    placing = true;
    controls.setBounds({ x: onLeft ? b.x - width : b.x + b.width, y: b.y, width, height: b.height });
    placing = false;
  };
  m.placeControls = place;
  m.window.webContents.setWindowOpenHandler(({ url }) => {
    if (url !== controlsUrl || (m.controlsWindow && !m.controlsWindow.isDestroyed())) return { action: "deny" };
    return { action: "allow", overrideBrowserWindowOptions: {
      parent: m.window, frame: false, skipTaskbar: true, resizable: false,
      width: 52, height: m.window.getBounds().height, backgroundColor: "#12151a",
      webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false },
    } };
  });
  m.window.webContents.on("did-create-window", (controls) => {
    m.controlsWindow = controls;
    controls.setMenu(null);
    controls.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    controls.webContents.on("will-navigate", (e, url) => { if (url !== controlsUrl) e.preventDefault(); });
    controls.on("move", () => {
      if (placing || m.window.isDestroyed()) return;
      const b = m.window.getBounds();
      const c = controls.getBounds();
      const x = onLeft ? c.x + c.width : c.x - b.width;
      if (b.x !== x || b.y !== c.y) m.window.setPosition(x, c.y);
    });
    controls.on("closed", () => { m.controlsWindow = undefined; if (!m.window.isDestroyed()) m.window.close(); });
    place();
  });
  m.window.on("move", place);
  m.window.on("resize", place);
}

function openMirror(serial: string): Mirror {
  const existing = mirrors.get(serial);
  if (existing && !existing.window.isDestroyed()) {
    if (existing.window.isMinimized()) existing.window.restore();
    existing.window.focus();
    return existing;
  }
  const area = screen.getPrimaryDisplay().workAreaSize;
  const h = Math.round(area.height * 0.85);
  const win = new BrowserWindow({
    width: Math.round(h * 0.5) + 56,
    height: h,
    frame: false,
    minWidth: 260,
    minHeight: 320,
    title: `Mirrorlab — ${serial}`,
    backgroundColor: "#0b0d10",
    alwaysOnTop: settings.alwaysOnTop,
    webPreferences: { preload, contextIsolation: true, sandbox: false, autoplayPolicy: "no-user-gesture-required", backgroundThrottling: false },
  });
  win.setMenuBarVisibility(false);
  const m: Mirror = {
    serial,
    kind: "android",
    window: win,
    logcat: new LogcatStream(adb, serial, (lines) => send(win.webContents, "mirror:logcat", lines)),
    captures: new Map(),
    lastClipboard: "",
    evidenceMode: false,
  };
  mirrors.set(serial, m);
  attachControls(m);
  void win.loadFile(path.join(rendererDir, "mirror.html"), { query: { serial, kind: "android" } });
  win.on("focus", () => void syncClipboardToDevice(m));
  win.on("closed", () => {
    closeMirror(m);
    mirrors.delete(serial);
  });
  return m;
}

function closeMirror(m: Mirror) {
  if (m.controller && settings.turnScreenOff) m.controller.displayPower(true);
  m.session?.close();
  m.logcat?.stop();
  m.recording?.stream.end();
  for (const cb of m.captures.values()) cb(Buffer.alloc(0));
  m.captures.clear();
}

// ------------------------------------------------------------------ iOS (AirPlay)

/**
 * One AirPlay receiver advertises this PC to iPhones. Each iPhone that starts
 * mirroring gets a view-only window, fed the same H.264 StreamEvents as Android.
 */
let receiverRestart: Promise<void> = Promise.resolve();
function restartReceiver(): Promise<void> {
  receiverRestart = receiverRestart.then(restartReceiverNow, restartReceiverNow);
  return receiverRestart;
}

async function restartReceiverNow(): Promise<void> {
  const old = receiver;
  receiver = undefined;
  await old?.close();
  for (const m of [...mirrors.values()]) if (old && m.airplay === old) m.window.close();
  receiverError = undefined;
  if (!settings.iosEnabled) return;
  // The synthetic protocol engine is opt-in and restricted to automated tests.
  const synthetic = process.env.MIRRORLAB_TEST === "1" && process.env.MIRRORLAB_AIRPLAY_ENGINE === "synthetic";
  iosKeyProvider ??= new TestKeyProvider(Buffer.alloc(16, 0x11));
  const r = synthetic
    ? new AirplayReceiver({ name: settings.iosName, port: settings.iosPort, keyProvider: iosKeyProvider, advertise: false })
    : new NativeAirplayReceiver({ name: settings.iosName, port: settings.iosPort, resourcesDir, stateDir: path.join(app.getPath("userData"), "airplay"), audio: settings.audio, maxFps: settings.maxFps });
  r.on("device", (d: AirplayDevice) => onAirplayDevice(r, d));
  r.on("close", (err?: Error) => {
    if (receiver === r) {
      receiver = undefined;
      if (err) receiverError = err.message;
    }
  });
  try {
    receiver = r;
    await r.start();
  } catch (e) {
    r.close();
    if (receiver === r) receiver = undefined;
    receiverError = (e as Error).message;
  }
}

function onAirplayDevice(r: AirplayReceiver | NativeAirplayReceiver | UsbIphoneSession, device: AirplayDevice): void {
  const serial = `airplay:${device.address || device.name}`;
  let m = mirrors.get(serial);
  if (m && !m.window.isDestroyed()) {
    if (device.width) {
      m.videoSize = { width: device.width, height: device.height! };
      send(m.window.webContents, "mirror:video", { kind: "session", width: device.width, height: device.height });
    }
    return;
  }
  // New iPhone session → open a view-only window bound to this receiver.
  const area = screen.getPrimaryDisplay().workAreaSize;
  const h = Math.round(area.height * 0.85);
  const win = new BrowserWindow({
    width: Math.round(h * 0.5) + 56,
    height: h,
    frame: false,
    minWidth: 260,
    minHeight: 320,
    title: `${device.name} — Mirrorlab`,
    backgroundColor: "#0b0d10",
    alwaysOnTop: settings.alwaysOnTop,
    webPreferences: { preload, contextIsolation: true, sandbox: false, autoplayPolicy: "no-user-gesture-required", backgroundThrottling: false },
  });
  win.setMenuBarVisibility(false);
  m = {
    serial,
    kind: "ios",
    window: win,
    airplay: r,
    captures: new Map(),
    lastClipboard: "",
    evidenceMode: false,
    pendingVideo: [],
    pendingVideoBytes: 0,
  };
  mirrors.set(serial, m);
  attachControls(m);
  const mm = m;
  void win.loadFile(path.join(rendererDir, "mirror.html"), { query: { serial, kind: "ios", name: device.name } });
  win.on("closed", () => {
    closeMirror(mm);
    mirrors.delete(serial);
    if (mm.airplay === receiver && settings.iosEnabled && !appQuitting) void restartReceiver();
    else if (mm.airplay !== receiver) void mm.airplay?.close();
  });

  const wc = win.webContents;
  const onVideo = (ev: StreamEvent) => {
    if (ev.kind === "session") mm.videoSize = { width: ev.width, height: ev.height };
    const wire = toWire(ev);
    if (mm.rendererReady) send(wc, "mirror:video", wire);
    else {
      mm.pendingVideoBytes = (mm.pendingVideoBytes ?? 0) + (ev.kind === "packet" ? ev.data.length : 0);
      if (mm.pendingVideoBytes > 16 * 1024 * 1024) { mm.pendingVideo = []; mm.pendingVideoBytes = 0; }
      else mm.pendingVideo?.push(wire);
    }
  };
  r.on("video", onVideo);
  const onAudio = (ev: WireStreamEvent) => { if (mm.rendererReady) send(wc, "mirror:audio", ev); };
  const onName = (name: string) => { if (!win.isDestroyed()) win.setTitle(`${name} — Mirrorlab`); };
  const onDisconnect = (msg: string) => send(wc, "mirror:closed", msg);
  const onClose = (err?: Error) => onDisconnect(err?.message ?? "iPhone stopped mirroring");
  r.on("audio", onAudio);
  r.on("name", onName);
  r.on("disconnect", onDisconnect);
  r.on("close", onClose);
  win.once("closed", () => {
    r.off("video", onVideo); r.off("audio", onAudio); r.off("name", onName);
    r.off("disconnect", onDisconnect); r.off("close", onClose);
  });

  mm.timeline = new Timeline(timelineRoot(), serial, device.name);
  mm.timeline.add("system", "connect", `${device.name} via ${r instanceof UsbIphoneSession ? "USB" : "AirPlay"}`);
  mm.timeline.onEntry((e) => send(wc, "mirror:timeline", e));
}

function iosInfo() {
  return {
    enabled: settings.iosEnabled,
    running: !!receiver,
    error: receiverError,
    name: settings.iosName,
    port: receiver?.port ?? settings.iosPort,
  };
}

async function startSession(m: Mirror): Promise<void> {
  m.session?.close();
  const wc = m.window.webContents;
  const session = new MirrorSession(adb, m.serial, {
    serverJar,
    maxSize: settings.maxSize || undefined,
    videoBitRate: settings.videoBitRate,
    maxFps: settings.maxFps || undefined,
    audio: settings.audio,
    stayAwake: settings.stayAwake,
    showTouches: settings.showTouches,
    clipboardAutosync: settings.clipboardSync,
  });
  m.session = session;
  m.controller = new DeviceController(session);
  session.on("video", (ev: StreamEvent) => {
    if (ev.kind === "codec" && ev.codecId !== CodecId.H264) {
      send(wc, "mirror:error", `Unsupported video codec ${codecName(ev.codecId)}`);
    }
    send(wc, "mirror:video", toWire(ev));
  });
  session.on("audio", (ev: StreamEvent) => {
    if (ev.kind === "codec" && ev.codecId === CodecId.DISABLED) send(wc, "mirror:notice", "Audio is not available on this device (needs Android 11+).");
    send(wc, "mirror:audio", toWire(ev));
  });
  session.on("device", (msg) => {
    if (msg.type === "clipboard" && settings.clipboardSync) {
      m.lastClipboard = msg.text;
      void clipboard.writeText(msg.text);
      send(wc, "mirror:notice", "Copied from phone");
    }
  });
  session.on("close", (err?: Error) => {
    if (m.session !== session) return;
    m.logcat?.stop();
    send(wc, "mirror:closed", err ? err.message : "Disconnected");
    m.timeline?.add("system", "disconnect", err?.message ?? "session closed");
  });

  const info = await session.start();
  m.window.setTitle(`${info.deviceName} — Mirrorlab`);
  if (!m.timeline) {
    m.timeline = new Timeline(timelineRoot(), m.serial, info.deviceName);
    m.timeline.onEntry((e) => send(wc, "mirror:timeline", e));
  }
  m.timeline.add("system", "connect", `${info.deviceName} (${m.serial})`);
  if (settings.turnScreenOff) setTimeout(() => m.controller?.displayPower(false), 800);
  void syncClipboardToDevice(m);
  send(wc, "mirror:info", { ...info, timelineDir: m.timeline.dir });
}

async function syncClipboardToDevice(m: Mirror) {
  if (!settings.clipboardSync || !m.controller || m.session?.isClosed) return;
  const text = await clipboard.readText().catch(() => "");
  if (text && text !== m.lastClipboard) {
    m.lastClipboard = text;
    try {
      m.controller.setClipboard(text, false);
    } catch {
      /* not ready */
    }
  }
}

function captureFrame(m: Mirror, maxDim: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const id = ++captureSeq;
    const t = setTimeout(() => {
      m.captures.delete(id);
      reject(new Error("The mirror window did not return a frame (is it showing video?)"));
    }, 5000);
    m.captures.set(id, (png) => {
      clearTimeout(t);
      m.captures.delete(id);
      if (!png.length) reject(new Error("No frame available yet"));
      else resolve(png);
    });
    send(m.window.webContents, "mirror:capture", { id, maxDim });
  });
}

const mirrorFor = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => {
  for (const m of mirrors.values()) if (m.window.webContents === e.sender) return m;
  throw new Error("Not a mirror window");
};

// ------------------------------------------------------------------ doctor

function findProcess(name: RegExp): Promise<boolean> {
  if (process.platform !== "win32") return Promise.resolve(false);
  return new Promise((resolve) =>
    execFile("tasklist", ["/FO", "CSV", "/NH"], { windowsHide: true }, (err, out) => resolve(!err && name.test(String(out)))),
  );
}

async function doctor(): Promise<DoctorReport> {
  const r: DoctorReport = {
    adbPath: adbInfo.file,
    adbSource: adbInfo.source,
    serverJar,
    serverJarOk: fs.existsSync(serverJar),
    notes: [],
  };
  try {
    r.adbVersion = await adb.version();
  } catch (e) {
    r.adbError = (e as Error).message;
    r.notes.push(
      adbInfo.source === "path"
        ? "adb was not found. Install Android platform-tools, or set MIRRORLAB_ADB to an adb executable."
        : "The adb binary failed to run.",
    );
  }
  if (await findProcess(/ApowerMirror/i)) {
    r.notes.push(
      "ApowerMirror is running. It ships its own adb; two different adb versions keep restarting each other's server (\"adb server version doesn't match\"). Quit ApowerMirror while using Mirrorlab.",
    );
  }
  if (await findProcess(/dnplayer|LdVBoxHeadless|ldplayer/i)) {
    r.notes.push("LDPlayer is running. Enable ADB debugging in its settings, then use Connect with 127.0.0.1:5555 (each extra instance adds 2 to the port).");
  }
  return r;
}

// ------------------------------------------------------------------ agent hub

const hub: AgentHub = {
  adb,
  async listDevices() {
    const list = await adb.devices();
    return list.map((d) => ({ serial: d.serial, model: d.model, state: d.state, mirroring: !!mirrors.get(d.serial)?.session?.videoSize }));
  },
  mirror(serial) {
    const live = [...mirrors.values()].filter((m) => m.session && !m.session.isClosed);
    let m: Mirror | undefined;
    if (serial) m = live.find((x) => x.serial === serial);
    else if (live.length === 1) m = live[0];
    else if (live.length > 1) throw new Error(`Several mirrors are open (${live.map((x) => x.serial).join(", ")}) — pass serial`);
    if (!m) throw new Error(`No open mirror${serial ? ` for ${serial}` : ""}. Open the device in Mirrorlab first — the agent only acts on screens you can watch.`);
    const mm = m;
    return {
      serial: mm.serial,
      deviceName: mm.session!.info?.deviceName ?? mm.serial,
      controller: mm.controller!,
      videoSize: () => mm.session?.videoSize,
      screenshot: (maxDim) => captureFrame(mm, maxDim),
      ui: () => dumpUi(adb, mm.serial, mm.session!.videoSize ?? { width: 1, height: 1 }),
      logcat: mm.logcat!,
      timeline: mm.timeline!,
      indicate: (kind, x, y, x2, y2) => send(mm.window.webContents, "mirror:indicate", { kind, x, y, x2, y2 }),
    } satisfies MirrorHandle;
  },
};

async function restartAgent() {
  await agent?.close();
  agent = undefined;
  agentError = undefined;
  if (!settings.agentEnabled) return;
  try {
    agent = await startAgentEndpoint(hub, settings.agentPort, settings.agentToken);
  } catch (e) {
    agentError = `Could not listen on port ${settings.agentPort}: ${(e as Error).message}`;
  }
}

function agentInfo() {
  const url = agent?.url ?? `http://127.0.0.1:${settings.agentPort}/mcp`;
  return {
    enabled: settings.agentEnabled,
    running: !!agent,
    error: agentError,
    url,
    token: settings.agentToken,
    claudeCode: `claude mcp add --transport http mirrorlab ${url} --header "Authorization: Bearer ${settings.agentToken}"`,
    json: JSON.stringify({ mcpServers: { mirrorlab: { type: "http", url, headers: { Authorization: `Bearer ${settings.agentToken}` } } } }, null, 2),
  };
}

// ------------------------------------------------------------------ IPC

function registerIpc() {
  ipcMain.handle("devices", () => adb.devices());
  ipcMain.handle("doctor", () => doctor());
  ipcMain.handle("settings:get", () => settings);
  ipcMain.handle("settings:set", async (_e, patch: Partial<Settings>) => {
    const agentChanged = ("agentEnabled" in patch && patch.agentEnabled !== settings.agentEnabled) || ("agentPort" in patch && patch.agentPort !== settings.agentPort);
    const iosChanged =
      ("audio" in patch && patch.audio !== settings.audio) ||
      ("iosEnabled" in patch && patch.iosEnabled !== settings.iosEnabled) ||
      ("iosName" in patch && patch.iosName !== settings.iosName) ||
      ("iosPort" in patch && patch.iosPort !== settings.iosPort);
    settings = { ...settings, ...patch };
    saveSettings(settings);
    for (const m of mirrors.values()) m.window.setAlwaysOnTop(settings.alwaysOnTop);
    if (agentChanged) await restartAgent();
    if (iosChanged) await restartReceiver();
    return settings;
  });
  ipcMain.handle("agent:info", () => agentInfo());
  ipcMain.handle("agent:regenerate", async () => {
    settings.agentToken = randomBytes(24).toString("base64url");
    saveSettings(settings);
    await restartAgent();
    return agentInfo();
  });
  ipcMain.handle("adb:connect", (_e, host: string) => adb.connect(host));
  ipcMain.handle("adb:disconnect", (_e, host: string) => adb.disconnect(host));
  ipcMain.handle("adb:pair", (_e, host: string, code: string) => adb.pair(host, code));
  ipcMain.handle("adb:wifi", (_e, serial: string) => adb.switchToWifi(serial));
  ipcMain.handle("mirror:open", (_e, serial: string) => {
    openMirror(serial);
  });
  ipcMain.handle("clipboard:write", (_e, text: string) => clipboard.writeText(text));

  ipcMain.handle("ios:info", () => iosInfo());
  ipcMain.handle("ios:usbDevices", () => scanUsbIphones());
  ipcMain.handle("ios:usbSupport", () => usbSupport(resourcesDir));
  ipcMain.handle("ios:usbInstall", async (_e, serial: string, remove?: boolean) => {
    if (typeof serial !== "string") throw new Error("Select a connected iPhone.");
    if (usbSessions.has(serial)) throw new Error("Stop USB mirroring on this iPhone first.");
    const result = await installUsbDriver(resourcesDir, serial, remove === true);
    if (result.ok) usbErrors.delete(serial);
    return result;
  });
  ipcMain.handle("ios:usbOpen", async (_e, serial: string) => {
    if (typeof serial !== "string") throw new Error("Select a connected iPhone.");
    const existing = usbSessions.get(serial);
    if (existing) {
      const m = mirrors.get(`airplay:usb:${serial}`);
      m?.window.show(); m?.window.focus(); return;
    }
    const device = (await scanUsbIphones()).find((d) => d.serial === serial);
    if (!device) throw new Error("iPhone is no longer connected. Reconnect the cable.");
    usbErrors.delete(serial);
    const session = new UsbIphoneSession(resourcesDir, device, settings.audio);
    usbSessions.set(serial, session);
    session.on("log", (message: string) => console.info("[iPhone USB]", message.trim()));
    session.on("device", (d: AirplayDevice) => onAirplayDevice(session, d));
    session.once("close", (err?: Error) => {
      usbSessions.delete(serial);
      if (err) usbErrors.set(serial, err.message);
      if (err && !appQuitting && launcher) send(launcher.webContents, "ios:usbError", err.message);
    });
    try { await session.start(); } catch (e) { usbErrors.set(serial, (e as Error).message); await session.close(); throw e; }
  });

  // --- from mirror windows
  ipcMain.handle("mirror:ready", async (e) => {
    const m = mirrorFor(e);
    if (m.kind === "ios") {
      m.rendererReady = true;
      // View-only: no adb session. Tell the renderer who it is; video is already flowing.
      send(m.window.webContents, "mirror:info", { deviceName: m.window.getTitle().replace(/ — Mirrorlab$/, ""), timelineDir: m.timeline?.dir, readOnly: true });
      if (m.videoSize) send(m.window.webContents, "mirror:video", { kind: "session", ...m.videoSize });
      for (const ev of m.pendingVideo ?? []) send(m.window.webContents, "mirror:video", ev);
      m.pendingVideo = undefined;
      m.pendingVideoBytes = 0;
      return;
    }
    try {
      await startSession(m);
    } catch (err) {
      send(m.window.webContents, "mirror:closed", (err as Error).message);
    }
  });
  ipcMain.on("mirror:control", (e, bytes: Uint8Array) => {
    try {
      mirrorFor(e).session?.send(bytes);
    } catch {
      /* window gone */
    }
  });
  ipcMain.on("mirror:captured", (e, id: number, png: Uint8Array) => {
    mirrorFor(e).captures.get(id)?.(Buffer.from(png));
  });
  ipcMain.on("mirror:userEvent", async (e, kind: string, detail: string) => {
    const m = mirrorFor(e);
    if (!m.timeline) return;
    if (m.evidenceMode && (kind === "tap" || kind === "swipe" || kind === "key")) {
      await new Promise((r) => setTimeout(r, 600));
      const png = await captureFrame(m, 720).catch(() => undefined);
      m.timeline.add("user", kind, detail, png);
    } else m.timeline.add("user", kind, detail);
  });
  ipcMain.handle("mirror:action", async (e, action: string, arg?: unknown) => {
    const m = mirrorFor(e);
    const c = m.controller;
    switch (action) {
      case "windowClose":
        return m.window.close();
      case "windowMinimize":
        return m.window.minimize();
      case "reconnect":
        if (m.kind === "ios") return restartReceiver();
        return startSession(m);
      case "rotate":
        return m.session?.send(encodeSimple(ControlType.ROTATE_DEVICE));
      case "notifications":
        return m.session?.send(encodeSimple(ControlType.EXPAND_NOTIFICATION_PANEL));
      case "quickSettings":
        return m.session?.send(encodeSimple(ControlType.EXPAND_SETTINGS_PANEL));
      case "resetVideo":
        return m.session?.send(encodeSimple(ControlType.RESET_VIDEO));
      case "screenPower":
        return c?.displayPower(Boolean(arg));
      case "paste": {
        const text = await clipboard.readText().catch(() => "");
        if (text && c) {
          m.lastClipboard = text;
          c.setClipboard(text, true);
        }
        return;
      }
      case "saveScreenshot": {
        const png = Buffer.from(arg as Uint8Array);
        fs.mkdirSync(shotsDir(), { recursive: true });
        const file = path.join(shotsDir(), `${safeName(m)}_${stamp()}.png`);
        fs.writeFileSync(file, png);
        await clipboard.write([new ClipboardItem({ "image/png": new Blob([png], { type: "image/png" }) })]).catch(() => undefined);
        m.timeline?.add("user", "screenshot", path.basename(file), png);
        return file;
      }
      case "recordStart": {
        fs.mkdirSync(videosDir(), { recursive: true });
        const ext = String(arg ?? "webm");
        const file = path.join(videosDir(), `${safeName(m)}_${stamp()}.${ext}`);
        m.recording = { stream: fs.createWriteStream(file), file };
        m.timeline?.add("user", "record", `started ${path.basename(file)}`);
        return file;
      }
      case "recordChunk":
        m.recording?.stream.write(Buffer.from(arg as Uint8Array));
        return;
      case "recordStop": {
        const rec = m.recording;
        m.recording = undefined;
        if (!rec) return null;
        await new Promise<void>((r) => rec.stream.end(r));
        m.timeline?.add("user", "record", `saved ${path.basename(rec.file)}`);
        return rec.file;
      }
      case "showFile":
        return shell.showItemInFolder(String(arg));
      case "dropFiles":
        return dropFiles(m, arg as string[]);
      case "inspect": {
        const size = m.session?.videoSize;
        if (!size) throw new Error("No video yet");
        return dumpUi(adb, m.serial, size);
      }
      case "logcat":
        if (!m.logcat) return [];
        if (arg) m.logcat.start();
        else m.logcat.stop();
        return m.logcat.buffer.slice(-500);
      case "timelineNote":
        return m.timeline?.add("user", "note", String(arg));
      case "timelineEvidence":
        m.evidenceMode = Boolean(arg);
        return m.evidenceMode;
      case "timelineGet":
        return m.timeline?.entries ?? [];
      case "timelineExport": {
        if (!m.timeline) return null;
        const file = m.timeline.exportHtml();
        void shell.openPath(file);
        return file;
      }
      case "timelineFolder":
        return m.timeline && shell.openPath(m.timeline.dir);
      case "agentInfo":
        return agentInfo();
      case "fitWindow": {
        // Keep the capture window at phone aspect; size its attached controls separately.
        const { videoW, videoH, extra } = arg as { videoW: number; videoH: number; extra: number };
        const win = m.window;
        m.controlsWidth = extra;
        m.placeControls?.();
        if (win.isFullScreen() || win.isMaximized()) return;
        const [, h] = win.getContentSize();
        const area = screen.getDisplayMatching(win.getBounds()).workArea;
        let height = Math.min(h!, area.height);
        let width = Math.round((height * videoW) / videoH);
        if (width > area.width) {
          width = area.width;
          height = Math.round((width * videoH) / videoW);
        }
        win.setContentSize(width, height);
        // Also repositions controls after a panel opens without a phone resize.
        m.placeControls?.();
        const b = win.getBounds();
        if (b.x + b.width > area.x + area.width) win.setPosition(Math.max(area.x, area.x + area.width - b.width), b.y);
        return;
      }
      default:
        throw new Error(`Unknown action ${action}`);
    }
  });
}

async function dropFiles(m: Mirror, files: string[]): Promise<string[]> {
  const results: string[] = [];
  for (const f of files) {
    const name = path.basename(f);
    try {
      if (/\.apks?$/i.test(f)) {
        send(m.window.webContents, "mirror:notice", `Installing ${name}…`);
        const out = await adb.install(m.serial, f);
        results.push(/Success/.test(out) ? `Installed ${name}` : `Install failed: ${out.trim().slice(-200)}`);
        m.timeline?.add("user", "install", name);
      } else {
        const remote = `/sdcard/Download/${name}`;
        send(m.window.webContents, "mirror:notice", `Sending ${name}…`);
        await adb.push(m.serial, f, remote);
        m.session?.send(encodeScanFile(remote));
        results.push(`Sent ${name} to Download/`);
        m.timeline?.add("user", "push", remote);
      }
    } catch (e) {
      results.push(`${name}: ${(e as Error).message}`);
    }
  }
  return results;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const safeName = (m: Mirror) => (m.session?.info?.deviceName ?? m.serial).replace(/[^\w.-]+/g, "_");

// ------------------------------------------------------------------ app

function createLauncher() {
  launcher = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 420,
    minHeight: 480,
    title: "Mirrorlab",
    backgroundColor: "#0b0d10",
    webPreferences: { preload, contextIsolation: true, sandbox: false },
  });
  launcher.setMenuBarVisibility(false);
  void launcher.loadFile(path.join(rendererDir, "index.html"));
  launcher.on("closed", () => (launcher = undefined));
}

app.whenReady().then(async () => {
  settings = loadSettings();
  registerIpc();
  await restartAgent();
  await restartReceiver();
  createLauncher();
  // Optional: open a device straight away (used by tests and shortcuts).
  const auto = process.env.MIRRORLAB_OPEN ?? process.argv.find((a) => a.startsWith("--open="))?.slice(7);
  if (auto) openMirror(auto);
  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().length) createLauncher();
  });
});

let appQuitting = false;
let usbShutdownComplete = false;
app.on("before-quit", (e) => {
  appQuitting = true; void receiver?.close();
  if (usbSessions.size && !usbShutdownComplete) {
    e.preventDefault();
    void Promise.all([...usbSessions.values()].map((s) => s.close())).finally(() => { usbShutdownComplete = true; app.quit(); });
  }
});
app.on("window-all-closed", () => {
  void agent?.close();
  receiver?.close();
  if (process.platform !== "darwin") app.quit();
});

// Surface unexpected errors instead of dying silently.
process.on("uncaughtException", (e) => {
  console.error(e);
  if (app.isReady() && !process.env.MIRRORLAB_TEST) dialog.showErrorBox("Mirrorlab error", String(e?.stack ?? e));
});

export { shellQuote };
