import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import dgram from "node:dgram";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { l16Audio } from "./rtp";
import { NativeMediaServer } from "./media-bridge";
import { deriveDeviceId } from "./mdns";
import type { AirplayDevice } from "./receiver";

export interface NativeAirplayOptions {
  name: string;
  port: number;
  resourcesDir: string;
  stateDir: string;
  audio: boolean;
  maxFps: number;
}

/** UxPlay owns pairing, FairPlay, NTP, event and media sockets and Bonjour.
 * Decrypted H.264 crosses a reliable framed TCP bridge; decoded audio uses RTP.
 * The GPL receiver remains a separate, independently usable executable.
 */
export class NativeAirplayReceiver extends EventEmitter {
  private child?: ChildProcess;
  private audioSocket?: dgram.Socket;
  private media = new NativeMediaServer();
  private closed = false;
  private active = false;
  private name = "iPhone";
  private logTail = "";
  private closePromise?: Promise<void>;
  port = 0;
  videoPort = 0;
  audioPort = 0;
  private parentExit = () => this.close();

  constructor(private readonly opts: NativeAirplayOptions) { super(); }

  private async bindAudio(): Promise<number> {
    const sock = dgram.createSocket("udp4");
    this.audioSocket = sock;
    sock.on("message", (packet, peer) => {
      if (peer.address !== "127.0.0.1" || this.closed) return;
        const audio = l16Audio(packet);
        if (audio && this.active) this.emit("audio", audio);
    });
    await new Promise<void>((resolve, reject) => {
      sock.once("error", reject);
      sock.bind(0, "127.0.0.1", () => { sock.off("error", reject); resolve(); });
    });
    sock.on("error", (e) => this.close(e));
    return sock.address().port;
  }

  async start(): Promise<number> {
    const runtime = path.join(this.opts.resourcesDir, "airplay", process.platform);
    const binary = process.env.MIRRORLAB_UXPLAY || path.join(runtime, process.platform === "win32" ? "uxplay.exe" : "uxplay");
    if (!fs.existsSync(binary)) throw new Error("AirPlay receiver is missing. Run npm run build:airplay to prepare the bundled receiver.");
    fs.mkdirSync(this.opts.stateDir, { recursive: true });
    this.port = this.opts.port;
    if (!Number.isInteger(this.port) || this.port < 1024 || this.port > 65533) throw new Error("AirPlay port must be between 1024 and 65533.");
    // Do not silently steal an already-running receiver's /info endpoint.
    await new Promise<void>((resolve, reject) => {
      const probe = net.createServer();
      probe.once("error", reject);
      probe.listen(this.port, () => probe.close(() => resolve()));
    });
    try {
      this.media.on("video", (ev) => {
        if (!this.active) {
          this.active = true;
          this.emit("device", { name: this.name, address: "native" } satisfies AirplayDevice);
        }
        this.emit("video", ev);
      });
      this.media.on("failure", (e) => this.close(e));
      this.videoPort = await this.media.start();
      this.audioPort = await this.bindAudio();
      const args = [
        "-n", this.opts.name, "-nh", "-m", deriveDeviceId(),
        "-p", "tcp", `${this.port + 1},${this.port},${this.port + 2}`,
        "-key", path.join(this.opts.stateDir, "identity.pem"),
        "-fps", String(this.opts.maxFps || 60), "-vsync", "no", "-nofreeze",
        "-vs", "fakesink",
        "-vrtp", "! fakesink sync=false async=false",
      ];
      if (this.opts.audio) args.push("-artp", `pt=97 mtu=1200 ! udpsink host=127.0.0.1 port=${this.audioPort} sync=false async=false`);
      else args.push("-as", "0");
      const env = { ...process.env };
      env.MIRRORLAB_MEDIA_PORT = String(this.videoPort);
      if (!process.env.MIRRORLAB_UXPLAY) {
        env.PATH = `${runtime}${path.delimiter}${env.PATH ?? ""}`;
        env.GST_PLUGIN_PATH = path.join(runtime, "lib", "gstreamer-1.0");
        env.GST_PLUGIN_SYSTEM_PATH = "";
        env.GST_REGISTRY = path.join(this.opts.stateDir, "gstreamer-registry.bin");
        env.GST_REGISTRY_FORK = "no";
      }
      this.child = spawn(binary, args, { cwd: this.opts.stateDir, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const logger = () => {
        let pending = "";
        const decoder = new StringDecoder("utf8");
        return (chunk: Buffer) => {
          const text = decoder.write(chunk);
          this.logTail = (this.logTail + text).slice(-8000);
          this.emit("log", text);
          pending = (pending + text).slice(-16000);
          const lines = pending.split(/\r?\n/);
          pending = lines.pop() ?? "";
          for (const line of lines) {
            const match = /^connection request from (.+?) \([^\r\n]*\) with deviceID/.exec(line);
            if (match) { this.name = match[1]!; this.emit("name", this.name); }
            if (line === "MIRRORLAB_DISCONNECTED") this.endSession();
          }
        };
      };
      this.child.stdout?.on("data", logger());
      this.child.stderr?.on("data", logger());
      this.child.once("error", (e) => this.close(e));
      this.child.once("exit", (code) => {
        if (!this.closed) this.close(new Error(`AirPlay receiver exited (${code}). ${this.logTail.slice(-1800)}`));
      });
      process.once("exit", this.parentExit);
      // Verify the actual native RTSP server responds, not merely that spawn succeeded.
      const deadline = Date.now() + 15000;
      while (!this.closed) {
        if (await this.probeInfo()) {
          return this.port;
        }
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`AirPlay receiver failed to start. ${this.logTail.slice(-1800) || "Check Bonjour and the bundled runtime."}`);
    } catch (e) { this.close(); throw e; }
  }

  private probeInfo(): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = net.connect(this.port, "127.0.0.1");
      const finish = (ok: boolean) => { sock.destroy(); resolve(ok); };
      sock.setTimeout(400, () => finish(false));
      sock.once("error", () => finish(false));
      sock.once("connect", () => sock.write("GET /info RTSP/1.0\r\nCSeq: 1\r\n\r\n"));
      sock.once("data", (data) => finish(/^(RTSP|HTTP)\/1\.[01] 200/.test(data.toString("latin1"))));
      sock.once("close", () => resolve(false));
    });
  }

  private endSession() {
    if (!this.active) return;
    this.active = false;
    this.media.resetSession();
    this.emit("disconnect", "iPhone stopped mirroring");
  }

  close(err?: Error): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    process.off("exit", this.parentExit);
    this.closePromise = new Promise<void>((resolve) => {
      const child = this.child;
      if (!child || child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      const timeout = setTimeout(resolve, 3000);
      timeout.unref();
      child.once("exit", () => { clearTimeout(timeout); resolve(); });
      if (!child.kill()) { clearTimeout(timeout); resolve(); }
    });
    this.media.close();
    try { this.audioSocket?.close(); } catch { /* not bound */ }
    this.endSession();
    this.emit("close", err);
    return this.closePromise;
  }
}
