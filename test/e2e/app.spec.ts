import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.join(__dirname, "..", "..");
const PORT = 47911;
const TOKEN = "test-token-123";
const shots = path.join(root, "test", "screenshots");

let app: ElectronApplication;
let state: string;

test.beforeAll(async () => {
  state = fs.mkdtempSync(path.join(os.tmpdir(), "ml-e2e-"));
  const userData = path.join(state, "userData");
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ agentPort: PORT, agentToken: TOKEN, audio: true }));
  fs.mkdirSync(shots, { recursive: true });
  app = await electron.launch({
    executablePath: process.env.MIRRORLAB_E2E_EXECUTABLE,
    args: [root, "--no-sandbox"],
    env: {
      ...process.env,
      MIRRORLAB_ADB: path.join(root, "test", "fake-adb.mjs"),
      FAKE_ADB_STATE: path.join(state, "adb"),
      MIRRORLAB_USER_DATA: userData,
      MIRRORLAB_TEST: "1",
      MIRRORLAB_AIRPLAY_ENGINE: "synthetic",
    },
  });
});

test.afterAll(async () => {
  await app?.close();
});

const controlBytes = () => {
  try {
    return fs.readFileSync(path.join(state, "adb", "control.bin"));
  } catch {
    return Buffer.alloc(0);
  }
};

test("launcher lists the device, mirror decodes video and forwards input, agent can drive it", async () => {
  const launcher = await app.firstWindow();
  await launcher.setViewportSize({ width: 1000, height: 700 });
  await expect(launcher.locator(".device .name", { hasText: "Fake Pixel" })).toHaveText("Fake Pixel", { timeout: 15_000 });
  await expect(launcher.locator("#agentBadge")).toHaveText("listening");
  await expect(launcher.locator("#doctor")).toContainText("bundled");
  await launcher.screenshot({ path: path.join(shots, "launcher.png") });

  const mirrorPromise = app.waitForEvent("window");
  await launcher.locator("[data-mirror]").click();
  const mirror: Page = await mirrorPromise;
  await mirror.waitForFunction(() => (window as any).__mirrorlab?.connected === true, null, { timeout: 20_000 });

  // Frames are really decoded and drawn: the test pattern is colorful, not black.
  await mirror.waitForTimeout(800);
  const px = await mirror.evaluate(() => {
    const c = document.getElementById("canvas") as HTMLCanvasElement;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4 * 97) if (d[i]! + d[i + 1]! + d[i + 2]! > 60) lit++;
    return { w: c.width, h: c.height, lit, decoded: (window as any).__mirrorlab.video.stats.decoded };
  });
  expect(px.w).toBe(368);
  expect(px.h).toBe(640);
  expect(px.lit).toBeGreaterThan(100);
  expect(px.decoded).toBeGreaterThan(10);

  // Phone audio: Opus decoded by WebCodecs and scheduled into Web Audio.
  const audio = await mirror.evaluate(async () => {
    const w = window as any;
    await new Promise((r) => setTimeout(r, 400));
    return { active: w.__mirrorlab.audio?.active, played: w.__mirrorlab.audio?.played };
  });
  expect(audio.active).toBe(true);
  expect(audio.played).toBeGreaterThan(10);
  await expect(mirror).toHaveTitle(/Fake Pixel/);

  // Mouse click → INJECT_TOUCH_EVENT down+up (type 2, 32 bytes each), mapped to video coordinates.
  const before = controlBytes().length;
  const box = (await mirror.locator("#canvas").boundingBox())!;
  await mirror.mouse.click(box.x + box.width / 2, box.y + box.height / 4);
  await mirror.waitForTimeout(300);
  const touch = controlBytes().subarray(before);
  const downs = [];
  for (let i = 0; i + 32 <= touch.length; i++) if (touch[i] === 2 && touch[i + 1] === 0 && touch.readBigUInt64BE(i + 2) === 0xffffffffffffffffn) downs.push(i);
  expect(downs.length).toBeGreaterThan(0);
  const at = downs[0]!;
  expect(Math.abs(touch.readInt32BE(at + 10) - 184)).toBeLessThan(4);
  expect(Math.abs(touch.readInt32BE(at + 14) - 160)).toBeLessThan(4);
  expect(touch.readUInt16BE(at + 18)).toBe(368);
  expect(touch.readUInt16BE(at + 20)).toBe(640);

  // Typing → INJECT_TEXT
  const beforeText = controlBytes().length;
  await mirror.keyboard.type("hi");
  await mirror.keyboard.press("Enter");
  await mirror.waitForTimeout(300);
  const typed = controlBytes().subarray(beforeText);
  expect(typed.includes(Buffer.from([1, 0, 0, 0, 1, 0x68]))).toBe(true); // "h"
  expect(typed.includes(Buffer.from([0, 0, 0, 0, 0, 66]))).toBe(true); // ENTER down

  // Inspector panel captures the UI tree; bounds scale from 736x1280 display to 368x640 video.
  await mirror.locator('[data-t="inspector"]').click();
  await mirror.locator("#cap").click();
  await expect(mirror.locator(".tree")).toContainText("Buy milk");
  await mirror.locator(".tree div", { hasText: "fab_add" }).click();
  await expect(mirror.locator(".props")).toContainText("280, 560, 352, 632");
  await mirror.screenshot({ path: path.join(shots, "mirror-inspector.png") });

  // --- the agent, through a real MCP client over HTTP
  const client = new Client({ name: "e2e", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  expect(tools).toEqual(["launch_app", "list_devices", "list_packages", "logcat", "press_key", "screenshot", "swipe", "tap", "tap_element", "timeline", "type_text", "ui_tree"]);

  const shot = await client.callTool({ name: "screenshot", arguments: {} });
  const content = shot.content as { type: string; data?: string; text?: string }[];
  expect(content[0]!.text).toContain("368x640");
  expect(content[1]!.type).toBe("image");
  const png = Buffer.from(content[1]!.data!, "base64");
  expect(png.subarray(1, 4).toString()).toBe("PNG");
  expect(png.readUInt32BE(16)).toBe(368);

  const tree = await client.callTool({ name: "ui_tree", arguments: {} });
  const treeText = (tree.content as { text: string }[])[0]!.text;
  expect(treeText).toContain("foreground: com.example.notes/.MainActivity");
  expect(treeText).toMatch(/"Buy milk" id=note_text \[16,80,352,130\] clickable/);

  const beforeAgent = controlBytes().length;
  const tapped = await client.callTool({ name: "tap_element", arguments: { content_desc: "Add note", screenshot: false } });
  expect((tapped.content as { text: string }[])[0]!.text).toContain('Tapped "Add note"');
  await mirror.waitForTimeout(200);
  const agentBytes = controlBytes().subarray(beforeAgent);
  // Generic-finger pointer (-2) at the FAB center (316, 596).
  const fi = agentBytes.indexOf(Buffer.from([2, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe]));
  expect(fi).toBeGreaterThanOrEqual(0);
  expect(agentBytes.readInt32BE(fi + 10)).toBe(316);
  expect(agentBytes.readInt32BE(fi + 14)).toBe(596);

  const logs = await client.callTool({ name: "logcat", arguments: { package: "com.example.notes" } });
  const logText = (logs.content as { text: string }[])[0]!.text;
  expect(logText).toContain("OkHttp: --> POST https://api.example.com/v1/notes");
  expect(logText).not.toContain("SystemServer");

  await client.callTool({ name: "timeline", arguments: { note: "FAB opens the editor" } });
  await client.close();

  // Bad token is rejected; foreign Host header is rejected.
  const r401 = await fetch(`http://127.0.0.1:${PORT}/mcp`, { method: "POST", body: "{}" });
  expect(r401.status).toBe(401);

  // Timeline shows user and agent events.
  await mirror.locator('[data-t="timeline"]').click();
  await expect(mirror.locator("#events")).toContainText("FAB opens the editor");
  await expect(mirror.locator(".event.user").first()).toBeVisible();
  await expect(mirror.locator(".event.agent").first()).toBeVisible();
  await mirror.screenshot({ path: path.join(shots, "mirror-timeline.png") });

  // Clipboard from the "phone" reached the PC (before the screenshot replaces it with an image).
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe("copied on phone");

  // Screenshot button saves a PNG and copies it; record button produces a non-empty video file.
  await mirror.locator('[data-t="shot"]').click();
  await expect(mirror.locator("#toast")).toContainText("Saved and copied");
  expect(await app.evaluate(async ({ clipboard }) => (await clipboard.read())[0]?.types ?? [])).toContain("image/png");
  await mirror.locator('[data-t="rec"]').click();
  await expect(mirror.locator('[data-t="rec"]')).toHaveClass(/rec/);
  await mirror.waitForTimeout(2500);
  await mirror.locator('[data-t="rec"]').click();
  await expect(mirror.locator("#toast")).toContainText("Recording saved", { timeout: 10_000 });
  const recFile = await app.evaluate(({ app }) => app.getPath("videos"));
  const vids = fs.readdirSync(path.join(recFile, "Mirrorlab")).map((f) => fs.statSync(path.join(recFile, "Mirrorlab", f)).size);
  expect(Math.max(...vids)).toBeGreaterThan(20_000);

});
