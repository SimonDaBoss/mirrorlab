import {
  KeyAction,
  MotionAction,
  POINTER_ID_GENERIC_FINGER,
  encodeBackOrScreenOn,
  encodeKeycode,
  encodeSetClipboard,
  encodeSetDisplayPower,
  encodeStartApp,
  encodeText,
  encodeTouch,
  INJECT_TEXT_MAX_LENGTH,
} from "../shared/protocol";
import { Keycode } from "../shared/keys";
import type { MirrorSession } from "./scrcpy/session";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * High-level gestures over the scrcpy control socket. Coordinates are in
 * mirror-video space (what screenshots show), which is what the device
 * expects as long as the screen size field matches the current video size.
 */
export class DeviceController {
  private clipboardSeq = 1n;

  constructor(private readonly session: MirrorSession) {}

  private get size() {
    const s = this.session.videoSize;
    if (!s) throw new Error("No video yet — wait for the first frame");
    return s;
  }

  private check(x: number, y: number) {
    const { width, height } = this.size;
    if (!(x >= 0 && y >= 0 && x < width && y < height)) {
      throw new Error(`Point (${x}, ${y}) is outside the screen (${width}x${height})`);
    }
  }

  private touch(action: number, x: number, y: number, pressure: number) {
    this.session.send(
      encodeTouch({
        action,
        pointerId: POINTER_ID_GENERIC_FINGER,
        position: { x, y, ...this.size },
        pressure,
        actionButton: 0,
        buttons: 0,
      }),
    );
  }

  async tap(x: number, y: number, holdMs = 40): Promise<void> {
    this.check(x, y);
    this.touch(MotionAction.DOWN, x, y, 1);
    await sleep(holdMs);
    this.touch(MotionAction.UP, x, y, 0);
  }

  longPress(x: number, y: number, ms = 700): Promise<void> {
    return this.tap(x, y, ms);
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs = 300): Promise<void> {
    this.check(x1, y1);
    this.check(x2, y2);
    const steps = Math.max(5, Math.round(durationMs / 16));
    this.touch(MotionAction.DOWN, x1, y1, 1);
    for (let i = 1; i <= steps; i++) {
      await sleep(durationMs / steps);
      const t = i / steps;
      this.touch(MotionAction.MOVE, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, 1);
    }
    this.touch(MotionAction.UP, x2, y2, 0);
  }

  key(keycode: number, metastate = 0): void {
    this.session.send(encodeKeycode(KeyAction.DOWN, keycode, 0, metastate));
    this.session.send(encodeKeycode(KeyAction.UP, keycode, 0, metastate));
  }

  /** Text injection, chunked to the protocol's 300-byte limit. */
  async type(text: string): Promise<void> {
    const enc = new TextEncoder();
    let chunk = "";
    for (const ch of text) {
      if (ch === "\n") {
        if (chunk) this.session.send(encodeText(chunk));
        chunk = "";
        this.key(Keycode.ENTER);
        continue;
      }
      if (enc.encode(chunk + ch).length > INJECT_TEXT_MAX_LENGTH) {
        this.session.send(encodeText(chunk));
        chunk = "";
        await sleep(10);
      }
      chunk += ch;
    }
    if (chunk) this.session.send(encodeText(chunk));
  }

  /** Put text on the device clipboard; with paste=true also pastes it (works where text injection fails, e.g. non-ASCII in some IMEs). */
  setClipboard(text: string, paste: boolean): void {
    this.session.send(encodeSetClipboard(this.clipboardSeq++, text, paste));
  }

  back(): void {
    this.session.send(encodeBackOrScreenOn(KeyAction.DOWN));
    this.session.send(encodeBackOrScreenOn(KeyAction.UP));
  }

  launch(packageName: string, forceStop = false): void {
    this.session.send(encodeStartApp(forceStop ? `+${packageName}` : packageName));
  }

  displayPower(on: boolean): void {
    this.session.send(encodeSetDisplayPower(on));
  }
}
