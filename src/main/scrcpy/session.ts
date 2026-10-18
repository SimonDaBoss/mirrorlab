import { EventEmitter } from "node:events";
import net from "node:net";
import type { ChildProcess } from "node:child_process";
import { Adb, shellQuote } from "../adb";
import {
  DEVICE_NAME_FIELD_LENGTH,
  DEVICE_SERVER_PATH,
  MediaStreamParser,
  SCRCPY_VERSION,
  buildServerArgs,
  parseDeviceMessage,
  type DeviceMessage,
  type ServerOptions,
  type StreamEvent,
} from "../../shared/protocol";

export interface MirrorOptions extends Omit<ServerOptions, "scid"> {
  serverJar: string;
}

export interface MirrorInfo {
  serial: string;
  deviceName: string;
  video: boolean;
  audio: boolean;
  control: boolean;
}

/**
 * One live mirroring session: pushes scrcpy-server, opens the adb forward
 * tunnel, connects the video/audio/control sockets and demuxes the streams.
 *
 * Events:
 *   "video"  (StreamEvent)        — codec / session / packet
 *   "audio"  (StreamEvent)
 *   "device" (DeviceMessage)      — clipboard etc.
 *   "log"    (string)             — server stdout/stderr
 *   "close"  (Error | undefined)
 */
export class MirrorSession extends EventEmitter {
  private server?: ChildProcess;
  private sockets: net.Socket[] = [];
  private control?: net.Socket;
  private closed = false;
  info?: MirrorInfo;
  videoSize?: { width: number; height: number };

  constructor(
    private readonly adb: Adb,
    readonly serial: string,
    private readonly opts: MirrorOptions,
  ) {
    super();
  }

  async start(): Promise<MirrorInfo> {
    const { serial, adb, opts } = this;
    const video = opts.video !== false;
    const audio = opts.audio !== false;
    const control = opts.control !== false;
    const scid = (Math.random() * 0x7fffffff) >>> 0;
    const socketName = `scrcpy_${scid.toString(16).padStart(8, "0")}`;

    await adb.push(serial, opts.serverJar, DEVICE_SERVER_PATH);
    const port = await adb.forward(serial, `localabstract:${socketName}`);

    try {
      const args = buildServerArgs({ ...opts, scid });
      this.server = adb.spawn([
        "-s",
        serial,
        "shell",
        `CLASSPATH=${DEVICE_SERVER_PATH}`,
        "app_process",
        "/",
        "com.genymobile.scrcpy.Server",
        SCRCPY_VERSION,
        ...args,
      ]);
      let serverExit: Error | undefined;
      const serverLog: string[] = [];
      const onLog = (b: Buffer) => {
        const s = b.toString("utf8");
        serverLog.push(s);
        if (serverLog.length > 50) serverLog.shift();
        this.emit("log", s);
      };
      this.server.stdout?.on("data", onLog);
      this.server.stderr?.on("data", onLog);
      this.server.on("exit", (code) => {
        serverExit = new Error(`scrcpy server exited (code ${code}). ${serverLog.join("").trim().slice(-800)}`);
        if (this.info) this.close(serverExit);
      });

      // First socket: retry until the server is listening (it writes a dummy byte).
      const first = await connectWithDummyByte(port, () => serverExit);
      const ordered: ("video" | "audio" | "control")[] = [];
      if (video) ordered.push("video");
      if (audio) ordered.push("audio");
      if (control) ordered.push("control");
      if (!ordered.length) throw new Error("Nothing to stream: video, audio and control are all disabled");

      const byKind = new Map<string, net.Socket>();
      byKind.set(ordered[0]!, first.socket);
      for (const kind of ordered.slice(1)) byKind.set(kind, await connectPlain(port));
      this.sockets = [...byKind.values()];

      // Device meta (64-byte name) arrives on the first socket, after the dummy byte.
      const reader = new ExactReader(first.socket, first.leftover);
      const nameBuf = await reader.read(DEVICE_NAME_FIELD_LENGTH);
      const nul = nameBuf.indexOf(0);
      const deviceName = nameBuf.subarray(0, nul < 0 ? nameBuf.length : nul).toString("utf8");
      const firstRest = reader.detach();

      await adb.removeForward(serial, port);

      const attachMedia = (kind: "video" | "audio", sock: net.Socket, initial: Buffer) => {
        const parser = new MediaStreamParser(kind === "video");
        const handle = (chunk: Buffer) => {
          let events: StreamEvent[];
          try {
            events = parser.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
          } catch (e) {
            this.close(e as Error);
            return;
          }
          for (const ev of events) {
            if (kind === "video" && ev.kind === "session") this.videoSize = { width: ev.width, height: ev.height };
            this.emit(kind, ev);
          }
        };
        if (initial.length) handle(initial);
        sock.on("data", handle);
        sock.resume();
      };

      for (const [kind, sock] of byKind) {
        const initial = sock === first.socket ? firstRest : Buffer.alloc(0);
        sock.on("error", (e) => this.close(e));
        sock.on("close", () => this.close());
        if (kind === "video" || kind === "audio") attachMedia(kind, sock, initial);
        else this.attachControl(sock, initial);
      }

      this.info = { serial, deviceName, video, audio, control };
      return this.info;
    } catch (e) {
      await adb.removeForward(serial, port);
      this.close(e as Error);
      throw e;
    }
  }

  private attachControl(sock: net.Socket, initial: Buffer) {
    sock.setNoDelay(true);
    this.control = sock;
    let pending: Buffer = initial;
    const drain = (chunk: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      for (;;) {
        let parsed: [DeviceMessage, number] | null;
        try {
          parsed = parseDeviceMessage(new Uint8Array(pending.buffer, pending.byteOffset, pending.byteLength));
        } catch (e) {
          this.close(e as Error);
          return;
        }
        if (!parsed) break;
        this.emit("device", parsed[0]);
        pending = pending.subarray(parsed[1]);
      }
    };
    if (initial.length) drain(Buffer.alloc(0));
    sock.on("data", drain);
    sock.resume();
  }

  /** Send a serialized control message. Returns false if control is unavailable. */
  send(msg: Uint8Array): boolean {
    if (!this.control || this.closed) return false;
    this.control.write(msg);
    return true;
  }

  close(err?: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const s of this.sockets) s.destroy();
    this.server?.kill();
    this.emit("close", err);
  }

  get isClosed() {
    return this.closed;
  }
}

/** Reads exact byte counts from a socket, then hands back whatever is left over. */
class ExactReader {
  private buf: Buffer;
  private waiter?: () => void;
  private onData = (c: Buffer) => {
    this.buf = Buffer.concat([this.buf, c]);
    this.waiter?.();
  };
  constructor(
    private readonly sock: net.Socket,
    initial: Buffer,
  ) {
    this.buf = initial;
    sock.on("data", this.onData);
    sock.resume();
  }
  async read(n: number, timeoutMs = 10_000): Promise<Buffer> {
    const deadline = Date.now() + timeoutMs;
    while (this.buf.length < n) {
      if (this.sock.destroyed) throw new Error("Socket closed while reading device info");
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("Timed out reading device info")), Math.max(0, deadline - Date.now()));
        this.waiter = () => {
          clearTimeout(t);
          resolve();
        };
        this.sock.once("close", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
  detach(): Buffer {
    this.sock.off("data", this.onData);
    this.sock.pause();
    return this.buf;
  }
}

function connectPlain(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => {
      s.off("error", reject);
      resolve(s);
    });
    s.once("error", reject);
  });
}

/**
 * adb accepts the TCP connection even before the device server listens, so
 * a connection only counts once the server's dummy byte arrives (scrcpy's
 * connect_and_read_byte). 100 attempts × 100 ms, like scrcpy.
 */
async function connectWithDummyByte(
  port: number,
  failed: () => Error | undefined,
): Promise<{ socket: net.Socket; leftover: Buffer }> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const exit = failed();
    if (exit) throw exit;
    const got = await new Promise<{ socket: net.Socket; leftover: Buffer } | null>((resolve) => {
      const s = net.connect({ host: "127.0.0.1", port });
      const t = setTimeout(() => {
        s.destroy();
        resolve(null);
      }, 2000);
      s.once("data", (d) => {
        clearTimeout(t);
        s.pause();
        resolve({ socket: s, leftover: d.subarray(1) });
      });
      s.once("error", () => {
        clearTimeout(t);
        resolve(null);
      });
      s.once("close", () => {
        clearTimeout(t);
        resolve(null);
      });
    });
    if (got) {
      // Stay paused: the next reader attaches its listener, then resumes.
      got.socket.removeAllListeners("error").removeAllListeners("close");
      return got;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Could not connect to the scrcpy server on the device");
}

export { shellQuote };
