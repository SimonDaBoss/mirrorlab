import { XMLParser } from "fast-xml-parser";
import type { Adb } from "../adb";
import type { UiNode } from "../../shared/types";

const DUMP_PATH = "/sdcard/mirrorlab_ui.xml";

export interface UiDump {
  nodes: UiNode[];
  display: { width: number; height: number };
  video: { width: number; height: number };
  foreground?: string;
}

/** Parse `wm size` output; an override size wins over the physical size. */
export function parseWmSize(out: string): { width: number; height: number } | null {
  const pick = (label: string) => {
    const m = new RegExp(`${label} size: (\\d+)x(\\d+)`).exec(out);
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
  };
  return pick("Override") ?? pick("Physical");
}

/** Package/activity in front, from `dumpsys activity activities`. */
export function parseForeground(out: string): string | undefined {
  const m = /(?:topResumedActivity|mResumedActivity|ResumedActivity)[:=]\s*ActivityRecord\{\S+ \S+ (\S+)/.exec(out);
  return m?.[1];
}

/**
 * Flatten a uiautomator XML dump into nodes, with bounds scaled into the
 * mirror video's coordinate space so one coordinate system serves screenshots,
 * the inspector overlay and taps.
 */
export function parseUiXml(xml: string, display: { width: number; height: number }, video: { width: number; height: number }): UiNode[] {
  // uiautomator reports bounds in the current orientation; if the video is
  // landscape while `wm size` reports portrait, swap the display axes.
  let dw = display.width;
  let dh = display.height;
  if (video.width > video.height !== dw > dh) [dw, dh] = [dh, dw];
  const sx = video.width / dw;
  const sy = video.height / dh;

  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", isArray: (name) => name === "node" });
  const doc = parser.parse(xml) as { hierarchy?: { node?: RawNode[] } };
  const out: UiNode[] = [];
  const walk = (list: RawNode[] | undefined, depth: number) => {
    for (const n of list ?? []) {
      const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(n.bounds ?? "");
      const b = m ? m.slice(1).map(Number) : [0, 0, 0, 0];
      out.push({
        id: out.length,
        depth,
        className: n.class ?? "",
        text: n.text ?? "",
        resourceId: n["resource-id"] ?? "",
        contentDesc: n["content-desc"] ?? "",
        packageName: n.package ?? "",
        clickable: n.clickable === "true",
        scrollable: n.scrollable === "true",
        focusable: n.focusable === "true",
        enabled: n.enabled !== "false",
        bounds: [Math.round(b[0]! * sx), Math.round(b[1]! * sy), Math.round(b[2]! * sx), Math.round(b[3]! * sy)],
      });
      walk(n.node, depth + 1);
    }
  };
  walk(doc.hierarchy?.node, 0);
  return out;
}

interface RawNode {
  class?: string;
  text?: string;
  "resource-id"?: string;
  "content-desc"?: string;
  package?: string;
  clickable?: string;
  scrollable?: string;
  focusable?: string;
  enabled?: string;
  bounds?: string;
  node?: RawNode[];
}

export async function dumpUi(adb: Adb, serial: string, video: { width: number; height: number }): Promise<UiDump> {
  const [, wm, act] = await Promise.all([
    adb.shell(serial, `uiautomator dump ${DUMP_PATH}`, 20_000),
    adb.shell(serial, "wm size"),
    adb.shell(serial, "dumpsys activity activities | grep -E 'ResumedActivity'").catch(() => ""),
  ]);
  const xml = (await adb.execOut(serial, `cat ${DUMP_PATH}`)).toString("utf8");
  if (!xml.includes("<hierarchy")) throw new Error("uiautomator returned no hierarchy (the screen may be secure or animating — try again)");
  const display = parseWmSize(wm) ?? video;
  return { nodes: parseUiXml(xml, display, video), display, video, foreground: parseForeground(act) };
}

export interface Selector {
  text?: string;
  textContains?: string;
  resourceId?: string;
  contentDesc?: string;
}

export function findNodes(nodes: UiNode[], s: Selector): UiNode[] {
  const lc = (x: string) => x.toLowerCase();
  return nodes.filter(
    (n) =>
      (s.text === undefined || n.text === s.text) &&
      (s.textContains === undefined || lc(n.text).includes(lc(s.textContains)) || lc(n.contentDesc).includes(lc(s.textContains))) &&
      (s.resourceId === undefined || n.resourceId === s.resourceId || n.resourceId.endsWith(`:id/${s.resourceId}`)) &&
      (s.contentDesc === undefined || lc(n.contentDesc) === lc(s.contentDesc)),
  );
}

export function center(n: UiNode): { x: number; y: number } {
  return { x: Math.round((n.bounds[0] + n.bounds[2]) / 2), y: Math.round((n.bounds[1] + n.bounds[3]) / 2) };
}

/** Compact one-line-per-node listing for agents; skips empty layout containers. */
export function formatNodes(nodes: UiNode[], opts: { interactiveOnly?: boolean } = {}): string {
  const lines: string[] = [];
  for (const n of nodes) {
    const meaningful = n.text || n.contentDesc || n.clickable || n.scrollable || n.resourceId;
    if (!meaningful) continue;
    if (opts.interactiveOnly && !n.clickable && !n.scrollable && !n.focusable) continue;
    const cls = n.className.split(".").pop();
    const parts = [`#${n.id}`, `${"  ".repeat(Math.min(n.depth, 8))}${cls}`];
    if (n.text) parts.push(JSON.stringify(n.text.slice(0, 80)));
    if (n.resourceId) parts.push(`id=${n.resourceId.replace(/^.*:id\//, "")}`);
    if (n.contentDesc) parts.push(`desc=${JSON.stringify(n.contentDesc.slice(0, 60))}`);
    parts.push(`[${n.bounds.join(",")}]`);
    const flags = [n.clickable && "clickable", n.scrollable && "scrollable", !n.enabled && "disabled"].filter(Boolean);
    if (flags.length) parts.push(flags.join(" "));
    lines.push(parts.join(" "));
  }
  return lines.join("\n");
}
