import { it, expect } from "vitest";
import { execFile } from "node:child_process";
import path from "node:path";
import { NativeMediaServer } from "../src/main/airplay/media-bridge";

it.skipIf(process.platform !== "win32")("replays captured QuickTime negotiation, H.264 and stereo PCM through the actual USB host", async () => {
  const server = new NativeMediaServer();
  const video: any[] = [], audio: any[] = [];
  server.on("video", (e) => video.push(e)); server.on("audio", (e) => audio.push(e));
  const port = await server.start();
  try {
    const out = await new Promise<string>((resolve,reject) => execFile(path.resolve("resources/usb/win32/iphone-usb.exe"), ["--replay", path.resolve("test/fixtures/usb")], { windowsHide:true,timeout:10000,env:{...process.env,MIRRORLAB_MEDIA_PORT:String(port)} }, (e,out,err) => e ? reject(new Error(err || e.message)) : resolve(out)));
    expect(out).toContain("USB_REPLAY_OK");
    await expect.poll(() => video.filter((e) => e.kind === "packet" && !e.config).length).toBe(1);
    expect(video.find((e) => e.kind === "session")).toMatchObject({width:1126,height:2436});
    expect(video.some((e) => e.keyFrame)).toBe(true);
    expect(audio[0]).toMatchObject({kind:"pcm",sampleRate:48000,channels:2});
    expect(audio[0].data.length).toBe(2048);
  } finally {server.close();}
});
