import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Adb } from "../src/main/adb";
import { MirrorSession } from "../src/main/scrcpy/session";
import { MotionAction, POINTER_ID_MOUSE, encodeTouch, type StreamEvent } from "../src/shared/protocol";

const FAKE = path.join(__dirname, "fake-adb.mjs");

describe("MirrorSession against the fake device", () => {
  let state: string;
  let session: MirrorSession | undefined;
  afterEach(() => {
    session?.close();
    if (state) rmSync(state, { recursive: true, force: true });
  });

  it("handshakes, demuxes video, receives clipboard and sends control", async () => {
    state = mkdtempSync(path.join(os.tmpdir(), "fakeadb-"));
    process.env.FAKE_ADB_STATE = state;
    process.env.FAKE_ADB_AUDIO = "0";
    const adb = new Adb(FAKE);
    expect((await adb.devices())[0]).toMatchObject({ serial: "FAKE0001", state: "device", model: "Fake Pixel", kind: "usb" });

    session = new MirrorSession(adb, "FAKE0001", { serverJar: __filename, maxSize: 1024 });
    const video: StreamEvent[] = [];
    const audio: StreamEvent[] = [];
    const device: unknown[] = [];
    session.on("video", (e) => video.push(e));
    session.on("audio", (e) => audio.push(e));
    session.on("device", (m) => device.push(m));

    const info = await session.start();
    expect(info).toMatchObject({ deviceName: "Fake Pixel", video: true, audio: true, control: true });

    await new Promise((r) => setTimeout(r, 600));
    expect(video[0]).toEqual({ kind: "codec", codecId: 0x68323634 });
    expect(video[1]).toMatchObject({ kind: "session", width: 368, height: 640 });
    expect(video[2]).toMatchObject({ kind: "packet", config: true });
    const frames = video.filter((e) => e.kind === "packet" && !e.config);
    expect(frames.length).toBeGreaterThan(5);
    expect(frames[0]).toMatchObject({ keyFrame: true });
    expect(audio).toEqual([{ kind: "codec", codecId: 0 }]);
    expect(device).toEqual([{ type: "clipboard", text: "copied on phone" }]);
    expect(session.videoSize).toEqual({ width: 368, height: 640 });

    const tap = encodeTouch({
      action: MotionAction.DOWN,
      pointerId: POINTER_ID_MOUSE,
      position: { x: 10, y: 20, ...session.videoSize! },
      pressure: 1,
      actionButton: 1,
      buttons: 1,
    });
    expect(session.send(tap)).toBe(true);
    // TCP delivery and the fake device's file write can take longer on CI.
    await expect.poll(() => {
      const file = path.join(state, "control.bin");
      return existsSync(file) ? [...readFileSync(file)] : [];
    }, { timeout: 5000 }).toEqual([...tap]);

    const shellLog = readFileSync(path.join(state, "shell.log"), "utf8");
    expect(shellLog).toMatch(/CLASSPATH=\/data\/local\/tmp\/scrcpy-server.jar app_process \/ com.genymobile.scrcpy.Server 5.0.1 scid=[0-9a-f]{8}/);
    expect(existsSync(path.join(state, "pushed.log"))).toBe(true);
  }, 20_000);
});
