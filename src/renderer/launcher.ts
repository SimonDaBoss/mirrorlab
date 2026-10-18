import type { MirrorlabApi } from "../preload/preload";
import type { AdbDevice } from "../main/adb";
import type { UsbIphone, UsbDriverResult } from "../main/ios/usb";
import type { DoctorReport, Settings } from "../shared/types";
import { icons } from "./icons";

declare global {
  interface Window {
    mirrorlab: MirrorlabApi;
  }
}
const api = window.mirrorlab;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

let toastTimer: number | undefined;
function toast(msg: string, ms = 2600) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), ms);
}
api.on("ios:usbError", (msg) => toast(String(msg), 10000));

$("brand").innerHTML = `${icons.logo.replace("<svg", '<svg width="28" height="28"')}<div><h1>Mirrorlab</h1><div class="muted">Android &amp; iPhone mirroring · open source</div></div>`;

// ------------------------------------------------------------------ devices

let lastKey = "";
async function refreshDevices() {
  let list: AdbDevice[] = [];
  const iphones = await api.invoke("ios:usbDevices").catch(() => []) as UsbIphone[];
  try {
    list = (await api.invoke("devices")) as AdbDevice[];
    $("scan").textContent = `${list.length + iphones.length} found · refreshes automatically`;
  } catch (e) {
    $("scan").textContent = "adb unavailable — see Health check";
  }
  const key = JSON.stringify([list, iphones]);
  if (key === lastKey) return;
  lastKey = key;
  $("empty").hidden = list.length + iphones.length > 0;
  $("devices").innerHTML = list
    .map((d) => {
      const icon = d.kind === "wifi" ? icons.wifi : d.kind === "emulator" ? icons.emulator : icons.usb;
      const ready = d.state === "device";
      const stateBadge = ready
        ? `<span class="badge ok">${d.kind === "wifi" ? "Wi-Fi" : d.kind === "emulator" ? "Emulator" : "USB"}</span>`
        : `<span class="badge warn">${esc(d.state)}</span>`;
      const hint =
        d.state === "unauthorized"
          ? '<p class="muted" style="margin:0">Unlock the phone and accept “Allow USB debugging”.</p>'
          : d.state === "offline"
            ? '<p class="muted" style="margin:0">Offline — replug the cable or reconnect.</p>'
            : "";
      return `<div class="device">
        <div class="row" style="justify-content:space-between"><span style="color:var(--muted)">${icon.replace("<svg", '<svg width="18" height="18"')}</span>${stateBadge}</div>
        <div><div class="name">${esc(d.model ?? d.product ?? "Android device")}</div><div class="serial" title="${esc(d.serial)}">${esc(d.serial)}</div></div>
        ${hint}
        <div class="actions">
          <button class="btn primary" data-mirror="${esc(d.serial)}" ${ready ? "" : "disabled"}>Mirror</button>
          ${d.kind === "usb" && ready ? `<button class="btn" data-wifi="${esc(d.serial)}" title="Switch this phone to Wi-Fi so you can unplug it">Go wireless</button>` : ""}
          ${d.kind === "wifi" ? `<button class="btn" data-disc="${esc(d.serial)}">Disconnect</button>` : ""}
        </div>
      </div>`;
    })
    .join("") + iphones.map((d) => `<div class="device">
      <div class="row" style="justify-content:space-between">${icons.usb}<span class="badge ok">iPhone · USB</span></div>
      <div><div class="name">${esc(d.name)}</div><div class="muted">${esc(d.model)}${d.osVersion ? ` · iOS ${esc(d.osVersion)}` : ""}</div></div>
      ${d.captureError ? `<div class="note">${esc(d.captureError)}</div>`
        : d.driver === "missing" ? '<p class="muted" style="margin:0">One-time USB setup needed (administrator prompt).</p>'
        : d.driver === "replug" ? '<p class="muted" style="margin:0">Unplug and reconnect the iPhone to finish USB setup.</p>' : ""}
      <div class="actions">${d.driver === "missing"
        ? `<button class="btn primary" data-usb-setup="${esc(d.serial)}">Set up USB</button>`
        : `<button class="btn primary" data-iphone="${esc(d.serial)}" ${d.driver === "replug" ? "disabled" : ""}>${d.captureError ? "Retry USB" : "Mirror with USB"}</button><button class="btn" data-usb-setup="${esc(d.serial)}">Repair USB</button>`}</div>
    </div>`).join("");
}

$("devices").addEventListener("click", async (e) => {
  const t = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (!t) return;
  if (t.dataset.iphone) {
    t.disabled = true; t.textContent = "Connecting…";
    try { await api.invoke("ios:usbOpen", t.dataset.iphone); toast("Starting USB mirroring — keep your iPhone unlocked", 5000); }
    catch (err) { toast(clean(err), 7000); }
    finally { t.disabled = false; t.textContent = "Mirror with USB"; }
  }
  if (t.dataset.usbSetup) {
    const label = t.textContent;
    t.disabled = true; t.textContent = "Setting up…";
    toast("Approve the Windows administrator prompt to set up USB capture", 6000);
    try { const r = await api.invoke("ios:usbInstall", t.dataset.usbSetup) as UsbDriverResult; toast(r.message, r.ok ? 8000 : 10000); lastKey = ""; void refreshDevices(); }
    catch (err) { toast(clean(err), 8000); }
    finally { t.disabled = false; t.textContent = label; }
  }
  if (t.dataset.mirror) await api.invoke("mirror:open", t.dataset.mirror);
  if (t.dataset.wifi) {
    t.disabled = true;
    t.textContent = "Switching…";
    try {
      const target = (await api.invoke("adb:wifi", t.dataset.wifi)) as string;
      toast(`Connected over Wi-Fi at ${target} — you can unplug the cable`, 4000);
    } catch (err) {
      toast(clean(err), 5000);
    }
    lastKey = "";
    void refreshDevices();
  }
  if (t.dataset.disc) {
    await api.invoke("adb:disconnect", t.dataset.disc).catch(() => undefined);
    lastKey = "";
    void refreshDevices();
  }
});

$("connect").onclick = async () => {
  let host = $<HTMLInputElement>("host").value.trim();
  if (!host) return;
  if (!host.includes(":")) host += ":5555";
  try {
    const out = String(await api.invoke("adb:connect", host));
    toast(out.trim() || `Connected to ${host}`);
  } catch (e) {
    toast(clean(e), 5000);
  }
  void refreshDevices();
};
$("pair").onclick = async () => {
  const host = $<HTMLInputElement>("pairHost").value.trim();
  const code = $<HTMLInputElement>("pairCode").value.trim();
  if (!host || !code) return toast("Enter the pairing IP:port and code shown on the phone");
  try {
    toast(String(await api.invoke("adb:pair", host, code)).trim() + " — now connect using the IP:port on the Wireless debugging screen", 6000);
  } catch (e) {
    toast(clean(e), 5000);
  }
};

// ------------------------------------------------------------------ settings

let settings: Settings;
const presets = [
  { id: "smooth", name: "Smooth", sub: "1080p · 60 fps", maxSize: 1920, videoBitRate: 8_000_000, maxFps: 60 },
  { id: "sharp", name: "Sharp", sub: "Native · 16 Mb/s", maxSize: 0, videoBitRate: 16_000_000, maxFps: 60 },
  { id: "saver", name: "Saver", sub: "720p · Wi-Fi", maxSize: 1280, videoBitRate: 3_000_000, maxFps: 30 },
];
const toggles: [keyof Settings, string, string][] = [
  ["audio", "Phone audio on PC", "Android 11+ and iPhone/iPad"],
  ["turnScreenOff", "Turn phone screen off", "Saves battery; mirroring continues"],
  ["stayAwake", "Keep phone awake", "While plugged in"],
  ["clipboardSync", "Sync clipboard", "Both directions"],
  ["showTouches", "Show touches on phone", ""],
  ["alwaysOnTop", "Mirror stays on top", ""],
];

function renderSettings() {
  $("presets").innerHTML = presets
    .map((p) => {
      const active = p.maxSize === settings.maxSize && p.videoBitRate === settings.videoBitRate && p.maxFps === settings.maxFps;
      return `<button class="btn ${active ? "active" : ""}" data-preset="${p.id}">${p.name}<small>${p.sub}</small></button>`;
    })
    .join("");
  $("toggles").innerHTML = toggles
    .map(
      ([k, label, sub]) =>
        `<label class="switch"><span>${label}${sub ? `<small>${sub}</small>` : ""}</span><input type="checkbox" data-k="${k}" ${settings[k] ? "checked" : ""}></label>`,
    )
    .join("");
}

$("presets").addEventListener("click", async (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>("[data-preset]")?.dataset.preset;
  const p = presets.find((x) => x.id === id);
  if (!p) return;
  settings = (await api.invoke("settings:set", { maxSize: p.maxSize, videoBitRate: p.videoBitRate, maxFps: p.maxFps })) as Settings;
  renderSettings();
  toast("Applies to the next mirror you open");
});
$("toggles").addEventListener("change", async (e) => {
  const el = e.target as HTMLInputElement;
  settings = (await api.invoke("settings:set", { [el.dataset.k!]: el.checked })) as Settings;
});

// ------------------------------------------------------------------ agent

async function renderAgent() {
  const a = (await api.invoke("agent:info")) as { enabled: boolean; running: boolean; error?: string; url: string; claudeCode: string };
  const badge = $("agentBadge");
  badge.className = `badge ${a.running ? "ok" : a.enabled ? "err" : ""}`;
  badge.textContent = a.running ? "listening" : a.enabled ? "error" : "off";
  $("agent").innerHTML = `
    <p class="muted" style="margin:0">Claude or any MCP client can see and operate an open mirror. It only acts on devices you have open, and every action shows on screen.</p>
    ${a.error ? `<div class="note">${esc(a.error)}</div>` : ""}
    <label class="switch"><span>Agent endpoint<small class="mono">${esc(a.url)}</small></span><input type="checkbox" id="agentOn" ${a.enabled ? "checked" : ""}></label>
    ${a.enabled ? `<pre class="cmd">${esc(a.claudeCode)}</pre><div class="row"><button class="btn small" id="copyCmd">${icons.copy} Copy Claude Code command</button><button class="btn small ghost" id="regen">New token</button></div>` : ""}`;
  $<HTMLInputElement>("agentOn").onchange = async (e) => {
    await api.invoke("settings:set", { agentEnabled: (e.target as HTMLInputElement).checked });
    void renderAgent();
  };
  document.getElementById("copyCmd")?.addEventListener("click", () => {
    void api.invoke("clipboard:write", a.claudeCode);
    toast("Copied — paste it in a terminal");
  });
  document.getElementById("regen")?.addEventListener("click", async () => {
    await api.invoke("agent:regenerate");
    toast("New token — update your MCP client");
    void renderAgent();
  });
}

// ------------------------------------------------------------------ iOS (AirPlay)

async function renderIos() {
  const a = (await api.invoke("ios:info")) as { enabled: boolean; running: boolean; error?: string; name: string; port: number };
  const badge = $("iosBadge");
  badge.className = `badge ${a.running ? "ok" : a.enabled ? "err" : ""}`;
  badge.textContent = a.running ? "ready" : a.enabled ? "error" : "off";
  $("ios").innerHTML = `
    <p class="muted" style="margin:0">Mirror over USB with the button on your connected iPhone’s card, or use AirPlay with sound on the same Wi-Fi.</p>
    ${a.error ? `<div class="note">${esc(a.error)}</div>` : ""}
    <label class="switch"><span>Receive AirPlay<small>Advertises this PC to nearby devices</small></span><input type="checkbox" id="iosOn" ${a.enabled ? "checked" : ""}></label>
    ${a.enabled ? `<div class="field"><label for="iosName">Name shown on your iPhone</label><div class="row"><input type="text" id="iosName" value="${esc(a.name)}"><button class="btn" id="iosSave">Save</button></div></div>` : ""}
    ${a.running ? `<ol class="muted" style="margin:0;padding-left:18px"><li>On the iPhone, open Control Center.</li><li>Tap <b>Screen Mirroring</b>.</li><li>Pick <b>${esc(a.name)}</b>.</li></ol>` : ""}
    <p class="muted" style="margin:0;font-size:11px">View-only, with screenshots and recording. Allow Mirrorlab and its AirPlay receiver through Windows Firewall on your private network if prompted. Protected streaming apps may show a black screen.</p>`;
  $<HTMLInputElement>("iosOn").onchange = async (e) => {
    await api.invoke("settings:set", { iosEnabled: (e.target as HTMLInputElement).checked });
    void renderIos();
  };
  document.getElementById("iosSave")?.addEventListener("click", async () => {
    const name = $<HTMLInputElement>("iosName").value.trim() || "Mirrorlab";
    await api.invoke("settings:set", { iosName: name });
    toast("Saved — reconnect from your iPhone");
    void renderIos();
  });
}

// ------------------------------------------------------------------ doctor

async function renderDoctor() {
  const d = (await api.invoke("doctor")) as DoctorReport;
  const ok = !d.adbError && d.serverJarOk;
  $("doctor").innerHTML = `
    <div class="row" style="justify-content:space-between"><span>adb</span><span class="badge ${d.adbError ? "err" : "ok"}">${d.adbError ? "missing" : esc(d.adbSource)}</span></div>
    <div class="mono" style="font-size:11px;word-break:break-all">${esc(d.adbVersion ?? d.adbError ?? "")}</div>
    <div class="row" style="justify-content:space-between"><span>scrcpy server 5.0.1</span><span class="badge ${d.serverJarOk ? "ok" : "err"}">${d.serverJarOk ? "bundled" : "missing"}</span></div>
    ${d.notes.map((n) => `<div class="note">${esc(n)}</div>`).join("")}
    ${ok && !d.notes.length ? '<span class="muted">All good.</span>' : ""}`;
}

// ------------------------------------------------------------------ boot

void (async () => {
  settings = (await api.invoke("settings:get")) as Settings;
  renderSettings();
  void renderIos();
  void renderAgent();
  void renderDoctor();
  await refreshDevices();
  setInterval(refreshDevices, 2000);
})();
