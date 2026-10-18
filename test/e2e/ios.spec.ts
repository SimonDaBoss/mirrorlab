import { controlsFor } from "./controls";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MirrorDecryptor } from "../../src/main/airplay/crypto";
import { annexBToAvcc, encodeMirrorPacket, MirrorPayload } from "../../src/shared/airplay/mirror";
import { buildBplist, parseBplist, type PlistValue } from "../../src/shared/airplay/bplist";

const root = path.join(__dirname, "..", "..");
const RTSP_PORT = 47021;
const TEST_KEY = Buffer.alloc(16, 0x11); // matches the app's TestKeyProvider

let app: ElectronApplication;
let state: string;

test.beforeAll(async () => {
  state = fs.mkdtempSync(path.join(os.tmpdir(), "ml-ios-"));
  const userData = path.join(state, "userData");
  fs.mkdirSync(userData, { recursive: true });
  // iOS on, mDNS advertising harmless under xvfb; pin the RTSP port; Android agent off.
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ iosEnabled: true, iosPort: RTSP_PORT, iosName: "Mirrorlab-Test", agentEnabled: false }));
  app = await electron.launch({
    executablePath: process.env.MIRRORLAB_E2E_EXECUTABLE,
    args: [root, "--no-sandbox"],
    env: { ...process.env, MIRRORLAB_USER_DATA: userData, MIRRORLAB_TEST: "1", MIRRORLAB_AIRPLAY_ENGINE: "synthetic", MIRRORLAB_ADB: path.join(root, "test", "fake-adb.mjs") },
  });
  await app.firstWindow();
});

test.afterAll(async () => {
  await app?.close();
});

/** Minimal RTSP client that speaks just enough to drive the receiver. */
class FakeIPhone {
  private sock!: net.Socket;
  private pending: ((b: Buffer) => void)[] = [];
  private cseq = 0;
  async connect(port: number) {
    this.sock = net.connect(port, "127.0.0.1");
    await new Promise<void>((r, j) => {
      this.sock.once("connect", () => r());
      this.sock.once("error", j);
    });
    let buf = Buffer.alloc(0);
    this.sock.on("data", (c) => {
      buf = Buffer.concat([buf, c]);
      for (;;) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) break;
        const headers = buf.subarray(0, end).toString("latin1");
        const m = /content-length:\s*(\d+)/i.exec(headers);
        const len = m ? Number(m[1]) : 0;
        if (buf.length < end + 4 + len) return;
        const body = buf.subarray(end + 4, end + 4 + len);
        buf = buf.subarray(end + 4 + len);
        this.pending.shift()?.(body);
      }
    });
  }
  req(method: string, url: string, body?: Buffer): Promise<Buffer> {
    const lines = [`${method} ${url} RTSP/1.0`, `CSeq: ${this.cseq++}`];
    if (body) lines.push("Content-Type: application/x-apple-binary-plist", `Content-Length: ${body.length}`);
    lines.push("", "");
    const head = Buffer.from(lines.join("\r\n"), "latin1");
    return new Promise((resolve) => {
      this.pending.push(resolve);
      this.sock.write(body ? Buffer.concat([head, body]) : head);
    });
  }
  close() {
    this.sock.destroy();
  }
}

test("an iPhone (AirPlay) mirrors into a view-only window and the stream decodes", async () => {
  // Drive the receiver exactly as iOS would.
  const phone = new FakeIPhone();
  await phone.connect(RTSP_PORT);
  await phone.req("GET", "/info");
  await phone.req("SETUP", "rtsp://x/stream", buildBplist({ name: "Simon's iPhone", ekey: new Uint8Array(TEST_KEY), eiv: new Uint8Array(16), timingPort: 0 }));
  const sid = 777777n;
  const mirrorPromise = app.waitForEvent("window", { timeout: 10_000 });
  const res = await phone.req("SETUP", "rtsp://x/stream", buildBplist({ streams: [{ type: 110, streamConnectionID: sid }] }));
  const streams = (parseBplist(res) as { streams: Record<string, PlistValue>[] }).streams;
  const dataPort = Number(streams[0]!["dataPort"]);
  expect(dataPort).toBeGreaterThan(0);

  // The iOS mirror window should have opened.
  const mirror: Page = await mirrorPromise;
  await expect(mirror).toHaveTitle(/iPhone/i, { timeout: 8000 });
  await mirror.waitForFunction(() => !!(window as any).__mirrorlab?.video);

  // Stream config + encrypted frames on the data connection.
  const data = net.connect(dataPort, "127.0.0.1");
  await new Promise<void>((r) => data.once("connect", () => r()));
  const fixture = fs.readFileSync(path.join(root, "test", "fixtures", "stream.h264"));
  const nals = fixture.toString("latin1").split(/\x00\x00\x00?\x01/).filter(Boolean).map((n) => Buffer.from(n, "latin1"));
  const config = nals.filter((n) => [7, 8].includes(n[0]! & 31));
  data.write(encodeMirrorPacket(MirrorPayload.CONFIG, annexBToAvcc(config), { width: 368, height: 640 }));
  const enc = new MirrorDecryptor(sid.toString(), TEST_KEY);
  const frames: Buffer[][] = [];
  for (const nal of nals.filter((n) => [1, 5].includes(n[0]! & 31))) {
    if (!frames.length || (nal[1]! & 0x80)) frames.push([]);
    frames[frames.length - 1]!.push(nal);
  }
  for (const frame of frames.slice(0, 30)) {
    data.write(encodeMirrorPacket(MirrorPayload.VIDEO, enc.decrypt(Buffer.from(annexBToAvcc(frame)))));
    await new Promise((r) => setTimeout(r, 35));
  }

  // The window receives the session size and decodes packets.
  await mirror.waitForFunction(
    () => {
      const w = window as any;
      return w.__mirrorlab?.video?.size?.width === 368 && w.__mirrorlab.video.stats.decoded > 10;
    },
    null,
    { timeout: 8000 },
  );
  const controls = await controlsFor(mirror);
  const tools = await controls.locator("[data-t]").evaluateAll(elements => elements.map(e => (e as HTMLElement).dataset.t));
  const info = await mirror.evaluate(() => ({
    size: (window as any).__mirrorlab.video.size,
  }));
  expect(info.size).toEqual({ width: 368, height: 640 });
  expect(await mirror.evaluate(() => {
    const c = document.getElementById("canvas") as HTMLCanvasElement;
    return c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 !== 3 && v > 60);
  })).toBe(true);
  expect(tools).not.toContain("back");
  expect(tools).not.toContain("inspector");
  expect(tools).toContain("shot");
  expect(tools).toContain("rec");

  const shotDir = path.join(root, "test", "screenshots");
  fs.mkdirSync(shotDir, { recursive: true });
  await mirror.screenshot({ path: path.join(shotDir, "ios-mirror.png") });

  data.destroy();
  phone.close();
});
