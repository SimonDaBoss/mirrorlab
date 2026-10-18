import { controlsFor } from "./controls";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { NativePhone } from "../helpers/native-phone";

const root = path.resolve(__dirname, "../..");
const port = 47441;
let app: ElectronApplication;
let state: string;

test.skip(process.platform !== "win32", "The bundled native runtime is currently Windows x64.");
test.beforeAll(async () => {
  state = fs.mkdtempSync(path.join(os.tmpdir(), "mirrorlab-real-ios-e2e-"));
  fs.writeFileSync(path.join(state, "settings.json"), JSON.stringify({ iosEnabled: true, iosPort: port, iosName: "Mirrorlab-Native-E2E", agentEnabled: false }));
  app = await electron.launch({ executablePath: process.env.MIRRORLAB_E2E_EXECUTABLE, args: [root, "--no-sandbox"], env: { ...process.env, MIRRORLAB_USER_DATA: state, MIRRORLAB_TEST: "1", MIRRORLAB_AIRPLAY_ENGINE: "native", MIRRORLAB_ADB: path.join(root, "test/fake-adb.mjs") } });
});
test.afterAll(async () => { await app?.close(); });

test("native iPhone pairing, encrypted video and AAC-ELD audio reach the mirror, capture, record and reconnect", async () => {
  const launcher = await app.firstWindow();
  await expect(launcher.locator("#iosBadge")).toHaveText("ready");
  let phone = new NativePhone();
  try {
    await phone.connect(port);
    await phone.start();
    const nextWindow = app.waitForEvent("window");
    const streaming = phone.stream();
    const mirror = await nextWindow;
    await mirror.waitForFunction(() => (window as any).__mirrorlab?.connected === true);
    const controls = await controlsFor(mirror);
    await phone.streamAudio();
    await streaming;
    await mirror.waitForFunction(() => (window as any).__mirrorlab.video.stats.decoded > 10 && (window as any).__mirrorlab.audio?.played > 10);
    await expect(controls.locator('[data-t="back"]')).toHaveCount(0);
    await expect(controls.locator('[data-t="mute"]')).toBeVisible();
    await controls.locator('[data-t="shot"]').click();
    await expect(controls.locator("#toast")).toContainText("Saved and copied");
    await controls.locator('[data-t="rec"]').click();
    await expect(controls.locator('[data-t="rec"]')).toHaveClass(/rec/);
    // Exercise real encrypted transport + native decryption + WebCodecs at 60 fps.
    const before = await mirror.evaluate(() => ({ ...(window as any).__mirrorlab.video.stats }));
    await phone.stream(240, 60);
    await mirror.waitForFunction((decoded) => (window as any).__mirrorlab.video.stats.decoded >= decoded + 240, before.decoded);
    const paced = await mirror.evaluate(() => ({ ...(window as any).__mirrorlab.video.stats }));
    expect(paced.fps).toBeGreaterThanOrEqual(55);
    // A UI stall must recover without dropping compressed reference frames.
    const recovery = phone.stream(120, 60);
    await mirror.evaluate(() => { const until = performance.now() + 200; while (performance.now() < until) {} });
    await recovery;
    await mirror.waitForFunction((decoded) => (window as any).__mirrorlab.video.stats.decoded >= decoded + 120, paced.decoded);
    const recovered = await mirror.evaluate(() => ({ ...(window as any).__mirrorlab.video.stats }));
    expect(recovered.fps).toBeGreaterThanOrEqual(55);
    fs.mkdirSync(path.join(root, "test/screenshots"), { recursive: true });
    fs.writeFileSync(path.join(root, "test/screenshots/native-60fps.json"), JSON.stringify({ paced, recovered }, null, 2));
    await controls.locator('[data-t="rec"]').click();
    await expect(controls.locator("#toast")).toContainText("Recording saved", { timeout: 10000 });
    const recording = (await controls.locator("#toast").innerText()).replace("Recording saved: ", "");
    const videoDir = await app.evaluate(({ app }) => app.getPath("videos"));
    expect(fs.statSync(path.join(videoDir, "Mirrorlab", recording)).size).toBeGreaterThan(5000);
    await mirror.screenshot({ path: path.join(root, "test/screenshots/native-ios-mirror.png") });
    phone.close();
    await expect(mirror.locator("#status")).toContainText("Disconnected");
    phone = new NativePhone();
    await phone.connect(port);
    await phone.start();
    await phone.stream();
    await mirror.waitForFunction(() => (window as any).__mirrorlab.connected === true);
    await expect(mirror.locator("#status")).toBeHidden();
    expect(app.context().pages()).toHaveLength(3);
    phone.close();
    await expect(mirror.locator("#status")).toContainText("Disconnected");
    await mirror.close();
    await expect.poll(() => app.windows().length).toBe(1);
    // Closing the mirror must leave a fresh native receiver available.
    await expect.poll(async () => {
      const probe = new NativePhone();
      try { await probe.connect(port); return true; } catch { return false; } finally { probe.close(); }
    }, { timeout: 10000 }).toBe(true);
    await launcher.locator("#iosOn").uncheck();
    await expect(launcher.locator("#iosBadge")).toHaveText("off");
    await launcher.locator("#iosOn").check();
    await expect(launcher.locator("#iosBadge")).toHaveText("ready");
  } finally { phone.close(); }
});
