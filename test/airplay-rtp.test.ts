import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { H264RtpParser, h264Dimensions, l16Audio, parseRtp } from "../src/main/airplay/rtp";

const nals = fs.readFileSync(path.resolve("test/fixtures/stream.h264")).toString("latin1").split(/\x00\x00\x00?\x01/).filter(Boolean).map((n) => Buffer.from(n, "latin1"));
const sps = nals.find((n) => (n[0]! & 31) === 7)!;
const pps = nals.find((n) => (n[0]! & 31) === 8)!;
const rtp = (payload: Buffer, seq: number, marker = true, timestamp = 3000, type = 96) => {
  const header = Buffer.alloc(12); header[0] = 128; header[1] = type | (marker ? 128 : 0);
  header.writeUInt16BE(seq & 65535, 2); header.writeUInt32BE(timestamp >>> 0, 4); header.writeUInt32BE(1234, 8);
  return Buffer.concat([header, payload]);
};
const prime = (parser: H264RtpParser) => {
  parser.push(rtp(sps, 0, false));
  parser.push(rtp(pps, 1));
};
const packets = (events: ReturnType<H264RtpParser["push"]>) => events.filter((e) => e.kind === "packet" && !e.config);

describe("native RTP bridge", () => {
  it("reads cropped baseline and high-profile SPS dimensions", () => {
    expect(h264Dimensions(sps)).toEqual({ width: 368, height: 640 });
    // FFmpeg/libx264 High-profile SPS for 640x368.
    expect(h264Dimensions(Buffer.from("67640016acd940a02fb011000003000100000300020f162d96", "hex"))).toEqual({ width: 640, height: 368 });
    expect(() => h264Dimensions(Buffer.from([0x67, 0]))).toThrow();
  });
  it("reassembles FU-A NALs and restores SPS/PPS before an IDR", () => {
    const parser = new H264RtpParser(); prime(parser);
    expect(parser.push(rtp(Buffer.from([0x7c, 0x85, 1, 2]), 2, false))).toHaveLength(0);
    const events = parser.push(rtp(Buffer.from([0x7c, 0x45, 3, 4]), 3));
    expect(events[0]).toMatchObject({ kind: "packet", config: true });
    expect(packets(events)[0]).toMatchObject({ keyFrame: true, data: Buffer.from([0, 0, 0, 1, 0x65, 1, 2, 3, 4]) });
  });
  it("drops a damaged frame and delta frames until the next IDR", () => {
    const parser = new H264RtpParser(); prime(parser);
    parser.push(rtp(Buffer.from([0x7c, 0x85, 1]), 2, false));
    expect(packets(parser.push(rtp(Buffer.from([0x7c, 0x45, 3]), 4)))).toHaveLength(0);
    expect(packets(parser.push(rtp(Buffer.from([0x61, 1]), 5, true, 6000)))).toHaveLength(0);
    expect(packets(parser.push(rtp(Buffer.from([0x65, 1]), 6, true, 9000)))).toHaveLength(1);
  });
  it("handles STAP-A, sequence wrapping and 90 kHz timestamp wrapping", () => {
    const parser = new H264RtpParser();
    const stap = [sps, pps].map((n) => { const len = Buffer.alloc(2); len.writeUInt16BE(n.length); return Buffer.concat([len, n]); });
    parser.push(rtp(Buffer.concat([Buffer.from([0x78]), ...stap]), 65534, true, 0xfffffff0));
    expect(packets(parser.push(rtp(Buffer.from([0x65, 1]), 65535, true, 0xfffffff0)))[0]).toMatchObject({ pts: 0n });
    expect(packets(parser.push(rtp(Buffer.from([0x61, 1]), 0, true, 0x00000ba8)))[0]).toMatchObject({ pts: 33333n });
  });
  it("rejects malformed RTP, aggregates and incomplete fragments", () => {
    expect(parseRtp(Buffer.alloc(3))).toBeUndefined();
    const bad = rtp(Buffer.from([1]), 1); bad[0] = 0x90;
    expect(parseRtp(bad)).toBeUndefined();
    const parser = new H264RtpParser(); prime(parser);
    expect(packets(parser.push(rtp(Buffer.from([0x78, 0, 99, 1]), 2)))).toHaveLength(0);
    expect(packets(parser.push(rtp(Buffer.from([0x7c, 0x85, 1]), 3, true, 6000)))).toHaveLength(0);
  });
  it("decodes big-endian stereo L16 samples with exact amplitude", () => {
    const event = l16Audio(rtp(Buffer.from([0x80, 0, 0x7f, 0xff, 0, 0, 0x40, 0]), 1, true, 0, 97));
    expect(event).toMatchObject({ kind: "pcm", sampleRate: 44100, channels: 2 });
    expect([...event!.data]).toEqual([-1, 32767 / 32768, 0, 0.5]);
    expect(l16Audio(rtp(Buffer.alloc(3), 1, true, 0, 97))).toBeUndefined();
  });
});
