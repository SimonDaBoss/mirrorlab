import type { MirrorlabApi } from "../preload/preload";
import {
  ControlType,
  KeyAction,
  MotionAction,
  MotionButton,
  POINTER_ID_MOUSE,
  encodeBackOrScreenOn,
  encodeKeycode,
  encodeScroll,
  encodeSimple,
  encodeText,
  encodeTouch,
} from "../shared/protocol";
import { Keycode, keycodeForCode, metaState } from "../shared/keys";
import type { TimelineEntry, UiNode, WireStreamEvent } from "../shared/types";
import { AudioPipeline } from "./audio";
import { icons } from "./icons";
import { VideoPipeline } from "./video";

declare global {
  interface Window {
    mirrorlab: MirrorlabApi;
  }
}
const api = window.mirrorlab;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// iOS mirrors are view-only (AirPlay is one-way): no control, no adb-backed panels.
const params = new URLSearchParams(location.search);
const readOnly = params.get("kind") === "ios";

const stage = $("stage");
const screenEl = $("screen");
const canvas = $<HTMLCanvasElement>("canvas");
const overlay = $("overlay");
const statusEl = $("status");
const statusText = $("statusText");
const statsEl = $("stats");
const ime = $<HTMLTextAreaElement>("ime");
const toolbar = $("toolbar");
const panel = $("panel");
const toastEl = $("toast");
const agentChip = $("agentChip");

const video = new VideoPipeline(canvas, () => api.control(encodeSimple(ControlType.RESET_VIDEO)), readOnly);
let audio: AudioPipeline | undefined;
let deviceName = "";
let connected = false;

// ------------------------------------------------------------------ layout

function layout() {
  const s = video.size;
  if (!s) return;
  const k = Math.min(stage.clientWidth / s.width, stage.clientHeight / s.height);
  screenEl.style.width = `${Math.floor(s.width * k)}px`;
  screenEl.style.height = `${Math.floor(s.height * k)}px`;
}
new ResizeObserver(layout).observe(stage);
const TOOLBAR_W = 52;
const PANEL_W = 380;
function fitWindow() {
  const s = video.size;
  if (!s || document.fullscreenElement) return;
  void api.invoke("mirror:action", "fitWindow", { videoW: s.width, videoH: s.height, extra: TOOLBAR_W + (openPanel ? PANEL_W : 0) });
}
video.onResize = () => {
  fitWindow();
  layout();
  if (inspectDump) clearInspector(); // rotation invalidates bounds
};
video.onFirstFrame = () => {
  statusEl.hidden = true;
  connected = true;
};

let toastTimer: number | undefined;
function toast(msg: string, ms = 2200) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), ms);
}

// ------------------------------------------------------------------ streams from main

api.on("mirror:video", (ev) => video.handle(ev as WireStreamEvent));
api.on("mirror:audio", (ev) => {
  audio ??= new AudioPipeline();
  audio.handle(ev as WireStreamEvent);
});
api.on("mirror:info", (info) => {
  const i = info as { deviceName: string; timelineDir: string };
  deviceName = i.deviceName || deviceName;
  document.title = `${deviceName} — Mirrorlab`;
  statusText.textContent = readOnly ? "Waiting for your iPhone…" : "Waiting for the first frame…";
});

// iOS: the device name comes in the query; fix the tab title before the first frame.
if (readOnly) {
  deviceName = params.get("name") || "iPhone";
  document.title = `${deviceName} — Mirrorlab`;
}
api.on("mirror:closed", (msg) => {
  connected = false;
  if (readOnly) {
    video.reset();
    audio?.close();
    audio = undefined;
    if (recorder?.state === "recording") recorder.stop();
  }
  statusEl.hidden = false;
  statusEl.innerHTML = `<div style="max-width:420px"><b>Disconnected</b><p class="muted" style="white-space:pre-wrap;word-break:break-word">${esc(String(msg)).slice(0, 900)}</p>${readOnly ? '<p class="muted">Select Mirrorlab in Screen Mirroring on your iPhone to connect again.</p>' : ""}</div><button class="btn primary" id="reconnect">${readOnly ? "Restart AirPlay" : "Reconnect"}</button>`;
  $("reconnect").onclick = () => {
    statusEl.innerHTML = `<div class="spinner"></div><div>Reconnecting…</div>`;
    void api.invoke("mirror:action", "reconnect").catch((e: Error) => toast(e.message, 5000));
  };
});
api.on("mirror:error", (msg) => toast(String(msg), 5000));
api.on("mirror:notice", (msg) => toast(String(msg)));
api.on("mirror:capture", async (req) => {
  const { id, maxDim } = req as { id: number; maxDim: number };
  api.captured(id, await video.snapshot(maxDim));
});

setInterval(() => {
  if (!statsEl.hidden) {
    const s = video.stats;
    statsEl.textContent = `${s.width}×${s.height} · ${s.fps} fps · ${s.codec} · dropped ${s.dropped}`;
  }
}, 500);

// ------------------------------------------------------------------ input: pointer

function devicePos(e: { clientX: number; clientY: number }) {
  const s = video.size!;
  const r = canvas.getBoundingClientRect();
  const x = Math.min(s.width - 1, Math.max(0, ((e.clientX - r.left) / r.width) * s.width));
  const y = Math.min(s.height - 1, Math.max(0, ((e.clientY - r.top) / r.height) * s.height));
  return { x, y, width: s.width, height: s.height };
}

let downAt: { x: number; y: number; t: number } | undefined;
const activePointers = new Set<number>();

canvas.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("pointerdown", (e) => {
  if (!video.size || readOnly) return;
  ime.focus({ preventScroll: true });
  if (audio?.ctx.state === "suspended") void audio.ctx.resume();
  const pos = devicePos(e);
  if (inspecting) {
    selectNodeAt(pos.x, pos.y);
    return;
  }
  canvas.setPointerCapture(e.pointerId);
  if (e.pointerType === "mouse") {
    if (e.button === 2) return api.control(encodeBackOrScreenOn(KeyAction.DOWN));
    if (e.button === 1) return key(Keycode.HOME, KeyAction.DOWN);
    if (e.button === 3) return key(Keycode.BACK, KeyAction.DOWN);
    if (e.button === 4) return key(Keycode.APP_SWITCH, KeyAction.DOWN);
    if (e.button !== 0) return;
  }
  activePointers.add(e.pointerId);
  downAt = { x: pos.x, y: pos.y, t: performance.now() };
  sendTouch(e, MotionAction.DOWN, pos);
});
canvas.addEventListener("pointermove", (e) => {
  if (!video.size) return;
  if (inspecting) return hoverNodeAt(devicePos(e));
  if (!activePointers.has(e.pointerId)) return;
  for (const ce of e.getCoalescedEvents?.() ?? [e]) sendTouch(e, MotionAction.MOVE, devicePos(ce));
});
const up = (e: PointerEvent) => {
  if (!video.size || inspecting) return;
  if (e.pointerType === "mouse") {
    if (e.button === 2) return api.control(encodeBackOrScreenOn(KeyAction.UP));
    if (e.button === 1) return key(Keycode.HOME, KeyAction.UP);
    if (e.button === 3) return key(Keycode.BACK, KeyAction.UP);
    if (e.button === 4) return key(Keycode.APP_SWITCH, KeyAction.UP);
  }
  if (!activePointers.delete(e.pointerId)) return;
  const pos = devicePos(e);
  sendTouch(e, e.type === "pointercancel" ? MotionAction.CANCEL : MotionAction.UP, pos);
  if (downAt) {
    const dist = Math.hypot(pos.x - downAt.x, pos.y - downAt.y);
    const ms = Math.round(performance.now() - downAt.t);
    const p = (v: number) => Math.round(v);
    if (dist < 12) api.userEvent("tap", `(${p(pos.x)}, ${p(pos.y)})${ms > 500 ? ` held ${ms} ms` : ""}`);
    else api.userEvent("swipe", `(${p(downAt.x)}, ${p(downAt.y)}) → (${p(pos.x)}, ${p(pos.y)}) in ${ms} ms`);
    downAt = undefined;
  }
};
canvas.addEventListener("pointerup", up);
canvas.addEventListener("pointercancel", up);

function sendTouch(e: PointerEvent, action: number, pos: ReturnType<typeof devicePos>) {
  const mouse = e.pointerType === "mouse";
  const pressed = action === MotionAction.DOWN || action === MotionAction.MOVE;
  api.control(
    encodeTouch({
      action,
      // Real touchscreens/pens get their own ids so multi-touch (pinch) works.
      pointerId: mouse ? POINTER_ID_MOUSE : BigInt(e.pointerId),
      position: pos,
      pressure: pressed ? (mouse ? 1 : e.pressure || 1) : 0,
      actionButton: mouse && action !== MotionAction.MOVE ? MotionButton.PRIMARY : 0,
      buttons: mouse && pressed ? MotionButton.PRIMARY : 0,
    }),
  );
}

canvas.addEventListener(
  "wheel",
  (e) => {
    if (!video.size || readOnly) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 1 : e.deltaMode === 2 ? 10 : 1 / 100;
    const h = Math.max(-16, Math.min(16, e.deltaX * unit));
    const v = Math.max(-16, Math.min(16, -e.deltaY * unit));
    api.control(encodeScroll(devicePos(e), h, v));
  },
  { passive: false },
);

// ------------------------------------------------------------------ input: keyboard

function key(code: number, action: number, meta = 0, repeat = 0) {
  api.control(encodeKeycode(action, code, repeat, meta));
}
function press(code: number, meta = 0) {
  key(code, KeyAction.DOWN, meta);
  key(code, KeyAction.UP, meta);
}

/** Alt+key shortcuts, like scrcpy's MOD key (Alt here, so Ctrl stays free for apps). */
const shortcuts: Record<string, () => void> = {
  KeyH: () => press(Keycode.HOME),
  KeyB: () => (api.control(encodeBackOrScreenOn(0)), api.control(encodeBackOrScreenOn(1))),
  KeyS: () => press(Keycode.APP_SWITCH),
  KeyP: () => press(Keycode.POWER),
  ArrowUp: () => press(Keycode.VOLUME_UP),
  ArrowDown: () => press(Keycode.VOLUME_DOWN),
  KeyR: () => api.control(encodeSimple(ControlType.ROTATE_DEVICE)),
  KeyN: () => api.control(encodeSimple(ControlType.EXPAND_NOTIFICATION_PANEL)),
  KeyO: () => toggleScreenPower(),
  KeyF: () => toggleFullscreen(),
  KeyI: () => togglePanel("inspector"),
  KeyL: () => togglePanel("logcat"),
  KeyT: () => togglePanel("timeline"),
  KeyK: () => void screenshot(),
};

const held = new Set<string>();
let typedBuffer = "";
let typedTimer: number | undefined;
function logTyped(s: string) {
  typedBuffer += s;
  clearTimeout(typedTimer);
  typedTimer = window.setTimeout(() => {
    if (typedBuffer) api.userEvent("text", typedBuffer);
    typedBuffer = "";
  }, 1200);
}

ime.addEventListener("keydown", (e) => {
  if (e.isComposing || e.key === "Process") return; // IME is composing
  if (e.altKey && !e.ctrlKey && !e.getModifierState("AltGraph") && shortcuts[e.code]) {
    e.preventDefault();
    if (!e.repeat) shortcuts[e.code]!();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.code === "KeyV" && !e.altKey) {
    e.preventDefault();
    void api.invoke("mirror:action", "paste");
    return;
  }
  const code = keycodeForCode(e.code);
  if (code === undefined) return;
  // AltGr (Ctrl+Alt on Windows) produces characters on many layouts — treat it as text.
  const altGr = e.getModifierState("AltGraph");
  const modified = !altGr && (e.ctrlKey || e.altKey || e.metaKey);
  const printable = e.key.length === 1;
  if (printable && !modified) return; // goes through the input event as text
  e.preventDefault();
  held.add(e.code);
  key(code, KeyAction.DOWN, metaState(e), e.repeat ? 1 : 0);
  if (!e.repeat && !printable) api.userEvent("key", e.key);
});
ime.addEventListener("keyup", (e) => {
  if (!held.delete(e.code)) return;
  const code = keycodeForCode(e.code);
  if (code !== undefined) key(code, KeyAction.UP, metaState(e));
});
ime.addEventListener("input", (e) => {
  const ie = e as InputEvent;
  if (ie.isComposing) return;
  const text = ie.data ?? ime.value;
  if (text) {
    api.control(encodeText(text));
    logTyped(text);
  }
  ime.value = "";
});
ime.addEventListener("compositionend", (e) => {
  if (e.data) {
    api.control(encodeText(e.data));
    logTyped(e.data);
  }
  ime.value = "";
});
const focusIme = () => {
  if (!readOnly) ime.focus({ preventScroll: true });
};
window.addEventListener("focus", focusIme);
stage.addEventListener("mousedown", () => setTimeout(focusIme));

// ------------------------------------------------------------------ drag & drop

const drop = $("drop");
let dragDepth = 0;
stage.addEventListener("dragenter", (e) => {
  if (readOnly) return;
  e.preventDefault();
  dragDepth++;
  drop.hidden = false;
});
stage.addEventListener("dragover", (e) => e.preventDefault());
stage.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) drop.hidden = true;
});
stage.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  drop.hidden = true;
  const files = [...(e.dataTransfer?.files ?? [])].map((f) => api.pathForFile(f)).filter(Boolean);
  if (!files.length) return;
  const results = (await api.invoke("mirror:action", "dropFiles", files)) as string[];
  toast(results.join(" · "), 4000);
});

// ------------------------------------------------------------------ toolbar

let screenOn = true;
let recorder: MediaRecorder | undefined;

function toggleScreenPower() {
  screenOn = !screenOn;
  void api.invoke("mirror:action", "screenPower", screenOn);
  toast(screenOn ? "Phone screen on" : "Phone screen off — mirroring continues");
  renderToolbar();
}

function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen().catch(() => undefined);
}

async function screenshot() {
  const png = await video.snapshot(0);
  if (!png.length) return toast("No frame yet");
  const file = (await api.invoke("mirror:action", "saveScreenshot", png)) as string;
  toast(`Saved and copied: ${file.split(/[\\/]/).pop()}`);
}

async function toggleRecord() {
  if (recorder) {
    recorder.stop();
    return;
  }
  const stream = canvas.captureStream(60);
  if (audio?.active) for (const t of audio.recordDest.stream.getAudioTracks()) stream.addTrack(t);
  const mime = ["video/mp4;codecs=avc1,opus", "video/mp4;codecs=avc1", "video/webm;codecs=vp9,opus", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m))!;
  const ext = mime.startsWith("video/mp4") ? "mp4" : "webm";
  await api.invoke("mirror:action", "recordStart", ext);
  recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
  recorder.ondataavailable = async (ev) => {
    if (ev.data.size) await api.invoke("mirror:action", "recordChunk", new Uint8Array(await ev.data.arrayBuffer()));
  };
  recorder.onstop = async () => {
    recorder = undefined;
    renderToolbar();
    // Let the final dataavailable land before closing the file.
    await new Promise((r) => setTimeout(r, 300));
    const file = (await api.invoke("mirror:action", "recordStop")) as string | null;
    if (file) {
      toast(`Recording saved: ${file.split(/[\\/]/).pop()}`, 4000);
      void api.invoke("mirror:action", "showFile", file);
    }
  };
  recorder.start(1000);
  renderToolbar();
}

type PanelName = "inspector" | "logcat" | "timeline" | "agent";
let openPanel: PanelName | undefined;
let pinned = false;

function renderToolbar() {
  const t = (id: string, icon: string, title: string, cls = "") => `<button class="tool ${cls}" data-t="${id}" title="${title}">${icon}</button>`;
  if (readOnly) {
    // iPhone over AirPlay is one-way: capture + window controls only, no device control.
    toolbar.innerHTML = [
      t("shot", icons.camera, "Screenshot — saved and copied (Alt+K)"),
      t("rec", icons.record, recorder ? "Stop recording" : "Record", recorder ? "rec" : ""),
      t("mute", audio?.muted ? icons.mute : icons.speaker, audio?.muted ? "Unmute" : "Mute", audio?.muted ? "on" : ""),
      '<div class="sep"></div>',
      t("timeline", icons.timeline, "Timeline (Alt+T)", openPanel === "timeline" ? "on" : ""),
      '<div class="sep"></div>',
      t("pin", icons.pin, "Keep on top", pinned ? "on" : ""),
      t("full", icons.fullscreen, "Fullscreen (Alt+F)"),
    ].join("");
    return;
  }
  toolbar.innerHTML = [
    t("back", icons.back, "Back (right-click, Alt+B)"),
    t("home", icons.home, "Home (middle-click, Alt+H)"),
    t("recents", icons.recents, "Recent apps (Alt+S)"),
    '<div class="sep"></div>',
    t("volUp", icons.volUp, "Volume up (Alt+↑)"),
    t("volDown", icons.volDown, "Volume down (Alt+↓)"),
    t("power", icons.power, "Power (Alt+P)"),
    t("rotate", icons.rotate, "Rotate (Alt+R)"),
    t("notif", icons.bell, "Notifications (Alt+N)"),
    '<div class="sep"></div>',
    t("shot", icons.camera, "Screenshot — saved and copied (Alt+K)"),
    t("rec", icons.record, recorder ? "Stop recording" : "Record", recorder ? "rec" : ""),
    t("screen", icons.screenOff, screenOn ? "Turn phone screen off, keep mirroring (Alt+O)" : "Turn phone screen on (Alt+O)", screenOn ? "" : "on"),
    t("mute", audio?.muted ? icons.mute : icons.speaker, audio?.muted ? "Unmute" : "Mute", audio?.muted ? "on" : ""),
    '<div class="sep"></div>',
    t("inspector", icons.inspect, "UI inspector (Alt+I)", openPanel === "inspector" ? "on" : ""),
    t("logcat", icons.logcat, "Logcat (Alt+L)", openPanel === "logcat" ? "on" : ""),
    t("timeline", icons.timeline, "Timeline (Alt+T)", openPanel === "timeline" ? "on" : ""),
    t("agent", icons.agent, "AI agent", openPanel === "agent" ? "on" : ""),
    '<div class="sep"></div>',
    t("pin", icons.pin, "Keep on top", pinned ? "on" : ""),
    t("full", icons.fullscreen, "Fullscreen (Alt+F)"),
  ].join("");
}

toolbar.addEventListener("click", (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>("[data-t]")?.dataset.t;
  if (!id) return;
  const actions: Record<string, () => void> = {
    back: shortcuts.KeyB!,
    home: shortcuts.KeyH!,
    recents: shortcuts.KeyS!,
    volUp: shortcuts.ArrowUp!,
    volDown: shortcuts.ArrowDown!,
    power: shortcuts.KeyP!,
    rotate: shortcuts.KeyR!,
    notif: shortcuts.KeyN!,
    shot: () => void screenshot(),
    rec: () => void toggleRecord(),
    screen: toggleScreenPower,
    mute: () => {
      if (!audio) return toast("No audio stream");
      audio.muted = !audio.muted;
      renderToolbar();
    },
    inspector: () => togglePanel("inspector"),
    logcat: () => togglePanel("logcat"),
    timeline: () => togglePanel("timeline"),
    agent: () => togglePanel("agent"),
    pin: () => {
      pinned = !pinned;
      void api.invoke("settings:set", { alwaysOnTop: pinned });
      renderToolbar();
    },
    full: toggleFullscreen,
  };
  actions[id]?.();
  ime.focus({ preventScroll: true });
});

window.addEventListener("keydown", (e) => {
  if (e.key === "F12") statsEl.hidden = !statsEl.hidden;
});

// ------------------------------------------------------------------ panels

function togglePanel(name: PanelName) {
  const closing = openPanel === name;
  const wasOpen = openPanel !== undefined;
  if (openPanel === "logcat") void api.invoke("mirror:action", "logcat", false);
  if (openPanel === "inspector") setInspecting(false);
  openPanel = closing ? undefined : name;
  panel.hidden = !openPanel;
  panel.className = `panel ${openPanel ?? ""}`;
  if (openPanel === "inspector") renderInspector();
  if (openPanel === "logcat") renderLogcat();
  if (openPanel === "timeline") void renderTimeline();
  if (openPanel === "agent") void renderAgent();
  renderToolbar();
  if (closing || !wasOpen) fitWindow(); // grow/shrink only when the panel appears or disappears
  requestAnimationFrame(layout);
}

// --- inspector

let inspectDump: { nodes: UiNode[]; foreground?: string } | undefined;
let inspecting = false;
let selected: UiNode | undefined;

function setInspecting(on: boolean) {
  inspecting = on;
  screenEl.classList.toggle("inspecting", on);
  if (!on) overlay.querySelectorAll(".hl").forEach((n) => n.remove());
}

function clearInspector() {
  inspectDump = undefined;
  selected = undefined;
  overlay.querySelectorAll(".hl").forEach((n) => n.remove());
  if (openPanel === "inspector") renderInspector();
}

function box(n: UiNode, cls: string) {
  const s = video.size!;
  const el = document.createElement("div");
  el.className = `hl ${cls}`;
  const [x1, y1, x2, y2] = n.bounds;
  Object.assign(el.style, {
    left: `${(x1 / s.width) * 100}%`,
    top: `${(y1 / s.height) * 100}%`,
    width: `${((x2 - x1) / s.width) * 100}%`,
    height: `${((y2 - y1) / s.height) * 100}%`,
  });
  overlay.appendChild(el);
}

function drawHighlights(hover?: UiNode) {
  overlay.querySelectorAll(".hl").forEach((n) => n.remove());
  if (hover && hover !== selected) box(hover, "");
  if (selected) box(selected, "sel");
}

function nodeAt(x: number, y: number): UiNode | undefined {
  if (!inspectDump) return;
  let best: UiNode | undefined;
  let bestArea = Infinity;
  for (const n of inspectDump.nodes) {
    const [x1, y1, x2, y2] = n.bounds;
    if (x >= x1 && x < x2 && y >= y1 && y < y2) {
      const area = (x2 - x1) * (y2 - y1);
      if (area <= bestArea) {
        best = n;
        bestArea = area;
      }
    }
  }
  return best;
}

function hoverNodeAt(p: { x: number; y: number }) {
  drawHighlights(nodeAt(p.x, p.y));
}

function selectNodeAt(x: number, y: number) {
  const n = nodeAt(x, y);
  if (!n) return;
  selected = n;
  drawHighlights();
  renderInspector();
  panel.querySelector(`[data-n="${n.id}"]`)?.scrollIntoView({ block: "center" });
}

async function captureUi() {
  const btn = panel.querySelector<HTMLButtonElement>("#cap");
  if (btn) btn.disabled = true;
  try {
    inspectDump = (await api.invoke("mirror:action", "inspect")) as typeof inspectDump;
    selected = undefined;
    setInspecting(true);
  } catch (e) {
    toast((e as Error).message.replace(/^Error invoking remote method '[^']+': /, ""), 5000);
  }
  renderInspector();
}

function renderInspector() {
  if (openPanel !== "inspector") return;
  const rows = (inspectDump?.nodes ?? [])
    .map((n) => {
      const cls = n.className.split(".").pop();
      const txt = n.text ? ` <span class="txt">${esc(JSON.stringify(n.text.slice(0, 40)))}</span>` : "";
      const rid = n.resourceId ? ` <span class="rid">${esc(n.resourceId.replace(/^.*:id\//, "#"))}</span>` : "";
      const desc = n.contentDesc ? ` <span class="muted">${esc(n.contentDesc.slice(0, 30))}</span>` : "";
      return `<div data-n="${n.id}" class="${selected?.id === n.id ? "sel" : ""}" style="padding-left:${6 + n.depth * 12}px"><span class="cls">${esc(cls ?? "")}</span>${txt}${rid}${desc}</div>`;
    })
    .join("");
  const p = selected;
  const prop = (label: string, value: string) =>
    value ? `<span>${label}</span><code title="${esc(value)}">${esc(value)}</code><button class="btn ghost small" data-copy="${esc(value)}">${icons.copy}</button>` : "";
  panel.innerHTML = `
    <header><h2>UI inspector</h2><span class="muted mono">${esc(inspectDump?.foreground ?? "")}</span></header>
    <div class="tools">
      <button class="btn primary small" id="cap">${inspectDump ? "Refresh" : "Capture screen"}</button>
      <label class="switch" style="padding:0;gap:6px"><input type="checkbox" id="insp" ${inspecting ? "checked" : ""}> Pick mode</label>
    </div>
    <div class="body">
      ${p ? `<div class="props">${prop("class", p.className)}${prop("text", p.text)}${prop("resource-id", p.resourceId)}${prop("desc", p.contentDesc)}${prop("package", p.packageName)}${prop("bounds", p.bounds.join(", "))}${prop("flags", [p.clickable && "clickable", p.scrollable && "scrollable", p.focusable && "focusable", !p.enabled && "disabled"].filter(Boolean).join(" "))}</div>` : ""}
      ${inspectDump ? `<div class="tree">${rows || '<p class="muted">Empty hierarchy</p>'}</div>` : '<p class="muted">Captures the accessibility tree of the current screen. With pick mode on, hover the mirror to see elements and click to select one — clicks don\'t reach the phone while picking. Games and video surfaces have no tree.</p>'}
    </div>`;
  $("cap").onclick = () => void captureUi();
  $<HTMLInputElement>("insp").onchange = (e) => setInspecting((e.target as HTMLInputElement).checked);
  panel.querySelectorAll<HTMLElement>("[data-n]").forEach((el) => {
    const n = inspectDump!.nodes[Number(el.dataset.n)]!;
    el.onmouseenter = () => drawHighlights(n);
    el.onclick = () => {
      selected = n;
      drawHighlights();
      renderInspector();
    };
  });
  panel.querySelectorAll<HTMLElement>("[data-copy]").forEach((el) => {
    el.onclick = () => {
      void api.invoke("clipboard:write", el.dataset.copy!);
      toast("Copied");
    };
  });
}

// --- logcat

interface LogLine {
  t: number;
  pid: number;
  level: string;
  tag: string;
  msg: string;
}
let logPaused = false;
let logFilter = "";
let logMin = "V";

function logRow(l: LogLine) {
  return `<div class="${l.level}">${new Date(l.t).toISOString().slice(11, 23)} ${String(l.pid).padStart(5)} ${l.level} ${esc(l.tag)}: ${esc(l.msg)}</div>`;
}
function logPasses(l: LogLine) {
  if ("VDIWEF".indexOf(l.level) < "VDIWEF".indexOf(logMin)) return false;
  if (!logFilter) return true;
  const f = logFilter.toLowerCase();
  return l.tag.toLowerCase().includes(f) || l.msg.toLowerCase().includes(f) || String(l.pid) === f;
}

async function renderLogcat() {
  panel.innerHTML = `
    <header><h2>Logcat</h2><span class="badge ok">live</span></header>
    <div class="tools">
      <input type="text" id="lf" placeholder="Filter tag, text or PID" value="${esc(logFilter)}" style="flex:1">
      <select id="lv">${["V", "D", "I", "W", "E"].map((l) => `<option ${l === logMin ? "selected" : ""}>${l}</option>`).join("")}</select>
      <button class="btn small" id="lp">${logPaused ? "Resume" : "Pause"}</button>
      <button class="btn small" id="lc">Clear</button>
    </div>
    <div class="body"><div class="log" id="log"></div></div>`;
  const initial = (await api.invoke("mirror:action", "logcat", true)) as LogLine[];
  const log = $("log");
  log.innerHTML = initial.filter(logPasses).map(logRow).join("");
  log.scrollTop = log.scrollHeight;
  $<HTMLInputElement>("lf").oninput = (e) => {
    logFilter = (e.target as HTMLInputElement).value;
    void api.invoke("mirror:action", "logcat", true).then((all) => {
      log.innerHTML = (all as LogLine[]).filter(logPasses).map(logRow).join("");
      log.scrollTop = log.scrollHeight;
    });
  };
  $<HTMLSelectElement>("lv").onchange = (e) => {
    logMin = (e.target as HTMLSelectElement).value;
    $<HTMLInputElement>("lf").dispatchEvent(new Event("input"));
  };
  $("lp").onclick = () => {
    logPaused = !logPaused;
    $("lp").textContent = logPaused ? "Resume" : "Pause";
  };
  $("lc").onclick = () => (log.innerHTML = "");
}

api.on("mirror:logcat", (lines) => {
  if (openPanel !== "logcat" || logPaused) return;
  const log = document.getElementById("log");
  if (!log) return;
  const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
  log.insertAdjacentHTML("beforeend", (lines as LogLine[]).filter(logPasses).map(logRow).join(""));
  while (log.childElementCount > 3000) log.firstElementChild!.remove();
  if (stick) log.scrollTop = log.scrollHeight;
});

// --- timeline

let evidence = false;
function eventRow(e: TimelineEntry) {
  return `<div class="event ${e.source}"><time>${new Date(e.t).toLocaleTimeString()}</time><b>${esc(e.kind)}</b> <span class="muted">· ${e.source}</span><p>${esc(e.detail)}</p></div>`;
}
async function renderTimeline() {
  const entries = (await api.invoke("mirror:action", "timelineGet")) as TimelineEntry[];
  panel.innerHTML = `
    <header><h2>Timeline</h2><span class="muted">${entries.length} events</span></header>
    <div class="tools">
      <label class="switch" style="padding:0;gap:6px" title="Capture a screenshot after each of your taps, swipes and keys"><input type="checkbox" id="ev" ${evidence ? "checked" : ""}> Evidence mode</label>
      <button class="btn small" id="tx">Export report</button>
      <button class="btn small" id="tf">Folder</button>
    </div>
    <div class="tools"><input type="text" id="tn" placeholder="Add a note or hypothesis, Enter to save" style="flex:1"></div>
    <div class="body"><div class="events" id="events">${entries.slice(-300).reverse().map(eventRow).join("")}</div></div>`;
  $<HTMLInputElement>("ev").onchange = async (e) => {
    evidence = Boolean(await api.invoke("mirror:action", "timelineEvidence", (e.target as HTMLInputElement).checked));
  };
  $("tx").onclick = async () => toast(`Report: ${String(await api.invoke("mirror:action", "timelineExport")).split(/[\\/]/).pop()}`);
  $("tf").onclick = () => void api.invoke("mirror:action", "timelineFolder");
  $<HTMLInputElement>("tn").onkeydown = async (e) => {
    const input = e.target as HTMLInputElement;
    if (e.key === "Enter" && input.value.trim()) {
      await api.invoke("mirror:action", "timelineNote", input.value.trim());
      input.value = "";
    }
  };
}
api.on("mirror:timeline", (e) => {
  const list = document.getElementById("events");
  if (openPanel === "timeline" && list) list.insertAdjacentHTML("afterbegin", eventRow(e as TimelineEntry));
});

// --- agent

async function renderAgent() {
  const a = (await api.invoke("mirror:action", "agentInfo")) as { enabled: boolean; running: boolean; error?: string; url: string; claudeCode: string; json: string };
  panel.innerHTML = `
    <header><h2>AI agent</h2><span class="badge ${a.running ? "ok" : a.enabled ? "err" : ""}">${a.running ? "listening" : a.enabled ? "error" : "off"}</span></header>
    <div class="body">
      <p>Let Claude (or any MCP client) see this screen and use it: tap, swipe, type, read the UI tree and logcat. Every agent action flashes here in purple and lands on your timeline.</p>
      ${a.error ? `<div class="note">${esc(a.error)}</div>` : ""}
      <div class="label">Claude Code</div><pre class="cmd" id="cc">${esc(a.claudeCode)}</pre>
      <button class="btn small" id="ccc">${icons.copy} Copy command</button>
      <div class="label">Other MCP clients (JSON)</div><pre class="cmd" id="js">${esc(a.json)}</pre>
      <button class="btn small" id="jsc">${icons.copy} Copy JSON</button>
      <p class="muted">The endpoint listens on 127.0.0.1 only and needs the token. Regenerate it or turn the agent off from the main window.</p>
    </div>`;
  $("ccc").onclick = () => (void api.invoke("clipboard:write", a.claudeCode), toast("Copied"));
  $("jsc").onclick = () => (void api.invoke("clipboard:write", a.json), toast("Copied"));
}

let chipTimer: number | undefined;
api.on("mirror:indicate", (d) => {
  const { kind, x, y, x2, y2 } = d as { kind: string; x?: number; y?: number; x2?: number; y2?: number };
  agentChip.textContent = `Agent: ${kind}`;
  agentChip.classList.add("on");
  clearTimeout(chipTimer);
  chipTimer = window.setTimeout(() => agentChip.classList.remove("on"), 1500);
  const s = video.size;
  if (!s || x === undefined || y === undefined) return;
  const pct = (v: number, max: number) => `${(v / max) * 100}%`;
  if (kind === "swipe" && x2 !== undefined && y2 !== undefined) {
    const r = screenEl.getBoundingClientRect();
    const dx = ((x2 - x) / s.width) * r.width;
    const dy = ((y2 - y) / s.height) * r.height;
    const el = document.createElement("div");
    el.className = "trail";
    Object.assign(el.style, { left: pct(x, s.width), top: pct(y, s.height), width: `${Math.hypot(dx, dy)}px`, transform: `rotate(${Math.atan2(dy, dx)}rad)` });
    overlay.appendChild(el);
    setTimeout(() => el.remove(), 1000);
  }
  const rip = document.createElement("div");
  rip.className = "ripple";
  Object.assign(rip.style, { left: pct(x, s.width), top: pct(y, s.height) });
  overlay.appendChild(rip);
  setTimeout(() => rip.remove(), 800);
});

// ------------------------------------------------------------------ boot

void api.invoke("settings:get").then((s) => {
  pinned = Boolean((s as { alwaysOnTop: boolean }).alwaysOnTop);
  renderToolbar();
});
renderToolbar();
if (readOnly) {
  ime.disabled = true;
  statusText.textContent = "Waiting for your iPhone…";
} else ime.focus();
void api.invoke("mirror:ready");
// Exposed for end-to-end tests.
(window as unknown as { __mirrorlab: unknown }).__mirrorlab = {
  video,
  get audio() {
    return audio;
  },
  get connected() {
    return connected;
  },
  get deviceName() {
    return deviceName;
  },
};
