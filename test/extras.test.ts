import { describe, expect, it } from "vitest";
import { parseDevices, parseWlanIp, shellQuote } from "../src/main/adb";
import { findNodes, formatNodes, parseForeground, parseUiXml, parseWmSize } from "../src/main/extras/inspector";
import { parseLogLine } from "../src/main/extras/logcat";
import { keycodeForCode, metaState } from "../src/shared/keys";

describe("adb parsing", () => {
  it("parses devices -l including wifi, mdns and emulators", () => {
    const out = `List of devices attached
R58M12345      device usb:1-2 product:beyond1 model:SM_G973F device:beyond1 transport_id:3
192.168.1.50:5555 device product:x model:Pixel_7 device:x transport_id:4
adb-1A2B3C-xyz._adb-tls-connect._tcp device product:y model:Pixel_8 transport_id:5
127.0.0.1:5555 device product:ld model:ASUS_I003DD transport_id:6
emulator-5554  unauthorized transport_id:7
`;
    const d = parseDevices(out);
    expect(d.map((x) => [x.serial, x.state, x.kind, x.model])).toEqual([
      ["R58M12345", "device", "usb", "SM G973F"],
      ["192.168.1.50:5555", "device", "wifi", "Pixel 7"],
      ["adb-1A2B3C-xyz._adb-tls-connect._tcp", "device", "wifi", "Pixel 8"],
      ["127.0.0.1:5555", "device", "emulator", "ASUS I003DD"],
      ["emulator-5554", "unauthorized", "emulator", undefined],
    ]);
  });
  it("finds the wlan IP and quotes for the device shell", () => {
    expect(parseWlanIp("    inet 10.0.0.7/24 brd 10.0.0.255 scope global wlan0")).toBe("10.0.0.7");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe("inspector", () => {
  const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node class="android.widget.FrameLayout" text="" resource-id="" content-desc="" package="p" clickable="false" bounds="[0,0][1080,2400]"><node class="android.widget.Button" text="OK" resource-id="p:id/ok" content-desc="" package="p" clickable="true" bounds="[100,200][300,300]"/></node></hierarchy>`;
  it("scales bounds into video space and swaps axes in landscape", () => {
    const portrait = parseUiXml(xml, { width: 1080, height: 2400 }, { width: 540, height: 1200 });
    expect(portrait[1]!.bounds).toEqual([50, 100, 150, 150]);
    const landscape = parseUiXml(xml, { width: 1080, height: 2400 }, { width: 1200, height: 540 });
    // Display reported portrait (1080x2400) but video is landscape: axes swap, so the scale stays 0.5 on both.
    expect(landscape[1]!.bounds).toEqual([50, 100, 150, 150]);
  });
  it("finds nodes by short resource id and formats for agents", () => {
    const nodes = parseUiXml(xml, { width: 1080, height: 2400 }, { width: 1080, height: 2400 });
    expect(findNodes(nodes, { resourceId: "ok" })[0]!.text).toBe("OK");
    expect(findNodes(nodes, { textContains: "o" })).toHaveLength(1);
    expect(formatNodes(nodes)).toBe('#1   Button "OK" id=ok [100,200,300,300] clickable');
  });
  it("parses wm size and foreground activity", () => {
    expect(parseWmSize("Physical size: 1080x2400\nOverride size: 720x1600")).toEqual({ width: 720, height: 1600 });
    expect(parseForeground("  topResumedActivity=ActivityRecord{a1b u0 com.x/.Main t12}")).toBe("com.x/.Main");
  });
});

describe("logcat + keys", () => {
  it("parses -v epoch lines", () => {
    expect(parseLogLine("  1697584000.123  1234  1250 W ActivityManager: Slow operation: 120ms")).toEqual({
      t: 1697584000123, pid: 1234, tid: 1250, level: "W", tag: "ActivityManager", msg: "Slow operation: 120ms",
    });
    expect(parseLogLine("--------- beginning of main")).toBeNull();
  });
  it("maps keyboard codes and modifiers", () => {
    expect(keycodeForCode("KeyC")).toBe(31);
    expect(keycodeForCode("Digit0")).toBe(7);
    expect(keycodeForCode("F5")).toBe(135);
    expect(keycodeForCode("Backspace")).toBe(67);
    expect(metaState({ ctrlKey: true, shiftKey: false, altKey: false, metaKey: false })).toBe(0x3000);
  });
});
