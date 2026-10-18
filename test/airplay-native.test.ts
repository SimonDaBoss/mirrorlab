import { beforeAll, afterAll, describe, it, expect } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NativeAirplayReceiver } from "../src/main/airplay/native";
import { parseBplist } from "../src/shared/airplay/bplist";
import { RtspClient } from "./helpers/rtsp-client";
import { NativePhone } from "./helpers/native-phone";

describe.skipIf(process.platform !== "win32")("bundled native AirPlay receiver", () => {
  let receiver: NativeAirplayReceiver;
  let state: string;
  beforeAll(async () => {
    state = fs.mkdtempSync(path.join(os.tmpdir(), "mirrorlab-native-"));
    receiver = new NativeAirplayReceiver({ name: "Mirrorlab-Native-Test", port: 47431, resourcesDir: path.resolve("resources"), stateDir: state, audio: true, maxFps: 60 });
    await receiver.start();
  }, 25000);
  afterAll(() => receiver?.close());

  it("serves real /info, completes authenticated X25519/Ed25519 pairing, and responds to FairPlay", async () => {
    const client = new RtspClient();
    await client.connect(receiver.port);
    try {
      const info = await client.request("GET", "/info");
      expect(info.status).toBe(200);
      expect(parseBplist(info.body)).toMatchObject({ name: "Mirrorlab-Native-Test" });
      const ed = crypto.generateKeyPairSync("ed25519");
      const x = crypto.generateKeyPairSync("x25519");
      const raw = (key: crypto.KeyObject) => key.export({ type: "spki", format: "der" }).subarray(-32);
      const setup = await client.request("POST", "/pair-setup", raw(ed.publicKey));
      expect(setup.body.length).toBe(32);
      const verify = await client.request("POST", "/pair-verify", Buffer.concat([Buffer.from([1, 0, 0, 0]), raw(x.publicKey), raw(ed.publicKey)]));
      expect(verify.body.length).toBe(96);
      const serverX = verify.body.subarray(0, 32);
      const secret = crypto.diffieHellman({ privateKey: x.privateKey, publicKey: crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), serverX]), type: "spki", format: "der" }) });
      const derive = (label: string) => crypto.createHash("sha512").update(label).update(secret).digest().subarray(0, 16);
      const key = derive("Pair-Verify-AES-Key"), iv = derive("Pair-Verify-AES-IV");
      const decipher = crypto.createDecipheriv("aes-128-ctr", key, iv);
      const serverSig = decipher.update(verify.body.subarray(32));
      const serverEd = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), setup.body]), type: "spki", format: "der" });
      expect(crypto.verify(null, Buffer.concat([serverX, raw(x.publicKey)]), serverEd, serverSig)).toBe(true);
      const cipher = crypto.createCipheriv("aes-128-ctr", key, iv);
      cipher.update(Buffer.alloc(64));
      const signature = crypto.sign(null, Buffer.concat([raw(x.publicKey), serverX]), ed.privateKey);
      const finish = await client.request("POST", "/pair-verify", Buffer.concat([Buffer.alloc(4), cipher.update(signature)]));
      expect(finish.status).toBe(200);
      const challenge = Buffer.alloc(16); challenge.write("FPLY"); challenge[4] = 3;
      const fp1 = await client.request("POST", "/fp-setup", challenge);
      expect(fp1.body.length).toBe(142);
      expect(fp1.body.subarray(0, 4).toString()).toBe("FPLY");
      const handshake = Buffer.alloc(164, 0x42); handshake.write("FPLY"); handshake[4] = 3;
      handshake[12] = 0;
      const fp2 = await client.request("POST", "/fp-setup", handshake);
      expect(fp2.body.length).toBe(32);
      expect(fp2.body.subarray(12).equals(handshake.subarray(144))).toBe(true);
    } finally { client.close(); }
  });

  it("unwraps a FairPlay session key and forwards encrypted H.264 over reliable TCP, plus decoded audio", async () => {
    const phone = new NativePhone();
    const video: any[] = [];
    const audio: any[] = [];
    const log: string[] = [];
    receiver.on("video", (e) => video.push(e));
    receiver.on("audio", (e) => audio.push(e));
    receiver.on("log", (s) => log.push(s));
    try {
      await phone.connect(receiver.port);
      await phone.start();
      await Promise.all([phone.stream(), (async () => { await new Promise((r) => setTimeout(r, 200)); await phone.streamAudio(); })()]);
      await expect.poll(() => video.filter((e) => e.kind === "packet" && !e.config).length, { timeout: 5000, message: log.join("") }).toBeGreaterThan(10);
      expect(video.find((e) => e.kind === "session")).toMatchObject({ width: 368, height: 640 });
      await expect.poll(() => audio.length, { timeout: 5000, message: log.join("") }).toBeGreaterThan(10);
      expect(audio.some((e) => e.data.some((v: number) => Math.abs(v) > 0.01))).toBe(true);
    } finally { phone.close(); }
  }, 20000);
});
