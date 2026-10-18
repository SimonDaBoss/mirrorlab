import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Adb } from "../adb";
import type { DeviceController } from "../controller";
import { namedKeys } from "../../shared/keys";
import type { UiNode } from "../../shared/types";
import { center, findNodes, formatNodes, type UiDump } from "./inspector";
import { formatLog, type LogcatStream } from "./logcat";
import type { Timeline } from "./timeline";

/** Longest screenshot edge handed to agents; agent coordinates use this space. */
export const AGENT_MAX_DIM = 1280;

export interface MirrorHandle {
  serial: string;
  deviceName: string;
  controller: DeviceController;
  videoSize(): { width: number; height: number } | undefined;
  /** PNG of the current frame, scaled so the longest edge ≤ maxDim. */
  screenshot(maxDim: number): Promise<Buffer>;
  ui(): Promise<UiDump>;
  logcat: LogcatStream;
  timeline: Timeline;
  /** Visual feedback in the mirror window so you can see what the agent does. */
  indicate(kind: "tap" | "swipe" | "type" | "key", x?: number, y?: number, x2?: number, y2?: number): void;
}

export interface AgentHub {
  adb: Adb;
  listDevices(): Promise<{ serial: string; model?: string; state: string; mirroring: boolean }[]>;
  /** The open mirror for serial (or the only/first one). Throws if none is open. */
  mirror(serial?: string): MirrorHandle;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Scale between agent space (screenshots) and mirror-video space. */
function scaleOf(h: MirrorHandle): number {
  const s = h.videoSize();
  if (!s) throw new Error("The mirror has no video yet — wait a moment and retry");
  return Math.min(1, AGENT_MAX_DIM / Math.max(s.width, s.height));
}

function scaledNodes(nodes: UiNode[], k: number): UiNode[] {
  return nodes.map((n) => ({ ...n, bounds: n.bounds.map((v) => Math.round(v * k)) as UiNode["bounds"] }));
}

export function buildAgentServer(hub: AgentHub): McpServer {
  const server = new McpServer(
    { name: "mirrorlab", version: "0.1.0" },
    {
      instructions:
        "Mirrorlab mirrors an Android device on the user's PC. Coordinates for tap/swipe and ui_tree bounds are pixels in the screenshot this server returns. " +
        "Prefer ui_tree + tap_element over guessing coordinates. Every action is logged on the user's timeline and shown live in the mirror window.",
    },
  );
  const serialArg = { serial: z.string().optional().describe("Device serial; defaults to the open mirror") };
  const shotArg = {
    screenshot: z.boolean().default(true).describe("Return a screenshot after the action settles"),
    settle_ms: z.number().int().min(0).max(5000).default(600),
  };

  const after = async (h: MirrorHandle, text: string, shot: boolean, settle: number) => {
    const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [{ type: "text", text }];
    if (shot) {
      await sleep(settle);
      const png = await h.screenshot(AGENT_MAX_DIM);
      content.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
    }
    return { content };
  };

  server.registerTool(
    "list_devices",
    { title: "List devices", description: "Android devices visible to adb, and which have an open mirror window." },
    async () => {
      const list = await hub.listDevices();
      return { content: [{ type: "text", text: list.length ? JSON.stringify(list, null, 2) : "No devices. Connect a phone with USB debugging, or start an emulator." }] };
    },
  );

  server.registerTool(
    "screenshot",
    { title: "Screenshot", description: "Current screen of the mirrored device.", inputSchema: { ...serialArg } },
    async ({ serial }) => {
      const h = hub.mirror(serial);
      const k = scaleOf(h);
      const s = h.videoSize()!;
      const png = await h.screenshot(AGENT_MAX_DIM);
      h.timeline.add("agent", "screenshot", "agent looked at the screen");
      return {
        content: [
          { type: "text", text: `${h.deviceName}: ${Math.round(s.width * k)}x${Math.round(s.height * k)} (coordinates for tap/swipe use this size)` },
          { type: "image", data: png.toString("base64"), mimeType: "image/png" },
        ],
      };
    },
  );

  server.registerTool(
    "tap",
    {
      title: "Tap",
      description: "Tap at (x, y) in screenshot pixels. Set long_press for a press-and-hold.",
      inputSchema: { ...serialArg, x: z.number(), y: z.number(), long_press: z.boolean().default(false), ...shotArg },
    },
    async ({ serial, x, y, long_press, screenshot, settle_ms }) => {
      const h = hub.mirror(serial);
      const k = scaleOf(h);
      const vx = Math.round(x / k);
      const vy = Math.round(y / k);
      h.indicate("tap", vx, vy);
      await (long_press ? h.controller.longPress(vx, vy) : h.controller.tap(vx, vy));
      h.timeline.add("agent", long_press ? "long_press" : "tap", `(${x}, ${y})`);
      return after(h, `Tapped (${x}, ${y})`, screenshot, settle_ms);
    },
  );

  server.registerTool(
    "swipe",
    {
      title: "Swipe",
      description: "Swipe from (x1,y1) to (x2,y2) in screenshot pixels. To scroll a list down, swipe upward.",
      inputSchema: { ...serialArg, x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(), duration_ms: z.number().int().min(50).max(5000).default(300), ...shotArg },
    },
    async ({ serial, x1, y1, x2, y2, duration_ms, screenshot, settle_ms }) => {
      const h = hub.mirror(serial);
      const k = scaleOf(h);
      const p = [x1, y1, x2, y2].map((v) => Math.round(v / k)) as [number, number, number, number];
      h.indicate("swipe", ...p);
      await h.controller.swipe(...p, duration_ms);
      h.timeline.add("agent", "swipe", `(${x1}, ${y1}) → (${x2}, ${y2})`);
      return after(h, "Swiped", screenshot, settle_ms);
    },
  );

  server.registerTool(
    "type_text",
    {
      title: "Type text",
      description: "Type into the focused field. Newlines press Enter. use_clipboard pastes instead (more reliable for emoji and non-Latin text).",
      inputSchema: { ...serialArg, text: z.string().max(20_000), use_clipboard: z.boolean().default(false), ...shotArg },
    },
    async ({ serial, text, use_clipboard, screenshot, settle_ms }) => {
      const h = hub.mirror(serial);
      h.indicate("type");
      if (use_clipboard) h.controller.setClipboard(text, true);
      else await h.controller.type(text);
      h.timeline.add("agent", "text", text.length > 200 ? `${text.slice(0, 200)}…` : text);
      return after(h, `Typed ${text.length} characters`, screenshot, settle_ms);
    },
  );

  server.registerTool(
    "press_key",
    {
      title: "Press key",
      description: `Press a device key: ${Object.keys(namedKeys).join(", ")}.`,
      inputSchema: { ...serialArg, key: z.string(), ...shotArg },
    },
    async ({ serial, key, screenshot, settle_ms }) => {
      const h = hub.mirror(serial);
      const name = key.toLowerCase().replace(/[\s-]/g, "_");
      const code = namedKeys[name];
      if (code === undefined) throw new Error(`Unknown key "${key}". Known: ${Object.keys(namedKeys).join(", ")}`);
      h.indicate("key");
      if (name === "back") h.controller.back();
      else h.controller.key(code);
      h.timeline.add("agent", "key", name);
      return after(h, `Pressed ${name}`, screenshot, settle_ms);
    },
  );

  server.registerTool(
    "ui_tree",
    {
      title: "UI tree",
      description:
        "Accessibility hierarchy of the current screen (uiautomator): one line per element with #id, class, text, resource id, content description and [x1,y1,x2,y2] bounds in screenshot pixels. Games and video surfaces have no tree — use screenshots there.",
      inputSchema: { ...serialArg, interactive_only: z.boolean().default(false) },
    },
    async ({ serial, interactive_only }) => {
      const h = hub.mirror(serial);
      const dump = await h.ui();
      const nodes = scaledNodes(dump.nodes, scaleOf(h));
      const header = `foreground: ${dump.foreground ?? "unknown"} · ${nodes.length} nodes`;
      return { content: [{ type: "text", text: `${header}\n${formatNodes(nodes, { interactiveOnly: interactive_only }) || "(no meaningful elements)"}` }] };
    },
  );

  server.registerTool(
    "tap_element",
    {
      title: "Tap element",
      description: "Find an element in the UI tree and tap its center. Give at least one of text, text_contains, resource_id, content_desc.",
      inputSchema: {
        ...serialArg,
        text: z.string().optional(),
        text_contains: z.string().optional(),
        resource_id: z.string().optional().describe("Full (pkg:id/name) or short (name)"),
        content_desc: z.string().optional(),
        index: z.number().int().min(0).default(0).describe("Which match, if several"),
        ...shotArg,
      },
    },
    async ({ serial, text, text_contains, resource_id, content_desc, index, screenshot, settle_ms }) => {
      if (!text && !text_contains && !resource_id && !content_desc) throw new Error("Give at least one selector");
      const h = hub.mirror(serial);
      const dump = await h.ui();
      const matches = findNodes(dump.nodes, { text, textContains: text_contains, resourceId: resource_id, contentDesc: content_desc });
      const target = matches.filter((n) => n.clickable)[index] ?? matches[index];
      if (!target) throw new Error(`No element matches. Call ui_tree to see what is on screen.`);
      const c = center(target);
      h.indicate("tap", c.x, c.y);
      await h.controller.tap(c.x, c.y);
      const label = target.text || target.contentDesc || target.resourceId || target.className;
      h.timeline.add("agent", "tap", `element "${label}"`);
      return after(h, `Tapped "${label}" (${matches.length} match${matches.length === 1 ? "" : "es"})`, screenshot, settle_ms);
    },
  );

  server.registerTool(
    "launch_app",
    {
      title: "Launch app",
      description: "Start an app by package name (e.g. com.android.settings). force_restart stops it first.",
      inputSchema: { ...serialArg, package: z.string().regex(/^[\w.]+$/), force_restart: z.boolean().default(false), ...shotArg },
    },
    async ({ serial, package: pkg, force_restart, screenshot, settle_ms }) => {
      const h = hub.mirror(serial);
      h.controller.launch(pkg, force_restart);
      h.timeline.add("agent", "app", `launch ${pkg}${force_restart ? " (restart)" : ""}`);
      return after(h, `Launching ${pkg}`, screenshot, Math.max(settle_ms, 1500));
    },
  );

  server.registerTool(
    "list_packages",
    {
      title: "List packages",
      description: "Installed packages. third_party_only skips system apps.",
      inputSchema: { ...serialArg, third_party_only: z.boolean().default(true), filter: z.string().optional() },
    },
    async ({ serial, third_party_only, filter }) => {
      const h = hub.mirror(serial);
      const out = await hub.adb.shell(h.serial, `pm list packages${third_party_only ? " -3" : ""}`);
      let pkgs = out.split(/\r?\n/).map((l) => l.replace(/^package:/, "").trim()).filter(Boolean).sort();
      if (filter) pkgs = pkgs.filter((p) => p.includes(filter));
      return { content: [{ type: "text", text: pkgs.join("\n") || "(none)" }] };
    },
  );

  server.registerTool(
    "logcat",
    {
      title: "Logcat",
      description: "Recent device log lines — e.g. right after an action, to see what the app did. Filter by package and minimum level (V/D/I/W/E).",
      inputSchema: { ...serialArg, lines: z.number().int().min(1).max(2000).default(200), package: z.string().optional(), min_level: z.enum(["V", "D", "I", "W", "E"]).optional() },
    },
    async ({ serial, lines, package: pkg, min_level }) => {
      const h = hub.mirror(serial);
      const out = await h.logcat.recent({ lines, packageName: pkg, minLevel: min_level });
      return { content: [{ type: "text", text: out.map(formatLog).join("\n") || "(no matching lines)" }] };
    },
  );

  server.registerTool(
    "timeline",
    {
      title: "Timeline",
      description: "Recent events on the user's evidence timeline (their inputs and yours). Add a note to record a finding or hypothesis.",
      inputSchema: { ...serialArg, note: z.string().optional(), limit: z.number().int().min(1).max(500).default(50) },
    },
    async ({ serial, note, limit }) => {
      const h = hub.mirror(serial);
      if (note) h.timeline.add("agent", "note", note);
      return { content: [{ type: "text", text: h.timeline.format(limit) || "(empty)" }] };
    },
  );

  return server;
}

export interface AgentEndpoint {
  url: string;
  close(): Promise<void>;
}

/**
 * Streamable-HTTP MCP endpoint on 127.0.0.1 only, with a bearer token and a
 * Host-header check (blocks DNS-rebinding from web pages).
 */
export function startAgentEndpoint(hub: AgentHub, port: number, token: string): Promise<AgentEndpoint> {
  const httpServer = http.createServer(async (req, res) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (host !== "127.0.0.1" && host !== "localhost") {
      res.writeHead(403).end("Forbidden host");
      return;
    }
    if (!req.url?.startsWith("/mcp")) {
      res.writeHead(404).end("Mirrorlab agent endpoint is at /mcp");
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end("Missing or wrong token — copy the setup command from Mirrorlab");
      return;
    }
    if (req.method !== "POST") {
      // Stateless server: no standalone SSE stream or session deletion.
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    let body: unknown;
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400).end("Invalid JSON");
      return;
    }
    const server = buildAgentServer(hub);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500).end(String(e));
    }
  });
  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "127.0.0.1", () => {
      const addr = httpServer.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        url: `http://127.0.0.1:${actual}/mcp`,
        close: () => new Promise((r) => httpServer.close(() => r())),
      });
    });
  });
}
