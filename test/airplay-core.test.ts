import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { MirrorDecryptor, StreamCtr, deriveStreamKey } from "../src/main/airplay/crypto";
import { MirrorStreamParser, MirrorPayload, annexBToAvcc, avccToAnnexB, encodeMirrorPacket } from "../src/shared/airplay/mirror";

describe("AES-128-CTR keystream (OpenSSL-compatible)", () => {
  const key = Buffer.alloc(16, 7);
  const iv = Buffer.alloc(16, 0);

  it("matches node's own aes-128-ctr for a continuous stream", () => {
    // A plain continuous CTR (no startFreshBlock) must equal Node's implementation.
    const data = crypto.randomBytes(50);
    const mine = Buffer.alloc(data.length);
    new StreamCtr(key, iv).crypt(data, mine, data.length);
    const ref = Buffer.concat([crypto.createCipheriv("aes-128-ctr", key, iv).update(data)]);
    expect(mine.equals(ref)).toBe(true);
  });

  it("is symmetric (encrypt == decrypt)", () => {
    const data = crypto.randomBytes(37);
    const ct = Buffer.alloc(37);
    new StreamCtr(key, iv).crypt(data, ct, 37);
    const pt = Buffer.alloc(37);
    new StreamCtr(key, iv).crypt(ct, pt, 37);
    expect(pt.equals(data)).toBe(true);
  });
});

describe("mirror video decryption round-trip", () => {
  it("matches an independent OpenSSL CTR stream, including tiny packets", () => {
    const audioKey = Buffer.alloc(16, 0x35), sid = "424242";
    const key = deriveStreamKey("AirPlayStreamKey", sid, audioKey);
    const iv = deriveStreamKey("AirPlayStreamIV", sid, audioKey);
    const encryptor = crypto.createCipheriv("aes-128-ctr", key, iv);
    const decryptor = new MirrorDecryptor(sid, audioKey);
    for (const length of [1, 1, 2, 3, 5, 16, 17, 4096, 1, 9]) {
      const plain = crypto.randomBytes(length);
      expect(decryptor.decrypt(encryptor.update(plain))).toEqual(plain);
    }
  });
  it("decrypts what an identical encryptor produced, across packet boundaries", () => {
    const audioKey = crypto.randomBytes(16);
    const sid = "12345678901234567890";
    // Fixed-key derivation is deterministic.
    expect(deriveStreamKey("AirPlayStreamKey", sid, audioKey).length).toBe(16);

    const enc = new MirrorDecryptor(sid, audioKey); // CTR encrypt == decrypt
    const dec = new MirrorDecryptor(sid, audioKey);
    // Deliberately unaligned sizes so the cross-packet partial-block carry is exercised.
    for (const size of [10, 16, 23, 100, 7, 4096, 1]) {
      const plain = crypto.randomBytes(size);
      const cipher = enc.decrypt(plain);
      expect(cipher.equals(plain)).toBe(false);
      const back = dec.decrypt(cipher);
      expect(back.equals(plain)).toBe(true);
    }
  });
});

describe("AVCC <-> Annex-B", () => {
  it("round-trips and flags IDR frames", () => {
    const sps = Uint8Array.of(0x67, 0x42, 0xc0, 0x1f);
    const idr = Uint8Array.of(0x65, 1, 2, 3);
    const avcc = annexBToAvcc([sps, idr]);
    const { out, hasIdr, ok } = avccToAnnexB(avcc);
    expect(ok).toBe(true);
    expect(hasIdr).toBe(true);
    expect(Buffer.from(out.subarray(0, 4)).toString("hex")).toBe("00000001");
    expect(Buffer.from(out.subarray(8, 12)).toString("hex")).toBe("00000001");
  });
  it("rejects truncated AVCC", () => {
    expect(avccToAnnexB(Uint8Array.of(0, 0, 0, 99, 1, 2)).ok).toBe(false);
  });
});

describe("MirrorStreamParser", () => {
  it("emits session + config, then decrypts video frames", () => {
    const audioKey = crypto.randomBytes(16);
    const sid = "99";
    const parser = new MirrorStreamParser();
    parser.setKey(sid, audioKey);
    const enc = new MirrorDecryptor(sid, audioKey);

    const sps = Uint8Array.of(0x67, 0x42, 0xc0, 0x1f, 0x11);
    const pps = Uint8Array.of(0x68, 0xce, 0x3c, 0x80);
    const configPayload = annexBToAvcc([sps, pps]);
    const configPkt = encodeMirrorPacket(MirrorPayload.CONFIG, configPayload, { width: 1170, height: 2532 });

    const idrNal = Uint8Array.of(0x65, ...crypto.randomBytes(200));
    const frameAvcc = annexBToAvcc([idrNal]);
    const encryptedFrame = enc.decrypt(Buffer.from(frameAvcc));
    const videoPkt = encodeMirrorPacket(MirrorPayload.VIDEO, encryptedFrame);

    // Feed in two arbitrary chunks to prove reassembly.
    const all = Buffer.concat([configPkt, videoPkt]);
    const events = [...parser.push(all.subarray(0, 60)), ...parser.push(all.subarray(60))];

    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(["session", "packet", "packet"]);
    expect(events[0]).toMatchObject({ kind: "session", width: 1170, height: 2532 });
    expect(events[1]).toMatchObject({ kind: "packet", config: true });
    expect(events[2]).toMatchObject({ kind: "packet", config: false, keyFrame: true });
    // The decrypted frame is valid Annex-B starting with a start code + IDR nal.
    const frame = (events[2] as { data: Uint8Array }).data;
    expect(Buffer.from(frame.subarray(0, 5)).toString("hex")).toBe("0000000165");
    expect(parser.dimensions).toEqual({ width: 1170, height: 2532 });
  });
});

import { buildBplist, parseBplist, isBinaryPlist } from "../src/shared/airplay/bplist";
describe("binary plist", () => {
  it("round-trips the types AirPlay uses", () => {
    const v = { streams: [{ type: 110, streamConnectionID: 7654321n }], ok: true, name: "iPhone", ratio: 2.5, data: new Uint8Array([1, 2, 3]), nil: null, nested: { a: [1, 2, 3] } };
    const buf = buildBplist(v);
    expect(isBinaryPlist(buf)).toBe(true);
    const back = parseBplist(buf) as typeof v;
    expect(back.streams).toEqual([{ type: 110, streamConnectionID: 7654321n }]);
    expect(back.ok).toBe(true);
    expect(back.name).toBe("iPhone");
    expect(back.ratio).toBeCloseTo(2.5);
    expect(back.data).toEqual(new Uint8Array([1, 2, 3]));
    expect(back.nil).toBeNull();
    expect((back.nested as { a: number[] }).a).toEqual([1, 2, 3]);
  });
  it("parses a non-ASCII string", () => {
    const buf = buildBplist({ s: "café — 日本" });
    expect((parseBplist(buf) as { s: string }).s).toBe("café — 日本");
  });
});
