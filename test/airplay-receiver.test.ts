import crypto from "node:crypto";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AirplayReceiver } from "../src/main/airplay/receiver";
import { MirrorDecryptor, TestKeyProvider } from "../src/main/airplay/crypto";
import { annexBToAvcc, encodeMirrorPacket, MirrorPayload } from "../src/shared/airplay/mirror";
import { buildBplist, parseBplist, isBinaryPlist, type PlistValue } from "../src/shared/airplay/bplist";
import { buildResponse, RtspParser } from "../src/main/airplay/rtsp";
import type { StreamEvent } from "../src/shared/protocol";

/** A synthetic iPhone: drives the RTSP handshake and streams encrypted H.264. */
class FakeIPhone {
  private sock!: net.Socket;
  private parser = new RtspParser();
  private pending: ((r: { headers: Record<string, string>; body: Buffer }) => void)[] = [];
  private cseq = 0;

  async connect(port: number): Promise<void> {
    this.sock = net.connect(port, "127.0.0.1");
    await new Promise<void>((r, j) => {
      this.sock.once("connect", r);
      this.sock.once("error", j);
    });
    let buf = Buffer.alloc(0);
    this.sock.on("data", (c) => {
      buf = Buffer.concat([buf, c]);
      // Responses are RTSP too; reuse the parser shape by splitting on header end.
      for (;;) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) break;
        const head = buf.subarray(0, end).toString("latin1").split("\r\n");
        const headers: Record<string, string> = {};
        for (const line of head.slice(1)) {
          const i = line.indexOf(":");
          if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
        }
        const len = Number(headers["content-length"] ?? 0);
        if (buf.length < end + 4 + len) return;
        const body = buf.subarray(end + 4, end + 4 + len);
        buf = buf.subarray(end + 4 + len);
        this.pending.shift()?.({ headers, body });
      }
    });
  }

  request(method: string, url: string, body?: Buffer): Promise<{ headers: Record<string, string>; body: Buffer }> {
    const cseq = String(this.cseq++);
    const lines = [`${method} ${url} RTSP/1.0`, `CSeq: ${cseq}`];
    if (body) {
      lines.push("Content-Type: application/x-apple-binary-plist", `Content-Length: ${body.length}`);
    }
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

describe("AirplayReceiver end to end (fake iPhone)", () => {
  let receiver: AirplayReceiver | undefined;
  afterEach(() => receiver?.close());

  it("closes connected clients and releases the listening port", async () => {
    receiver = new AirplayReceiver({ name: "Cleanup", port: 0, advertise: false, keyProvider: new TestKeyProvider(Buffer.alloc(16)) });
    const port = await receiver.start();
    const sock = net.connect(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { sock.once("connect", resolve); sock.once("error", reject); });
    const closed = new Promise<void>((resolve) => sock.once("close", () => resolve()));
    receiver.close();
    await closed;
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, resolve); });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("rejects malformed plist requests without losing the receiver", async () => {
    receiver = new AirplayReceiver({ name: "Recovery", port: 0, advertise: false, keyProvider: new TestKeyProvider(Buffer.alloc(16)) });
    const phone = new FakeIPhone();
    await phone.connect(await receiver.start());
    try {
      await phone.request("SETUP", "rtsp://x/stream", Buffer.from("bplist00broken"));
      const info = await phone.request("GET", "/info");
      expect((parseBplist(info.body) as { name: string }).name).toBe("Recovery");
    } finally {
      phone.close();
    }
  });

  it("handshakes over RTSP and decodes an encrypted H.264 mirror stream", async () => {
    const audioKey = crypto.randomBytes(16);
    receiver = new AirplayReceiver({ name: "Mirrorlab-Test", port: 0, advertise: false, keyProvider: new TestKeyProvider(audioKey) });
    const video: StreamEvent[] = [];
    let deviceName = "";
    let dims: { width: number; height: number } | undefined;
    receiver.on("video", (e) => video.push(e));
    receiver.on("name", (n) => (deviceName = n));
    receiver.on("device", (d) => {
      if (d.width) dims = { width: d.width, height: d.height };
    });
    const port = await receiver.start();

    const phone = new FakeIPhone();
    await phone.connect(port);

    // GET /info → a bplist with our name.
    const info = await phone.request("GET", "/info");
    expect(isBinaryPlist(info.body)).toBe(true);
    expect((parseBplist(info.body) as { name: string }).name).toBe("Mirrorlab-Test");

    // SETUP #1: deliver the (fake-wrapped) session key + name, negotiate ports.
    const setup1 = buildBplist({ name: "Simon's iPhone", ekey: new Uint8Array(audioKey), eiv: new Uint8Array(16), timingPort: 0 });
    await phone.request("SETUP", "rtsp://x/stream", setup1);
    expect(deviceName).toBe("Simon's iPhone");

    // SETUP #2: request the mirroring stream (type 110) and get the data port back.
    const sid = 424242n;
    const setup2 = buildBplist({ streams: [{ type: 110, streamConnectionID: sid }] });
    const res2 = await phone.request("SETUP", "rtsp://x/stream", setup2);
    const streams = (parseBplist(res2.body) as { streams: Record<string, PlistValue>[] }).streams;
    const dataPort = Number(streams[0]!["dataPort"]);
    expect(dataPort).toBeGreaterThan(0);

    // Open the mirror data connection and stream: config (SPS/PPS) then an encrypted IDR frame.
    const data = net.connect(dataPort, "127.0.0.1");
    await new Promise<void>((r) => data.once("connect", () => r()));

    const sps = Uint8Array.of(0x67, 0x42, 0xc0, 0x1f, 0x8c, 0x8d, 0x40);
    const pps = Uint8Array.of(0x68, 0xce, 0x3c, 0x80);
    data.write(encodeMirrorPacket(MirrorPayload.CONFIG, annexBToAvcc([sps, pps]), { width: 1170, height: 2532 }));

    const enc = new MirrorDecryptor(sid.toString(), audioKey);
    for (let i = 0; i < 5; i++) {
      const nal = Uint8Array.of(i === 0 ? 0x65 : 0x61, ...crypto.randomBytes(300));
      const frame = Buffer.from(annexBToAvcc([nal]));
      data.write(encodeMirrorPacket(MirrorPayload.VIDEO, enc.decrypt(frame)));
    }

    await new Promise((r) => setTimeout(r, 300));

    expect(dims).toEqual({ width: 1170, height: 2532 });
    const kinds = video.map((e) => e.kind);
    expect(kinds[0]).toBe("session");
    expect(kinds).toContain("packet");
    const frames = video.filter((e) => e.kind === "packet" && !e.config);
    expect(frames.length).toBe(5);
    expect((frames[0] as { keyFrame: boolean }).keyFrame).toBe(true); // IDR
    // Decrypted frame is valid Annex-B.
    const f0 = (frames[0] as { data: Uint8Array }).data;
    expect(Buffer.from(f0.subarray(0, 5)).toString("hex")).toBe("0000000165");

    data.destroy();
    phone.close();
  }, 15000);
});

describe("RTSP framing", () => {
  it("parses pipelined requests and builds responses", () => {
    const p = new RtspParser();
    const raw = Buffer.from("GET /info RTSP/1.0\r\nCSeq: 3\r\n\r\nSETUP rtsp://x RTSP/1.0\r\nCSeq: 4\r\nContent-Length: 2\r\n\r\nhi", "latin1");
    const reqs = p.push(raw);
    expect(reqs).toHaveLength(2);
    expect(reqs[0]).toMatchObject({ method: "GET", url: "/info" });
    expect(reqs[1]!.body.toString()).toBe("hi");
    const res = buildResponse({ status: 200, cseq: "3", body: Buffer.from("x") });
    expect(res.toString("latin1")).toContain("RTSP/1.0 200 OK\r\nCSeq: 3");
  });
});
