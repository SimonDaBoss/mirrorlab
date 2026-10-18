import type { StreamEvent } from "../protocol";
import { MirrorDecryptor } from "../../main/airplay/crypto";

export const MIRROR_HEADER_SIZE = 128;

/** Payload types on the AirPlay mirroring data connection (UxPlay raop_rtp_mirror.c). */
export const MirrorPayload = { VIDEO: 0x00, CONFIG: 0x01, HEARTBEAT: 0x02 } as const;

const START_CODE = Uint8Array.of(0, 0, 0, 1);

/** Convert AVCC (4-byte big-endian length prefixes) to Annex-B (00 00 00 01 start codes) in place-ish. */
export function avccToAnnexB(data: Uint8Array): { out: Uint8Array; hasIdr: boolean; ok: boolean } {
  const out = new Uint8Array(data.length);
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let i = 0;
  let hasIdr = false;
  while (i + 4 <= data.length) {
    const nalLen = v.getUint32(i);
    if (nalLen < 1 || i + 4 + nalLen > data.length) return { out, hasIdr, ok: false };
    out.set(START_CODE, i);
    out.set(data.subarray(i + 4, i + 4 + nalLen), i + 4);
    const nalType = data[i + 4]! & 0x1f;
    if (nalType === 5) hasIdr = true;
    i += 4 + nalLen;
  }
  return { out, hasIdr, ok: i === data.length };
}

export interface MirrorConfig {
  width: number;
  height: number;
}

/**
 * Parses one AirPlay mirroring data connection. Video payloads are decrypted
 * with the session key (supplied once SETUP has run); config payloads carry
 * unencrypted SPS/PPS and the source dimensions. Emits the same StreamEvent
 * shape as the scrcpy demuxer, so the renderer's WebCodecs pipeline is reused.
 */
export class MirrorStreamParser {
  private buf: Buffer = Buffer.alloc(0);
  private decryptor?: MirrorDecryptor;
  private config?: Uint8Array;
  private size?: MirrorConfig;

  /** Provide the per-session key material once SETUP is complete. */
  setKey(streamConnectionId: string, audioKey: Buffer): void {
    this.decryptor = new MirrorDecryptor(streamConnectionId, audioKey);
  }

  push(chunk: Buffer): StreamEvent[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: StreamEvent[] = [];
    for (;;) {
      if (this.buf.length < MIRROR_HEADER_SIZE) break;
      const payloadSize = this.buf.readUInt32LE(0);
      const type = this.buf.readUInt16LE(4);
      if (this.buf.length < MIRROR_HEADER_SIZE + payloadSize) break;
      const header = this.buf.subarray(0, MIRROR_HEADER_SIZE);
      const payload = this.buf.subarray(MIRROR_HEADER_SIZE, MIRROR_HEADER_SIZE + payloadSize);
      this.handle(type, header, payload, out);
      this.buf = this.buf.subarray(MIRROR_HEADER_SIZE + payloadSize);
    }
    return out;
  }

  private handle(type: number, header: Buffer, payload: Buffer, out: StreamEvent[]): void {
    if (type === MirrorPayload.CONFIG) {
      // Dimensions are float32 (integral values) at fixed offsets; SPS/PPS payload is unencrypted AVCC.
      const width = Math.round(header.readFloatLE(56)) || Math.round(header.readFloatLE(16));
      const height = Math.round(header.readFloatLE(60)) || Math.round(header.readFloatLE(20));
      if (width && height) {
        this.size = { width, height };
        out.push({ kind: "session", width, height, clientResized: false });
      }
      if (payload.length) {
        const { out: annexb, ok } = avccToAnnexB(new Uint8Array(payload));
        if (ok) {
          this.config = annexb;
          out.push({ kind: "packet", config: true, keyFrame: false, pts: null, data: annexb });
        }
      }
      return;
    }
    if (type === MirrorPayload.VIDEO) {
      if (!this.decryptor) return; // key not established yet
      const plain = this.decryptor.decrypt(payload);
      const { out: annexb, hasIdr, ok } = avccToAnnexB(new Uint8Array(plain));
      if (!ok) return; // failed decryption or truncated
      out.push({ kind: "packet", config: false, keyFrame: hasIdr, pts: 0n, data: annexb });
    }
    // HEARTBEAT and unknown types carry no frame.
  }

  get dimensions(): MirrorConfig | undefined {
    return this.size;
  }
  get hasConfig(): boolean {
    return !!this.config;
  }
}

/** Build one mirroring packet (used by the fake-iPhone test). */
export function encodeMirrorPacket(type: number, payload: Uint8Array, opts: { width?: number; height?: number; ntp?: bigint } = {}): Buffer {
  const header = Buffer.alloc(MIRROR_HEADER_SIZE);
  header.writeUInt32LE(payload.length, 0);
  header.writeUInt16LE(type, 4);
  if (opts.ntp !== undefined) header.writeBigUInt64LE(opts.ntp, 8);
  if (type === MirrorPayload.CONFIG) {
    for (const off of [16, 40, 56]) header.writeFloatLE(opts.width ?? 0, off);
    for (const off of [20, 44, 60]) header.writeFloatLE(opts.height ?? 0, off);
  }
  return Buffer.concat([header, Buffer.from(payload)]);
}

/** AVCC-encode NAL units (prepend 4-byte big-endian length), for tests and config assembly. */
export function annexBToAvcc(nals: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const n of nals) total += 4 + n.length;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  let i = 0;
  for (const n of nals) {
    v.setUint32(i, n.length);
    out.set(n, i + 4);
    i += 4 + n.length;
  }
  return out;
}
