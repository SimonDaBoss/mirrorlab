/**
 * scrcpy v5 wire protocol — pure encoders/decoders, shared by main and renderer.
 *
 * Byte layouts are transcribed from scrcpy app/src/control_msg.c,
 * app/src/device_msg.c and app/src/demuxer.c (Genymobile/scrcpy v5.0.1).
 * Everything is big-endian.
 */

export const SCRCPY_VERSION = "5.0.1";
export const DEVICE_SERVER_PATH = "/data/local/tmp/scrcpy-server.jar";
export const DEVICE_NAME_FIELD_LENGTH = 64;
export const PACKET_HEADER_SIZE = 12;

export const ControlType = {
  INJECT_KEYCODE: 0,
  INJECT_TEXT: 1,
  INJECT_TOUCH_EVENT: 2,
  INJECT_SCROLL_EVENT: 3,
  BACK_OR_SCREEN_ON: 4,
  EXPAND_NOTIFICATION_PANEL: 5,
  EXPAND_SETTINGS_PANEL: 6,
  COLLAPSE_PANELS: 7,
  GET_CLIPBOARD: 8,
  SET_CLIPBOARD: 9,
  SET_DISPLAY_POWER: 10,
  ROTATE_DEVICE: 11,
  UHID_CREATE: 12,
  UHID_INPUT: 13,
  UHID_DESTROY: 14,
  OPEN_HARD_KEYBOARD_SETTINGS: 15,
  START_APP: 16,
  RESET_VIDEO: 17,
  CAMERA_SET_TORCH: 18,
  CAMERA_ZOOM_IN: 19,
  CAMERA_ZOOM_OUT: 20,
  RESIZE_DISPLAY: 21,
  SCAN_FILE: 22,
} as const;

/** Android MotionEvent actions. */
export const MotionAction = { DOWN: 0, UP: 1, MOVE: 2, CANCEL: 3, POINTER_DOWN: 5, POINTER_UP: 6, HOVER_MOVE: 7 } as const;
/** Android MotionEvent buttons. */
export const MotionButton = { PRIMARY: 1, SECONDARY: 2, TERTIARY: 4, BACK: 8, FORWARD: 16 } as const;
/** Android KeyEvent actions. */
export const KeyAction = { DOWN: 0, UP: 1 } as const;

export const POINTER_ID_MOUSE = 0xffff_ffff_ffff_ffffn; // UINT64_C(-1)
export const POINTER_ID_GENERIC_FINGER = 0xffff_ffff_ffff_fffen; // UINT64_C(-2)

export const INJECT_TEXT_MAX_LENGTH = 300;
export const START_APP_NAME_MAX_LENGTH = 255;

export const CodecId = {
  H264: 0x68323634,
  H265: 0x68323635,
  AV1: 0x00617631,
  OPUS: 0x6f707573,
  AAC: 0x00616163,
  FLAC: 0x666c6163,
  RAW: 0x00726177,
  /** Stream explicitly disabled by the device (e.g. audio unsupported). */
  DISABLED: 0,
  /** Stream configuration error on the device. */
  ERROR: 1,
} as const;

export function codecName(id: number): string {
  for (const [k, v] of Object.entries(CodecId)) if (v === id) return k.toLowerCase();
  return `unknown(0x${id.toString(16)})`;
}

export interface Position {
  x: number;
  y: number;
  /** Must equal the current video frame size, or the device ignores the event. */
  width: number;
  height: number;
}

const enc = new TextEncoder();

/** Truncate UTF-8 bytes to maxLen without splitting a code point. */
export function utf8Truncate(bytes: Uint8Array, maxLen: number): Uint8Array {
  if (bytes.length <= maxLen) return bytes;
  let end = maxLen;
  // Step back over continuation bytes (10xxxxxx).
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end);
}

function writePosition(view: DataView, offset: number, p: Position): void {
  view.setInt32(offset, Math.round(p.x));
  view.setInt32(offset + 4, Math.round(p.y));
  view.setUint16(offset + 8, p.width);
  view.setUint16(offset + 10, p.height);
}

/** sc_float_to_u16fp: [0,1] → u16 fixed point. */
export function floatToU16fp(f: number): number {
  const clamped = Math.min(1, Math.max(0, f));
  const u = Math.floor(clamped * 65536);
  return u >= 0xffff ? 0xffff : u;
}

/** sc_float_to_i16fp: [-1,1] → i16 fixed point. */
export function floatToI16fp(f: number): number {
  const clamped = Math.min(1, Math.max(-1, f));
  const i = Math.trunc(clamped * 32768);
  return i >= 0x7fff ? 0x7fff : i;
}

export function encodeKeycode(action: number, keycode: number, repeat = 0, metastate = 0): Uint8Array {
  const buf = new Uint8Array(14);
  const v = new DataView(buf.buffer);
  buf[0] = ControlType.INJECT_KEYCODE;
  buf[1] = action;
  v.setInt32(2, keycode);
  v.setUint32(6, repeat);
  v.setInt32(10, metastate);
  return buf;
}

export function encodeText(text: string): Uint8Array {
  const payload = utf8Truncate(enc.encode(text), INJECT_TEXT_MAX_LENGTH);
  const buf = new Uint8Array(5 + payload.length);
  buf[0] = ControlType.INJECT_TEXT;
  new DataView(buf.buffer).setUint32(1, payload.length);
  buf.set(payload, 5);
  return buf;
}

export interface TouchEvent {
  action: number;
  pointerId: bigint;
  position: Position;
  pressure: number;
  actionButton: number;
  buttons: number;
}

export function encodeTouch(e: TouchEvent): Uint8Array {
  const buf = new Uint8Array(32);
  const v = new DataView(buf.buffer);
  buf[0] = ControlType.INJECT_TOUCH_EVENT;
  buf[1] = e.action;
  v.setBigUint64(2, e.pointerId);
  writePosition(v, 10, e.position);
  v.setUint16(22, floatToU16fp(e.pressure));
  v.setInt32(24, e.actionButton);
  v.setInt32(28, e.buttons);
  return buf;
}

/** hscroll/vscroll accepted in [-16, 16], like scrcpy. */
export function encodeScroll(position: Position, hscroll: number, vscroll: number, buttons = 0): Uint8Array {
  const buf = new Uint8Array(21);
  const v = new DataView(buf.buffer);
  buf[0] = ControlType.INJECT_SCROLL_EVENT;
  writePosition(v, 1, position);
  v.setInt16(13, floatToI16fp(hscroll / 16));
  v.setInt16(15, floatToI16fp(vscroll / 16));
  v.setInt32(17, buttons);
  return buf;
}

export function encodeBackOrScreenOn(action: number): Uint8Array {
  return Uint8Array.of(ControlType.BACK_OR_SCREEN_ON, action);
}

/** copyKey: 0 none, 1 copy, 2 cut. */
export function encodeGetClipboard(copyKey = 0): Uint8Array {
  return Uint8Array.of(ControlType.GET_CLIPBOARD, copyKey);
}

export function encodeSetClipboard(sequence: bigint, text: string, paste: boolean): Uint8Array {
  const payload = enc.encode(text);
  const buf = new Uint8Array(14 + payload.length);
  const v = new DataView(buf.buffer);
  buf[0] = ControlType.SET_CLIPBOARD;
  v.setBigUint64(1, sequence);
  buf[9] = paste ? 1 : 0;
  v.setUint32(10, payload.length);
  buf.set(payload, 14);
  return buf;
}

export function encodeSetDisplayPower(on: boolean): Uint8Array {
  return Uint8Array.of(ControlType.SET_DISPLAY_POWER, on ? 1 : 0);
}

/** name may be a package name; scrcpy also accepts "+pkg" (force-stop first) and "?label". */
export function encodeStartApp(name: string): Uint8Array {
  const payload = utf8Truncate(enc.encode(name), START_APP_NAME_MAX_LENGTH);
  const buf = new Uint8Array(2 + payload.length);
  buf[0] = ControlType.START_APP;
  buf[1] = payload.length;
  buf.set(payload, 2);
  return buf;
}

export function encodeScanFile(path: string): Uint8Array {
  const payload = utf8Truncate(enc.encode(path), 256);
  const buf = new Uint8Array(5 + payload.length);
  buf[0] = ControlType.SCAN_FILE;
  new DataView(buf.buffer).setUint32(1, payload.length);
  buf.set(payload, 5);
  return buf;
}

export function encodeSimple(
  type:
    | typeof ControlType.EXPAND_NOTIFICATION_PANEL
    | typeof ControlType.EXPAND_SETTINGS_PANEL
    | typeof ControlType.COLLAPSE_PANELS
    | typeof ControlType.ROTATE_DEVICE
    | typeof ControlType.OPEN_HARD_KEYBOARD_SETTINGS
    | typeof ControlType.RESET_VIDEO,
): Uint8Array {
  return Uint8Array.of(type);
}

// ---------------------------------------------------------------- device → PC

export type DeviceMessage =
  | { type: "clipboard"; text: string }
  | { type: "ack_clipboard"; sequence: bigint }
  | { type: "uhid_output"; id: number; data: Uint8Array };

const dec = new TextDecoder();

/**
 * Parse one device message from the front of buf.
 * Returns [message, bytesConsumed], or null if incomplete. Throws on unknown type.
 */
export function parseDeviceMessage(buf: Uint8Array): [DeviceMessage, number] | null {
  if (buf.length === 0) return null;
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  switch (buf[0]) {
    case 0: {
      if (buf.length < 5) return null;
      const len = v.getUint32(1);
      if (len > buf.length - 5) return null;
      return [{ type: "clipboard", text: dec.decode(buf.subarray(5, 5 + len)) }, 5 + len];
    }
    case 1:
      if (buf.length < 9) return null;
      return [{ type: "ack_clipboard", sequence: v.getBigUint64(1) }, 9];
    case 2: {
      if (buf.length < 5) return null;
      const id = v.getUint16(1);
      const size = v.getUint16(3);
      if (size > buf.length - 5) return null;
      return [{ type: "uhid_output", id, data: buf.slice(5, 5 + size) }, 5 + size];
    }
    default:
      throw new Error(`Unknown device message type ${buf[0]}`);
  }
}

// ---------------------------------------------------------------- media streams

export type StreamEvent =
  | { kind: "codec"; codecId: number }
  | { kind: "session"; width: number; height: number; clientResized: boolean }
  | { kind: "packet"; config: boolean; keyFrame: boolean; pts: bigint | null; data: Uint8Array; rotation?: number };

const FLAG_CONFIG = 1n << 62n;
const FLAG_KEY_FRAME = 1n << 61n;
const PTS_MASK = FLAG_KEY_FRAME - 1n;

/**
 * Incremental parser for one scrcpy media socket (video or audio).
 * Layout: codec id (u32) → [video only: session header] → 12-byte headers + payloads.
 * Video streams may contain further session headers on rotation/resize.
 */
export class MediaStreamParser {
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private gotCodec = false;
  private pendingPacket: { header: Uint8Array; len: number } | null = null;

  constructor(private readonly isVideo: boolean) {}

  push(data: Uint8Array): StreamEvent[] {
    if (data.length) {
      this.chunks.push(data);
      this.buffered += data.length;
    }
    const out: StreamEvent[] = [];
    for (;;) {
      if (!this.gotCodec) {
        const b = this.take(4);
        if (!b) break;
        this.gotCodec = true;
        const codecId = new DataView(b.buffer, b.byteOffset, 4).getUint32(0);
        out.push({ kind: "codec", codecId });
        if (codecId === CodecId.DISABLED || codecId === CodecId.ERROR) break;
        continue;
      }
      if (this.pendingPacket) {
        const payload = this.take(this.pendingPacket.len);
        if (!payload) break;
        const hv = new DataView(this.pendingPacket.header.buffer, this.pendingPacket.header.byteOffset, 12);
        const ptsFlags = hv.getBigUint64(0);
        const config = (ptsFlags & FLAG_CONFIG) !== 0n;
        out.push({
          kind: "packet",
          config,
          keyFrame: (ptsFlags & FLAG_KEY_FRAME) !== 0n,
          pts: config ? null : ptsFlags & PTS_MASK,
          data: payload,
        });
        this.pendingPacket = null;
        continue;
      }
      const header = this.take(PACKET_HEADER_SIZE);
      if (!header) break;
      const hv = new DataView(header.buffer, header.byteOffset, 12);
      if (header[0]! & 0x80) {
        if (!this.isVideo) throw new Error("Session packet on a non-video stream");
        out.push({
          kind: "session",
          width: hv.getUint32(4),
          height: hv.getUint32(8),
          clientResized: (header[3]! & 1) === 1,
        });
        continue;
      }
      const len = hv.getUint32(8);
      if (len === 0) throw new Error("Invalid packet length: 0");
      this.pendingPacket = { header, len };
    }
    return out;
  }

  /** Remove and return exactly n bytes, or null if fewer are buffered. */
  private take(n: number): Uint8Array | null {
    if (this.buffered < n) return null;
    const first = this.chunks[0]!;
    if (first.length >= n) {
      const out = first.subarray(0, n);
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      this.buffered -= n;
      return new Uint8Array(out); // copy: detach from the socket buffer, normalize Buffer → Uint8Array
    }
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      const c = this.chunks[0]!;
      const need = n - off;
      if (c.length <= need) {
        out.set(c, off);
        off += c.length;
        this.chunks.shift();
      } else {
        out.set(c.subarray(0, need), off);
        this.chunks[0] = c.subarray(need);
        off += need;
      }
    }
    this.buffered -= n;
    return out;
  }
}

/** Encode a media packet header + payload (used by the test device emulator). */
export function encodeMediaPacket(data: Uint8Array, opts: { config?: boolean; keyFrame?: boolean; pts?: bigint }): Uint8Array {
  const buf = new Uint8Array(PACKET_HEADER_SIZE + data.length);
  const v = new DataView(buf.buffer);
  let flags = opts.config ? FLAG_CONFIG : (opts.pts ?? 0n) & PTS_MASK;
  if (opts.keyFrame) flags |= FLAG_KEY_FRAME;
  v.setBigUint64(0, flags);
  v.setUint32(8, data.length);
  buf.set(data, PACKET_HEADER_SIZE);
  return buf;
}

export function encodeSessionHeader(width: number, height: number, clientResized = false): Uint8Array {
  const buf = new Uint8Array(PACKET_HEADER_SIZE);
  const v = new DataView(buf.buffer);
  buf[0] = 0x80;
  buf[3] = clientResized ? 1 : 0;
  v.setUint32(4, width);
  v.setUint32(8, height);
  return buf;
}

// ---------------------------------------------------------------- H.264 helpers

/** Iterate Annex-B NAL units (start codes 00 00 01 / 00 00 00 01). */
export function* annexBNalUnits(data: Uint8Array): Generator<Uint8Array> {
  let i = 0;
  let start = -1;
  const n = data.length;
  while (i + 2 < n) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        if (end > start && data[end - 1] === 0) end--; // 4-byte start code
        yield data.subarray(start, end);
      }
      i += 3;
      start = i;
    } else i++;
  }
  if (start >= 0 && start < n) yield data.subarray(start);
}

/** WebCodecs codec string ("avc1.PPCCLL") from the SPS in an H.264 config packet. */
export function h264CodecString(config: Uint8Array): string | null {
  for (const nal of annexBNalUnits(config)) {
    if ((nal[0]! & 0x1f) === 7 && nal.length >= 4) {
      const hex = (b: number) => b.toString(16).padStart(2, "0");
      return `avc1.${hex(nal[1]!)}${hex(nal[2]!)}${hex(nal[3]!)}`;
    }
  }
  return null;
}

/** Build the scrcpy server argument list (key=value), validated like scrcpy's validate_server_param. */
export interface ServerOptions {
  scid: number;
  video?: boolean;
  audio?: boolean;
  control?: boolean;
  videoCodec?: "h264" | "h265" | "av1";
  audioCodec?: "opus" | "aac" | "flac" | "raw";
  videoBitRate?: number;
  maxSize?: number;
  maxFps?: number;
  stayAwake?: boolean;
  showTouches?: boolean;
  powerOffOnClose?: boolean;
  clipboardAutosync?: boolean;
  audioSource?: "output" | "playback" | "mic";
  displayId?: number;
  logLevel?: "verbose" | "debug" | "info" | "warn" | "error";
}

const FORBIDDEN = /[ ;'"*$?&`#\\|<>[\]{}()!~\r\n]/;

export function buildServerArgs(o: ServerOptions): string[] {
  const args = [`scid=${(o.scid >>> 0).toString(16).padStart(8, "0")}`, `log_level=${o.logLevel ?? "info"}`, "tunnel_forward=true"];
  if (o.video === false) args.push("video=false");
  if (o.audio === false) args.push("audio=false");
  if (o.control === false) args.push("control=false");
  if (o.videoCodec && o.videoCodec !== "h264") args.push(`video_codec=${o.videoCodec}`);
  if (o.audioCodec && o.audioCodec !== "opus") args.push(`audio_codec=${o.audioCodec}`);
  if (o.audioSource && o.audioSource !== "output") args.push(`audio_source=${o.audioSource}`);
  if (o.videoBitRate) args.push(`video_bit_rate=${Math.round(o.videoBitRate)}`);
  if (o.maxSize) args.push(`max_size=${Math.round(o.maxSize)}`);
  if (o.maxFps) args.push(`max_fps=${o.maxFps}`);
  if (o.displayId) args.push(`display_id=${o.displayId}`);
  if (o.stayAwake) args.push("stay_awake=true");
  if (o.showTouches) args.push("show_touches=true");
  if (o.powerOffOnClose) args.push("power_off_on_close=true");
  if (o.clipboardAutosync === false) args.push("clipboard_autosync=false");
  for (const a of args) if (FORBIDDEN.test(a)) throw new Error(`Invalid server param: ${a}`);
  return args;
}
