import { it, expect } from "vitest";
import fs from "node:fs";
import net from "node:net";
import { NativeMediaParser, NativeMediaServer, annexBNals } from "../src/main/airplay/media-bridge";

function media(payload: Buffer, kind = 1, arg = 0, pts = 0n) {
  const h = Buffer.alloc(24); h.write("MLB1"); h.writeUInt32LE(payload.length, 4);
  h.writeUInt32LE(kind, 8); h.writeUInt32LE(arg, 12); h.writeBigUInt64LE(pts, 16);
  return Buffer.concat([h, payload]);
}
const fixture = () => fs.readFileSync("test/fixtures/stream.h264");
const firstFrame = () => {
  const nals = annexBNals(fixture());
  return Buffer.concat(nals.filter((n) => [7, 8, 5].includes(n[0]! & 31)).map((n) => Buffer.concat([Buffer.from([0, 0, 0, 1]), n])));
};

it("assembles fragmented native H.264 and keeps every packet and 60 fps timestamp in a burst", () => {
  const p = new NativeMediaParser();
  const key = media(firstFrame(), 1, 1, 1234567n);
  const events: any[] = [];
  for (let i = 0; i < key.length; i += 17) events.push(...p.push(key.subarray(i, i + 17)).video);
  expect(events.find((e) => e.kind === "session")).toMatchObject({width:368,height:640});
  expect(events.find((e) => e.kind === "packet" && !e.config)).toMatchObject({keyFrame:true,rotation:1,pts:0n});
  const delta = Buffer.from([0,0,0,1,0x41,0x80,0x12]);
  const burst = Buffer.concat(Array.from({length:300}, (_, i) => media(delta, 1, 0, 1234567n + BigInt(i + 1) * 1000000n / 60n)));
  const packets = p.push(burst).video;
  expect(packets).toHaveLength(300);
  expect(packets[299]).toMatchObject({pts:5000000n,keyFrame:false});
});

it("decodes interleaved float PCM and rejects malformed framing and formats", () => {
  const b = Buffer.alloc(16); [0.25,-0.5,0.75,1].forEach((v,i) => b.writeFloatLE(v,i*4));
  const audio = new NativeMediaParser().push(media(b,2,(2<<24)|48000)).audio[0]!;
  expect(audio).toMatchObject({kind:"pcm",channels:2,sampleRate:48000});
  if (audio.kind !== "pcm") throw new Error("PCM event expected");
  expect(Array.from(audio.data)).toEqual([0.25,-0.5,0.75,1]);
  expect(() => new NativeMediaParser().push(media(b,2,(9<<24)|48000))).toThrow("PCM format");
  const invalid = media(b); invalid.writeUInt32LE(17*1024*1024,4);
  expect(() => new NativeMediaParser().push(invalid)).toThrow("media length");
});

it("discards an incomplete TCP frame when a native helper reconnects", async () => {
  const server = new NativeMediaServer();
  const frames: any[] = [];
  server.on("video", (e) => frames.push(e));
  const port = await server.start();
  const connect = () => new Promise<net.Socket>((resolve,reject) => { const s = net.connect(port,"127.0.0.1",() => resolve(s)); s.on("error",reject); });
  try {
    const first = await connect(); first.end(media(firstFrame()).subarray(0,30));
    await new Promise((r) => first.once("close",r));
    const second = await connect(); second.write(media(firstFrame()));
    await expect.poll(() => frames.filter((e) => e.kind === "packet" && !e.config).length).toBe(1);
    second.destroy();
  } finally { server.close(); }
});
