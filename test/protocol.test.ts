import { describe, expect, it } from "vitest";
import {
  ControlType,
  MediaStreamParser,
  MotionAction,
  MotionButton,
  POINTER_ID_MOUSE,
  buildServerArgs,
  encodeBackOrScreenOn,
  encodeKeycode,
  encodeMediaPacket,
  encodeScroll,
  encodeSessionHeader,
  encodeSetClipboard,
  encodeStartApp,
  encodeText,
  encodeTouch,
  floatToI16fp,
  floatToU16fp,
  h264CodecString,
  parseDeviceMessage,
  utf8Truncate,
} from "../src/shared/protocol";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("control messages (byte layouts from scrcpy control_msg.c)", () => {
  it("inject keycode is 14 bytes", () => {
    expect(hex(encodeKeycode(1, 66, 5, 0x1000))).toBe("00" + "01" + "00000042" + "00000005" + "00001000");
  });

  it("inject text: u32 length + utf8", () => {
    expect(hex(encodeText("hé"))).toBe("01" + "00000003" + "68c3a9");
  });

  it("text is truncated at 300 bytes without splitting a code point", () => {
    const msg = encodeText("é".repeat(200)); // 400 bytes
    const len = new DataView(msg.buffer).getUint32(1);
    expect(len).toBe(300);
    expect(new TextDecoder().decode(msg.subarray(5))).toBe("é".repeat(150));
    expect(utf8Truncate(new TextEncoder().encode("aé"), 2)).toEqual(new TextEncoder().encode("a"));
  });

  it("inject touch is 32 bytes with mouse pointer id and u16 pressure", () => {
    const msg = encodeTouch({
      action: MotionAction.DOWN,
      pointerId: POINTER_ID_MOUSE,
      position: { x: 100, y: 200, width: 1080, height: 2400 },
      pressure: 1,
      actionButton: MotionButton.PRIMARY,
      buttons: MotionButton.PRIMARY,
    });
    expect(msg.length).toBe(32);
    expect(hex(msg)).toBe(
      "02" + "00" + "ffffffffffffffff" + "00000064" + "000000c8" + "0438" + "0960" + "ffff" + "00000001" + "00000001",
    );
  });

  it("scroll normalizes [-16,16] to i16 fixed point", () => {
    const msg = encodeScroll({ x: 1, y: 2, width: 3, height: 4 }, 0, -16);
    expect(msg.length).toBe(21);
    const v = new DataView(msg.buffer);
    expect(v.getInt16(13)).toBe(0);
    expect(v.getInt16(15)).toBe(-32768);
    expect(floatToI16fp(1)).toBe(0x7fff);
    expect(floatToU16fp(0.5)).toBe(0x8000);
    expect(floatToU16fp(0)).toBe(0);
  });

  it("set clipboard: seq u64, paste flag, u32 length", () => {
    expect(hex(encodeSetClipboard(7n, "hi", true))).toBe("09" + "0000000000000007" + "01" + "00000002" + "6869");
  });

  it("back-or-screen-on and start app", () => {
    expect(hex(encodeBackOrScreenOn(0))).toBe("0400");
    expect(hex(encodeStartApp("com.x"))).toBe("10" + "05" + Buffer.from("com.x").toString("hex"));
    expect(ControlType.SCAN_FILE).toBe(22);
  });
});

describe("device messages (device_msg.c)", () => {
  it("parses clipboard and waits for complete data", () => {
    const full = Buffer.concat([Buffer.from([0, 0, 0, 0, 3]), Buffer.from("abc")]);
    expect(parseDeviceMessage(full.subarray(0, 6))).toBeNull();
    expect(parseDeviceMessage(full)).toEqual([{ type: "clipboard", text: "abc" }, 8]);
  });

  it("parses ack clipboard", () => {
    const b = Buffer.from("01000000000000002a", "hex");
    expect(parseDeviceMessage(b)).toEqual([{ type: "ack_clipboard", sequence: 42n }, 9]);
  });

  it("throws on unknown type", () => {
    expect(() => parseDeviceMessage(Uint8Array.of(99))).toThrow();
  });
});

describe("media stream parser (demuxer.c)", () => {
  const stream = Buffer.concat([
    Buffer.from("68323634", "hex"),
    encodeSessionHeader(1080, 2400),
    encodeMediaPacket(Uint8Array.of(0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f), { config: true }),
    encodeMediaPacket(Uint8Array.of(9, 9, 9), { keyFrame: true, pts: 123n }),
    encodeSessionHeader(2400, 1080, true),
    encodeMediaPacket(Uint8Array.of(1), { pts: 456n }),
  ]);

  it("parses a stream delivered in one chunk", () => {
    const ev = new MediaStreamParser(true).push(stream);
    expect(ev.map((e) => e.kind)).toEqual(["codec", "session", "packet", "packet", "session", "packet"]);
    expect(ev[1]).toEqual({ kind: "session", width: 1080, height: 2400, clientResized: false });
    expect(ev[2]).toMatchObject({ kind: "packet", config: true, keyFrame: false, pts: null });
    expect(ev[3]).toMatchObject({ kind: "packet", config: false, keyFrame: true, pts: 123n });
    expect(ev[4]).toMatchObject({ kind: "session", width: 2400, height: 1080, clientResized: true });
  });

  it("gives identical results when fed one byte at a time", () => {
    const p = new MediaStreamParser(true);
    const ev = [];
    for (const b of stream) ev.push(...p.push(Uint8Array.of(b)));
    expect(ev).toEqual(new MediaStreamParser(true).push(stream));
  });

  it("stops at a disabled stream", () => {
    expect(new MediaStreamParser(false).push(Buffer.alloc(4))).toEqual([{ kind: "codec", codecId: 0 }]);
  });

  it("derives the WebCodecs codec string from the SPS", () => {
    expect(h264CodecString(Uint8Array.of(0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0, 0, 1, 0x68, 1))).toBe("avc1.42c01f");
  });
});

describe("server args", () => {
  it("formats scid as 8 hex digits and validates like scrcpy", () => {
    const a = buildServerArgs({ scid: 0xabc, maxSize: 1920, videoBitRate: 8e6, stayAwake: true });
    expect(a).toEqual(["scid=00000abc", "log_level=info", "tunnel_forward=true", "video_bit_rate=8000000", "max_size=1920", "stay_awake=true"]);
  });
});
