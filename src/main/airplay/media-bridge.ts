import { EventEmitter } from "node:events";
import net from "node:net";
import { h264Dimensions } from "./rtp";
import type { StreamEvent } from "../../shared/protocol";
import type { WireStreamEvent } from "../../shared/types";

export function annexBNals(data: Buffer): Buffer[] {
  const nals: Buffer[] = [];
  let start = -1;
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      const end = i > 0 && data[i - 1] === 0 ? i - 1 : i;
      if (start >= 0 && end > start) nals.push(data.subarray(start, end));
      start = i + 3; i += 2;
    }
  }
  if (start >= 0 && start < data.length) nals.push(data.subarray(start));
  return nals;
}

export class NativeMediaParser {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private header?: Buffer;
  private sps?: Buffer;
  private pps?: Buffer;
  private origin?: bigint;
  private configChanged = true;

  private take(size: number): Buffer {
    const first = this.chunks[0]!;
    if (first.length >= size) {
      const out = first.subarray(0, size);
      if (size === first.length) this.chunks.shift(); else this.chunks[0] = first.subarray(size);
      this.bytes -= size; return out;
    }
    const out = Buffer.allocUnsafe(size);
    for (let offset = 0; offset < size;) {
      const part = this.chunks[0]!, n = Math.min(part.length, size - offset);
      part.copy(out, offset, 0, n); offset += n;
      if (n === part.length) this.chunks.shift(); else this.chunks[0] = part.subarray(n);
    }
    this.bytes -= size; return out;
  }

  push(data: Buffer): { video: StreamEvent[]; audio: WireStreamEvent[] } {
    this.chunks.push(data); this.bytes += data.length;
    const video: StreamEvent[] = [], audio: WireStreamEvent[] = [];
    for (;;) {
      if (!this.header) {
        if (this.bytes < 24) break;
        this.header = this.take(24);
        if (this.header.toString("ascii", 0, 4) !== "MLB1") throw new Error("Invalid native media header");
        const size = this.header.readUInt32LE(4);
        if (!size || size > 16 * 1024 * 1024) throw new Error("Invalid native media length");
      }
      const size = this.header.readUInt32LE(4);
      if (this.bytes < size) break;
      const h = this.header; this.header = undefined;
      const payload = this.take(size), kind = h.readUInt32LE(8), arg = h.readUInt32LE(12);
      if (kind === 2) {
        const channels = arg >>> 24, sampleRate = arg & 0xffffff;
        if (!channels || channels > 8 || sampleRate < 8000 || sampleRate > 192000 || size % (4 * channels)) throw new Error("Invalid native PCM format");
        const samples = new Float32Array(size / 4);
        for (let i = 0; i < samples.length; i++) samples[i] = payload.readFloatLE(i * 4);
        audio.push({ kind: "pcm", sampleRate, channels, data: samples });
        continue;
      }
      if (kind !== 1) throw new Error("Unknown native media type");
      const nals = annexBNals(payload);
      for (const nal of nals) {
        if ((nal[0]! & 31) === 7 && !this.sps?.equals(nal)) {
          this.sps = Buffer.from(nal); this.configChanged = true;
          video.push({ kind: "session", ...h264Dimensions(nal), clientResized: false });
        } else if ((nal[0]! & 31) === 8 && !this.pps?.equals(nal)) { this.pps = Buffer.from(nal); this.configChanged = true; }
      }
      if (this.configChanged && this.sps && this.pps) {
        const start = Buffer.from([0, 0, 0, 1]);
        video.push({ kind: "packet", config: true, keyFrame: false, pts: null, data: Buffer.concat([start, this.sps, start, this.pps]) });
        this.configChanged = false;
      }
      if (nals.some((n) => [1, 5].includes(n[0]! & 31))) {
        const pts = h.readBigUInt64LE(16); this.origin ??= pts;
        video.push({ kind: "packet", config: false, keyFrame: nals.some((n) => (n[0]! & 31) === 5), pts: pts >= this.origin ? pts - this.origin : 0n, data: payload, rotation: arg & 3 });
      }
    }
    return { video, audio };
  }
  resetSession() { this.sps = this.pps = undefined; this.origin = undefined; this.configChanged = true; }
}

export class NativeMediaServer extends EventEmitter {
  private server?: net.Server;
  private socket?: net.Socket;
  private parser = new NativeMediaParser();
  async start(): Promise<number> {
    this.server = net.createServer((socket) => {
      if (this.socket && !this.socket.destroyed) { socket.destroy(); return; }
      this.socket = socket; socket.setNoDelay(true);
      this.parser = new NativeMediaParser();
      socket.setKeepAlive(true);
      socket.on("error", () => undefined);
      socket.on("data", (data) => {
        try {
          const events = this.parser.push(data);
          for (const ev of events.video) this.emit("video", ev);
          for (const ev of events.audio) this.emit("audio", ev);
        } catch (e) { this.emit("failure", e); socket.destroy(); }
      });
    });
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(0, "127.0.0.1", resolve); });
    return (this.server.address() as net.AddressInfo).port;
  }
  resetSession() { this.parser.resetSession(); }
  close() { this.socket?.destroy(); this.server?.close(); }
}
