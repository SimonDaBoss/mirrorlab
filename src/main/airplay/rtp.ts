import type { StreamEvent } from "../../shared/protocol";

const START = Buffer.from([0, 0, 0, 1]);
const MAX_FRAME = 16 * 1024 * 1024;

/** RFC 3550 header, including CSRCs, extension and padding. */
export function parseRtp(packet: Buffer) {
  if (packet.length < 12 || packet[0]! >> 6 !== 2) return;
  let offset = 12 + (packet[0]! & 15) * 4;
  if (offset > packet.length) return;
  if (packet[0]! & 16) {
    if (offset + 4 > packet.length) return;
    offset += 4 + packet.readUInt16BE(offset + 2) * 4;
  }
  const end = packet.length - ((packet[0]! & 32) ? packet[packet.length - 1]! : 0);
  if (offset >= end || ((packet[0]! & 32) && !packet[packet.length - 1])) return;
  return { marker: !!(packet[1]! & 128), type: packet[1]! & 127, seq: packet.readUInt16BE(2), timestamp: packet.readUInt32BE(4), ssrc: packet.readUInt32BE(8), payload: packet.subarray(offset, end) };
}

/** Read H.264 SPS dimensions, removing emulation-prevention bytes (ITU H.264 7.4.2.1). */
export function h264Dimensions(sps: Buffer): { width: number; height: number } {
  const bytes: number[] = [];
  for (let i = 1; i < sps.length; i++) {
    if (i >= 3 && sps[i] === 3 && sps[i - 1] === 0 && sps[i - 2] === 0) continue;
    bytes.push(sps[i]!);
  }
  let position = 0;
  const bits = (n: number): number => {
    if (position + n > bytes.length * 8) throw new Error("Truncated H.264 SPS");
    let value = 0;
    for (let j = 0; j < n; j++, position++) value = value * 2 + ((bytes[position >> 3]! >> (7 - (position & 7))) & 1);
    return value;
  };
  const ue = (): number => {
    let zeros = 0;
    while (!bits(1)) if (++zeros > 24) throw new Error("Invalid SPS Exp-Golomb value");
    return 2 ** zeros - 1 + bits(zeros);
  };
  const se = () => { const n = ue(); return n & 1 ? (n + 1) / 2 : -n / 2; };
  const profile = bits(8);
  bits(16); ue();
  let chroma = 1;
  let separate = 0;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    chroma = ue();
    if (chroma > 3) throw new Error("Invalid SPS chroma format");
    if (chroma === 3) separate = bits(1);
    ue(); ue(); bits(1);
    if (bits(1)) {
      for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) {
        if (!bits(1)) continue;
        let last = 8, next = 8;
        for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
          if (next) next = (last + se() + 256) % 256;
          last = next || last;
        }
      }
    }
  }
  ue();
  const poc = ue();
  if (poc === 0) ue();
  else if (poc === 1) {
    bits(1); se(); se();
    const count = ue();
    if (count > 256) throw new Error("Invalid SPS POC cycle");
    for (let i = 0; i < count; i++) se();
  } else if (poc > 2) throw new Error("Invalid SPS POC type");
  ue(); bits(1);
  const mbWidth = ue() + 1, mapHeight = ue() + 1;
  const frameOnly = bits(1);
  if (!frameOnly) bits(1);
  bits(1);
  let left = 0, right = 0, top = 0, bottom = 0;
  if (bits(1)) { left = ue(); right = ue(); top = ue(); bottom = ue(); }
  const arrayType = separate ? 0 : chroma;
  const cropX = arrayType === 1 || arrayType === 2 ? 2 : 1;
  const cropY = (arrayType === 1 ? 2 : 1) * (2 - frameOnly);
  const width = mbWidth * 16 - (left + right) * cropX;
  const height = mapHeight * 16 * (2 - frameOnly) - (top + bottom) * cropY;
  if (width < 1 || height < 1 || width > 8192 || height > 8192) throw new Error("Unsupported H.264 dimensions");
  return { width, height };
}

/** RFC 6184 single NAL, STAP-A and FU-A → complete Annex-B access units. */
export class H264RtpParser {
  private ssrc?: number;
  private seq?: number;
  private timestamp?: number;
  private parts: Buffer[] = [];
  private fragment: Buffer[] = [];
  private size = 0;
  private damaged = false;
  private needKey = true;
  private sps?: Buffer;
  private pps?: Buffer;
  private origin?: number;
  private elapsed = 0;
  private previous?: number;

  push(raw: Buffer): StreamEvent[] {
    const p = parseRtp(raw);
    if (!p || p.type !== 96) return [];
    if (this.ssrc !== p.ssrc) { this.reset(); this.ssrc = p.ssrc; }
    if (this.timestamp !== p.timestamp) {
      if (this.parts.length || this.fragment.length) this.needKey = true;
      this.parts = []; this.fragment = []; this.size = 0; this.damaged = false;
      this.timestamp = p.timestamp;
    }
    if (this.seq !== undefined && p.seq !== ((this.seq + 1) & 65535)) {
      this.damaged = true; this.needKey = true; this.fragment = [];
    }
    this.seq = p.seq;
    const out: StreamEvent[] = [];
    const nal = (n: Buffer) => {
      if (!n.length) { this.damaged = true; return; }
      const type = n[0]! & 31;
      if (type === 7) {
        try {
          if (!this.sps?.equals(n)) {
            out.push({ kind: "session", ...h264Dimensions(n), clientResized: false });
            this.sps = Buffer.from(n); this.needKey = true;
          }
        } catch { this.damaged = true; return; }
      } else if (type === 8) this.pps = Buffer.from(n);
      this.parts.push(START, n);
    };
    const b = p.payload;
    this.size += b.length;
    if (this.size > MAX_FRAME) this.damaged = true;
    if (!this.damaged) {
      const type = b[0]! & 31;
      if (type > 0 && type < 24) nal(b);
      else if (type === 24) {
        let i = 1;
        while (i + 2 <= b.length) {
          const length = b.readUInt16BE(i); i += 2;
          if (!length || i + length > b.length) { this.damaged = true; break; }
          nal(b.subarray(i, i + length)); i += length;
        }
        if (i !== b.length) this.damaged = true;
      } else if (type === 28 && b.length > 2) {
        if (b[1]! & 128) this.fragment = [Buffer.from([(b[0]! & 224) | (b[1]! & 31)])];
        if (!this.fragment.length) this.damaged = true;
        else {
          this.fragment.push(b.subarray(2));
          if (b[1]! & 64) { nal(Buffer.concat(this.fragment)); this.fragment = []; }
        }
      } else this.damaged = true;
    }
    if (p.marker) {
      const keyFrame = this.parts.some((n, i) => i % 2 === 1 && (n[0]! & 31) === 5);
      if (!this.damaged && !this.fragment.length && this.sps && this.pps && (!this.needKey || keyFrame)) {
        if (keyFrame) out.push({ kind: "packet", config: true, keyFrame: false, pts: null, data: Buffer.concat([START, this.sps, START, this.pps]) });
        const hasVideo = this.parts.some((n, i) => i % 2 === 1 && [1, 5].includes(n[0]! & 31));
        if (hasVideo) {
          this.needKey = false;
          if (this.origin === undefined) this.origin = p.timestamp;
          if (this.previous !== undefined) this.elapsed += (p.timestamp - this.previous) >>> 0;
          this.previous = p.timestamp;
          out.push({ kind: "packet", config: false, keyFrame, pts: BigInt(Math.round(this.elapsed * 1_000_000 / 90000)), data: Buffer.concat(this.parts) });
        }
      }
      this.parts = []; this.fragment = []; this.size = 0;
    }
    return out;
  }

  reset() {
    this.ssrc = this.seq = this.timestamp = this.origin = this.previous = undefined;
    this.parts = []; this.fragment = []; this.size = 0; this.damaged = false;
    this.needKey = true; this.sps = this.pps = undefined; this.elapsed = 0;
  }
}

/** UxPlay sends decoded 44.1 kHz stereo signed big-endian PCM over RTP. */
export function l16Audio(packet: Buffer) {
  const p = parseRtp(packet);
  if (!p || p.type !== 97 || p.payload.length % 4) return;
  const data = new Float32Array(p.payload.length / 2);
  for (let i = 0; i < data.length; i++) data[i] = p.payload.readInt16BE(i * 2) / 32768;
  return { kind: "pcm" as const, sampleRate: 44100, channels: 2, data };
}
