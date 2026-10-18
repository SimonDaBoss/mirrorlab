#!/usr/bin/env node
/**
 * Fake `adb` + scrcpy-server emulator for tests and demos (no phone needed).
 *
 * State lives in $FAKE_ADB_STATE (a directory):
 *   forwards.json   socket name → local port
 *   control.bin     every control message byte the "device" received
 *   shell.log       every `adb shell` command, one per line
 *   pushed.log      every push
 *
 * Point Mirrorlab at it with MIRRORLAB_ADB=/path/to/fake-adb.mjs.
 * It writes the scrcpy wire format independently of src/shared/protocol.ts,
 * so tests cross-check the real parser against a second implementation.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const STATE = process.env.FAKE_ADB_STATE || path.join(here, ".fake-adb-state");
fs.mkdirSync(STATE, { recursive: true });
const SERIAL = "FAKE0001";
const WIDTH = 368;
const HEIGHT = 640;

const args = process.argv.slice(2);
let serial = null;
if (args[0] === "-s") {
  serial = args[1];
  args.splice(0, 2);
}
const log = (file, line) => fs.appendFileSync(path.join(STATE, file), line + "\n");
const readForwards = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE, "forwards.json"), "utf8"));
  } catch {
    return {};
  }
};

async function main() {
  const [cmd, ...rest] = args;
  if (serial && serial !== SERIAL && !serial.startsWith("127.0.0.1:")) {
    process.stderr.write(`adb: device '${serial}' not found\n`);
    process.exit(1);
  }
  switch (cmd) {
    case "version":
      console.log("Android Debug Bridge version 1.0.41\nVersion 36.0.0-fake");
      return;
    case "devices":
      console.log(`List of devices attached\n${SERIAL}               device usb:1-1 product:fake model:Fake_Pixel device:fake transport_id:1\n`);
      return;
    case "push":
      log("pushed.log", `${rest[0]} -> ${rest[1]}`);
      console.log(`${rest[0]}: 1 file pushed.`);
      return;
    case "install":
      log("pushed.log", `install ${rest.join(" ")}`);
      console.log("Success");
      return;
    case "forward": {
      if (rest[0] === "--remove") return;
      const port = await freePort();
      const fw = readForwards();
      fw[rest[1]] = port;
      fs.writeFileSync(path.join(STATE, "forwards.json"), JSON.stringify(fw));
      console.log(String(port));
      return;
    }
    case "connect":
      console.log(`connected to ${rest[0]}`);
      return;
    case "exec-out":
    case "shell":
      return shell(rest);
    default:
      process.stderr.write(`fake adb: unsupported ${args.join(" ")}\n`);
      process.exit(1);
  }
}

function shell(rest) {
  const command = rest.join(" ");
  log("shell.log", command);
  if (rest[0]?.startsWith("CLASSPATH=") && rest[1] === "app_process") return scrcpyServer(rest.slice(5));
  if (command.startsWith("uiautomator dump")) return console.log("UI hierchary dumped to: /sdcard/window_dump.xml");
  if (command.startsWith("cat ") && command.includes("mirrorlab_ui.xml")) return process.stdout.write(UI_XML);
  if (command === "wm size") return console.log(`Physical size: ${WIDTH * 2}x${HEIGHT * 2}`);
  if (command.startsWith("getprop ro.build.version.sdk")) return console.log("34");
  if (command.startsWith("dumpsys activity activities")) return console.log("  topResumedActivity=ActivityRecord{1 u0 com.example.notes/.MainActivity t9}");
  if (command.startsWith("pidof")) return console.log("4242");
  if (command.startsWith("pm list packages")) return console.log("package:com.example.notes\npackage:com.android.settings");
  if (command.startsWith("ip -f inet addr show wlan0")) return console.log("    inet 192.168.1.50/24 brd 192.168.1.255 scope global wlan0");
  if (command.startsWith("logcat")) {
    const now = Date.now() / 1000;
    return console.log(
      [
        `${now.toFixed(3)}  4242  4242 I NotesActivity: onResume`,
        `${(now + 0.1).toFixed(3)}  4242  4250 D OkHttp: --> POST https://api.example.com/v1/notes`,
        `${(now + 0.2).toFixed(3)}  1000  1000 W SystemServer: unrelated`,
      ].join("\n"),
    );
  }
  if (command.startsWith("input ")) return;
  // Unknown shell commands succeed silently, like many toybox applets.
}

/** Emulates com.genymobile.scrcpy.Server with tunnel_forward=true. */
async function scrcpyServer(params) {
  const opts = Object.fromEntries(params.map((p) => p.split("=")));
  const name = `localabstract:scrcpy_${opts.scid}`;
  const port = readForwards()[name];
  if (!port) {
    process.stderr.write(`[server] ERROR: no forward for ${name}\n`);
    process.exit(1);
  }
  const wantVideo = opts.video !== "false";
  const wantAudio = opts.audio !== "false";
  const wantControl = opts.control !== "false";
  const order = [wantVideo && "video", wantAudio && "audio", wantControl && "control"].filter(Boolean);
  console.log(`[server] INFO: Device: [Fake] Fake Pixel (Android 14)`);
  const frames = loadFrames();
  let idx = 0;
  const srv = net.createServer((sock) => {
    const kind = order[idx++];
    sock.on("error", () => {});
    if (idx === 1) {
      sock.write(Buffer.from([0])); // dummy byte
      const nameBuf = Buffer.alloc(64);
      nameBuf.write("Fake Pixel");
      sock.write(nameBuf);
    }
    if (kind === "video") streamVideo(sock, frames);
    else if (kind === "audio") {
      if (process.env.FAKE_ADB_AUDIO === "0") sock.write(u32(0)); // audio explicitly disabled by the device
      else streamAudio(sock);
    }
    else if (kind === "control") {
      sock.on("data", (d) => fs.appendFileSync(path.join(STATE, "control.bin"), d));
      // Device clipboard → PC
      const text = Buffer.from("copied on phone");
      sock.write(Buffer.concat([Buffer.from([0]), u32(text.length), text]));
    }
    if (idx >= order.length) srv.close();
  });
  srv.listen(port, "127.0.0.1");
  // Keep running until killed (like the real server, until the client disconnects).
  process.on("SIGTERM", () => process.exit(0));
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}

function header(flags, len) {
  const b = Buffer.alloc(12);
  b.writeBigUInt64BE(flags);
  b.writeUInt32BE(len, 8);
  return b;
}

/** Split the Annex-B fixture into one config packet (SPS+PPS) and per-frame access units. */
function loadFrames() {
  const data = fs.readFileSync(path.join(here, "fixtures", "stream.h264"));
  const nals = [];
  let start = -1;
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      const sc = i > 0 && data[i - 1] === 0 ? i - 1 : i;
      if (start >= 0) nals.push(data.subarray(start, sc));
      start = sc;
      i += 2;
    }
  }
  nals.push(data.subarray(start));
  const typeOf = (n) => n[n[2] === 1 ? 3 : 4] & 0x1f;
  const firstMb = (n) => n[(n[2] === 1 ? 3 : 4) + 1] & 0x80; // first_mb_in_slice == 0
  const config = [];
  const frames = [];
  let cur = null;
  let pendingSei = [];
  for (const n of nals) {
    const t = typeOf(n);
    if (t === 7 || t === 8) config.push(n);
    else if (t === 6) pendingSei.push(n);
    else if (t === 1 || t === 5) {
      if (!cur || firstMb(n)) {
        cur = { key: t === 5, parts: [...pendingSei] };
        pendingSei = [];
        frames.push(cur);
      }
      cur.parts.push(n);
    }
  }
  return { config: Buffer.concat(config), frames: frames.map((f) => ({ key: f.key, data: Buffer.concat(f.parts) })) };
}

function streamVideo(sock, { config, frames }) {
  sock.write(u32(0x68323634)); // "h264"
  const session = Buffer.alloc(12);
  session[0] = 0x80;
  session.writeUInt32BE(WIDTH, 4);
  session.writeUInt32BE(HEIGHT, 8);
  sock.write(session);
  sock.write(Buffer.concat([header(1n << 62n, config.length), config]));
  let i = 0;
  let pts = 0n;
  const timer = setInterval(() => {
    if (sock.destroyed) return clearInterval(timer);
    const f = frames[i % frames.length];
    const flags = (f.key ? 1n << 61n : 0n) | pts;
    sock.write(Buffer.concat([header(flags, f.data.length), f.data]));
    i++;
    pts += 33_333n;
  }, 33);
  sock.on("close", () => clearInterval(timer));
}

/** Opus packets from the Ogg fixture: [OpusHead, OpusTags, audio…]. */
function oggPackets(buf) {
  const packets = [];
  let cur = [];
  let off = 0;
  while (off + 27 <= buf.length && buf.toString("latin1", off, off + 4) === "OggS") {
    const nseg = buf[off + 26];
    const table = buf.subarray(off + 27, off + 27 + nseg);
    let p = off + 27 + nseg;
    for (const len of table) {
      cur.push(buf.subarray(p, p + len));
      p += len;
      if (len < 255) {
        packets.push(Buffer.concat(cur));
        cur = [];
      }
    }
    off = p;
  }
  return packets;
}

function streamAudio(sock) {
  const [head, , ...audio] = oggPackets(fs.readFileSync(path.join(here, "fixtures", "tone.ogg")));
  sock.write(u32(0x6f707573)); // "opus"
  sock.write(Buffer.concat([header(1n << 62n, head.length), head])); // config = OpusHead
  let i = 0;
  let pts = 0n;
  const timer = setInterval(() => {
    if (sock.destroyed) return clearInterval(timer);
    const pkt = audio[i++ % audio.length];
    sock.write(Buffer.concat([header(pts, pkt.length), pkt]));
    pts += 20_000n;
  }, 20);
  sock.on("close", () => clearInterval(timer));
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

const UI_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example.notes" content-desc="" clickable="false" enabled="true" focusable="false" scrollable="false" bounds="[0,0][736,1280]">
    <node index="0" text="Notes" resource-id="com.example.notes:id/title" class="android.widget.TextView" package="com.example.notes" content-desc="" clickable="false" enabled="true" focusable="false" scrollable="false" bounds="[32,40][400,120]" />
    <node index="1" text="" resource-id="com.example.notes:id/list" class="androidx.recyclerview.widget.RecyclerView" package="com.example.notes" content-desc="" clickable="false" enabled="true" focusable="true" scrollable="true" bounds="[0,140][736,1100]">
      <node index="0" text="Buy milk" resource-id="com.example.notes:id/note_text" class="android.widget.TextView" package="com.example.notes" content-desc="" clickable="true" enabled="true" focusable="true" scrollable="false" bounds="[32,160][704,260]" />
    </node>
    <node index="2" text="" resource-id="com.example.notes:id/fab_add" class="android.widget.ImageButton" package="com.example.notes" content-desc="Add note" clickable="true" enabled="true" focusable="true" scrollable="false" bounds="[560,1120][704,1264]" />
  </node>
</hierarchy>`;

main().catch((e) => {
  process.stderr.write(String(e?.stack || e) + "\n");
  process.exit(1);
});
