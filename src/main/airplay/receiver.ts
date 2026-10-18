import { EventEmitter } from "node:events";
import net from "node:net";
import { MirrorStreamParser } from "../../shared/airplay/mirror";
import { buildBplist, isBinaryPlist, parseBplist, type PlistValue } from "../../shared/airplay/bplist";
import type { StreamEvent } from "../../shared/protocol";
import { MdnsAdvertiser, deriveDeviceId, type AirplayService } from "./mdns";
import { PLIST_CONTENT_TYPE, RtspParser, buildResponse, type RtspRequest } from "./rtsp";
import type { KeyProvider } from "./crypto";

export interface AirplayOptions {
  name: string;
  port?: number; // RTSP port; 0 picks a free one
  keyProvider: KeyProvider;
  advertise?: boolean; // default true
  features?: string;
  model?: string;
}

export interface AirplayDevice {
  name: string;
  address: string;
  width?: number;
  height?: number;
}

/**
 * AirPlay screen-mirroring receiver. Advertises over mDNS, accepts an iPhone's
 * RTSP session, negotiates the mirror stream, and decodes the encrypted H.264
 * into the same StreamEvents as the Android path — so the renderer is shared.
 *
 * Events: "device" (AirplayDevice, when mirroring starts), "video" (StreamEvent),
 * "name" (friendly client name), "close" (Error | undefined), "log" (string).
 */
export class AirplayReceiver extends EventEmitter {
  private rtsp?: net.Server;
  private dataServer?: net.Server;
  private mdns?: MdnsAdvertiser;
  private parser = new MirrorStreamParser();
  private audioKey?: Buffer;
  private eiv?: Buffer;
  private clientName?: string;
  private clientAddress = "";
  private started = false;
  private dataPort = 0;
  private sockets = new Set<net.Socket>();
  port = 0;

  constructor(private readonly opts: AirplayOptions) {
    super();
  }

  async start(): Promise<number> {
    try {
    this.dataPort = await this.listenData();
    const port = await this.listenRtsp(this.opts.port ?? 7000);
    this.port = port;
    if (this.opts.advertise !== false) {
      this.mdns = new MdnsAdvertiser();
      const svc: AirplayService = {
        name: this.opts.name,
        port,
        deviceId: deriveDeviceId(this.opts.name),
        features: this.opts.features ?? "0x5A7FFFF7,0x1E",
        model: this.opts.model ?? "AppleTV3,2",
      };
      this.mdns.start(svc);
    }
    return port;
    } catch (e) {
      this.close();
      throw e;
    }
  }

  private track(sock: net.Socket): void {
    this.sockets.add(sock);
    sock.once("close", () => this.sockets.delete(sock));
  }

  private listenRtsp(preferred: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((sock) => this.handleRtspConnection(sock));
      this.rtsp = server;
      server.once("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE" && preferred !== 0) {
          server.listen(0, () => resolve((server.address() as net.AddressInfo).port));
        } else reject(e);
      });
      server.listen(preferred, () => resolve((server.address() as net.AddressInfo).port));
    });
  }

  private handleRtspConnection(sock: net.Socket): void {
    this.track(sock);
    this.clientAddress = sock.remoteAddress?.replace(/^::ffff:/, "") ?? "";
    const parser = new RtspParser();
    sock.on("data", (chunk) => {
      let requests: RtspRequest[];
      try {
        requests = parser.push(chunk);
      } catch (e) {
        this.emit("log", `RTSP parse error: ${(e as Error).message}`);
        sock.destroy();
        return;
      }
      for (const req of requests) {
        try {
          this.dispatch(req, sock);
        } catch (e) {
          this.emit("log", `RTSP request error: ${(e as Error).message}`);
          sock.write(buildResponse({ status: 400, cseq: req.headers["cseq"] }));
        }
      }
    });
    sock.on("error", () => undefined);
    sock.on("close", () => {
      if (this.started) this.close();
    });
  }

  private dispatch(req: RtspRequest, sock: net.Socket): void {
    const cseq = req.headers["cseq"];
    const reply = (res: Parameters<typeof buildResponse>[0]) => sock.write(buildResponse({ ...res, cseq }));
    const plistReply = (value: PlistValue) => reply({ body: buildBplist(value), contentType: PLIST_CONTENT_TYPE });
    const body = req.body && isBinaryPlist(req.body) ? (parseBplist(req.body) as Record<string, PlistValue>) : {};

    const path = req.url.split("?")[0] ?? req.url;
    this.emit("log", `${req.method} ${req.url}`);

    switch (true) {
      case req.method === "GET" && path.endsWith("/info"):
        plistReply(this.infoPlist());
        return;

      case req.method === "POST" && path.endsWith("/pair-setup"):
      case req.method === "POST" && path.endsWith("/pair-verify"):
        // Pairing crypto (Ed25519/Curve25519) is handled by the key provider in a
        // full build; the data-path/test build accepts without pairing.
        reply({ body: Buffer.alloc(0) });
        return;

      case req.method === "POST" && path.endsWith("/fp-setup"): {
        const out = this.opts.keyProvider.fpSetup?.(1, req.body) ?? Buffer.alloc(0);
        reply({ body: out });
        return;
      }

      case req.method === "SETUP":
        this.onSetup(body, plistReply, reply);
        return;

      case req.method === "RECORD":
      case req.method === "SET_PARAMETER":
      case req.method === "GET_PARAMETER":
      case req.method === "POST": // /feedback, /audioMode, etc.
        reply({});
        return;

      case req.method === "TEARDOWN":
        reply({});
        this.close();
        return;

      default:
        reply({});
    }
  }

  private onSetup(body: Record<string, PlistValue>, plistReply: (v: PlistValue) => void, reply: (r: Parameters<typeof buildResponse>[0]) => void): void {
    // The client's friendly name arrives in the first SETUP (or /info).
    if (typeof body["name"] === "string") this.setClientName(body["name"]);
    if (typeof body["deviceName"] === "string") this.setClientName(body["deviceName"]);

    // Encrypted session key (FairPlay-wrapped) + IV.
    const ekey = body["ekey"];
    const eiv = body["eiv"];
    if (ekey instanceof Uint8Array && eiv instanceof Uint8Array) {
      this.eiv = Buffer.from(eiv);
      const key = this.opts.keyProvider.decryptAudioKey(Buffer.from(ekey), Buffer.from(eiv));
      if (key) this.audioKey = key;
      else this.emit("log", "Could not decrypt the session key (FairPlay unavailable)");
    }

    const streams = body["streams"];
    if (!Array.isArray(streams)) {
      // First SETUP: negotiate event/timing ports (we don't use timing; echo zeros).
      plistReply({ eventPort: 0, timingPort: 0 });
      return;
    }

    const resStreams: PlistValue[] = [];
    for (const s of streams) {
      const stream = s as Record<string, PlistValue>;
      const type = Number(stream["type"]);
      if (type === 110) {
        // Mirroring video stream.
        const sid = stream["streamConnectionID"];
        const sidStr = typeof sid === "bigint" ? sid.toString() : String(sid ?? "0");
        if (this.audioKey) this.parser.setKey(sidStr, this.audioKey);
        else this.emit("log", "Mirror SETUP without a session key — video cannot be decrypted");
        resStreams.push({ type: 110, dataPort: this.dataPort });
        // Open the mirror window now, at negotiation, rather than waiting for the first byte.
        this.started = true;
        this.emit("device", { name: this.clientName ?? "iPhone", address: this.clientAddress } satisfies AirplayDevice);
      } else if (type === 96) {
        resStreams.push({ type: 96, dataPort: 0, controlPort: 0 });
      }
    }
    plistReply({ streams: resStreams });
  }

  private listenData(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((sock) => this.handleDataConnection(sock));
      this.dataServer = server;
      server.once("error", reject);
      server.listen(0, "0.0.0.0", () => resolve((server.address() as net.AddressInfo).port));
    });
  }

  private handleDataConnection(sock: net.Socket): void {
    this.track(sock);
    this.started = true;
    sock.on("data", (chunk) => {
      let events: StreamEvent[];
      try {
        events = this.parser.push(chunk);
      } catch (e) {
        this.emit("log", `mirror stream error: ${(e as Error).message}`);
        return;
      }
      for (const ev of events) {
        if (ev.kind === "session") this.emit("device", { name: this.clientName ?? "iPhone", address: this.clientAddress, width: ev.width, height: ev.height });
        this.emit("video", ev);
      }
    });
    sock.on("error", () => undefined);
    sock.on("close", () => this.close());
  }

  private setClientName(name: string): void {
    if (name && name !== this.clientName) {
      this.clientName = name;
      this.emit("name", name);
    }
  }

  private infoPlist(): PlistValue {
    return {
      deviceid: deriveDeviceId(this.opts.name),
      features: 0x5a7ffff7,
      model: this.opts.model ?? "AppleTV3,2",
      name: this.opts.name,
      sourceVersion: "366.0",
      vv: 2,
      statusFlags: 68,
    };
  }

  close(err?: Error): void {
    if (!this.rtsp && !this.dataServer && !this.mdns) return;
    this.mdns?.stop();
    this.dataServer?.close();
    this.rtsp?.close();
    this.mdns = undefined;
    this.dataServer = undefined;
    this.rtsp = undefined;
    this.started = false;
    for (const sock of this.sockets) sock.destroy();
    this.sockets.clear();
    this.emit("close", err);
  }
}
