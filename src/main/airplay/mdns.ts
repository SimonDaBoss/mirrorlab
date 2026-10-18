import dgram from "node:dgram";
import os from "node:os";

/**
 * Minimal multicast-DNS responder that advertises an AirPlay receiver so an
 * iPhone lists it under Screen Mirroring. It announces `_airplay._tcp` (and
 * `_raop._tcp` for audio) with the TXT records iOS expects, and answers the
 * PTR/SRV/TXT/A queries for them. This is a focused responder, not a general
 * mDNS stack; it coexists with Bonjour because it only answers our own names.
 */
const MDNS_ADDR = "224.0.0.251";
const MDNS_PORT = 5353;

export interface AirplayService {
  name: string; // friendly name shown on the iPhone, e.g. "Mirrorlab"
  port: number; // RTSP port
  deviceId: string; // "AA:BB:CC:DD:EE:FF"
  features: string; // hex feature bits, e.g. "0x5A7FFFF7,0x1E"
  model?: string;
  publicKey?: Buffer; // Ed25519 public key (for pairing); optional for the data-path build
}

function encodeName(name: string): Buffer {
  const parts = name.split(".").filter(Boolean);
  const bufs = parts.map((p) => {
    const b = Buffer.from(p, "utf8");
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  return Buffer.concat([...bufs, Buffer.from([0])]);
}

function encodeTxt(records: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(records)) {
    const s = Buffer.from(`${k}=${v}`, "utf8");
    parts.push(Buffer.from([s.length]), s);
  }
  if (!parts.length) parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/** Build a DNS answer resource record. */
function record(name: Buffer, type: number, data: Buffer, ttl = 4500, flush = true): Buffer {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(flush ? 0x8001 : 0x0001, 2); // IN class, cache-flush bit
  head.writeUInt32BE(ttl, 4);
  head.writeUInt16BE(data.length, 8);
  return Buffer.concat([name, head, data]);
}

export class MdnsAdvertiser {
  private socket?: dgram.Socket;
  private announceTimer?: NodeJS.Timeout;
  private svc?: AirplayService;

  start(svc: AirplayService): void {
    this.svc = svc;
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.socket = socket;
    socket.on("message", (msg) => this.onQuery(msg));
    socket.on("error", () => undefined);
    socket.bind(MDNS_PORT, () => {
      try {
        socket.addMembership(MDNS_ADDR);
        socket.setMulticastTTL(255);
      } catch {
        /* interface may not support multicast */
      }
      this.announce();
      // Re-announce a couple of times so the iPhone sees us promptly.
      let n = 0;
      this.announceTimer = setInterval(() => {
        this.announce();
        if (++n >= 3) clearInterval(this.announceTimer);
      }, 1000);
    });
  }

  private localIPv4(): string {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
    }
    return "127.0.0.1";
  }

  /** The full answer set for our services, reused for announcements and query replies. */
  private answers(): Buffer {
    const svc = this.svc!;
    const host = `${svc.name.replace(/\s+/g, "-")}.local`;
    const ip = this.localIPv4();
    const airplayType = encodeName("_airplay._tcp.local");
    const airplayInstance = encodeName(`${svc.name}._airplay._tcp.local`);
    const raopType = encodeName("_raop._tcp.local");
    const raopId = svc.deviceId.replace(/:/g, "");
    const raopInstance = encodeName(`${raopId}@${svc.name}._raop._tcp.local`);
    const hostName = encodeName(host);

    const srv = (target: Buffer, port: number) => {
      const b = Buffer.alloc(6);
      b.writeUInt16BE(0, 0); // priority
      b.writeUInt16BE(0, 2); // weight
      b.writeUInt16BE(port, 4);
      return Buffer.concat([b, target]);
    };
    const aData = Buffer.from(ip.split(".").map(Number));

    const airplayTxt = encodeTxt({
      deviceid: svc.deviceId,
      features: svc.features,
      model: svc.model ?? "AppleTV3,2",
      srcvers: "366.0",
      flags: "0x4",
      vv: "2",
      pi: "aabbccdd-eeff-0011-2233-445566778899",
      pk: (svc.publicKey ?? Buffer.alloc(32)).toString("hex"),
    });
    const raopTxt = encodeTxt({
      txtvers: "1",
      ch: "2",
      cn: "0,1,2,3",
      et: "0,3,5",
      sv: "false",
      da: "true",
      sr: "44100",
      ss: "16",
      vn: "65537",
      tp: "UDP",
      vs: "366.0",
      am: svc.model ?? "AppleTV3,2",
      sf: "0x4",
      ft: svc.features,
      pk: (svc.publicKey ?? Buffer.alloc(32)).toString("hex"),
    });

    return Buffer.concat([
      record(airplayType, 12, airplayInstance, 4500, false), // PTR
      record(airplayInstance, 33, srv(hostName, svc.port)), // SRV
      record(airplayInstance, 16, airplayTxt), // TXT
      record(raopType, 12, raopInstance, 4500, false), // PTR
      record(raopInstance, 33, srv(hostName, svc.port)), // SRV
      record(raopInstance, 16, raopTxt), // TXT
      record(hostName, 1, aData), // A
    ]);
  }

  private announce(): void {
    if (!this.socket || !this.svc) return;
    const answers = this.answers();
    const header = Buffer.alloc(12);
    header.writeUInt16BE(0, 0); // id
    header.writeUInt16BE(0x8400, 2); // response, authoritative
    header.writeUInt16BE(0, 4); // questions
    header.writeUInt16BE(7, 6); // answers (count must match answers())
    const packet = Buffer.concat([header, answers]);
    this.socket.send(packet, MDNS_PORT, MDNS_ADDR, () => undefined);
  }

  /** Reply to queries that mention our service types. */
  private onQuery(msg: Buffer): void {
    if (!this.svc) return;
    const flags = msg.length >= 4 ? msg.readUInt16BE(2) : 0;
    if (flags & 0x8000) return; // a response, not a query
    const text = msg.toString("latin1");
    if (text.includes("_airplay") || text.includes("_raop")) this.announce();
  }

  stop(): void {
    clearInterval(this.announceTimer);
    try {
      this.socket?.close();
    } catch {
      /* already closed */
    }
    this.socket = undefined;
  }
}

/** A stable pseudo-MAC derived from the host, for the deviceid TXT field. */
export function deriveDeviceId(seed = os.hostname()): string {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const bytes = [0x02, (h >> 24) & 0xff, (h >> 16) & 0xff, (h >> 8) & 0xff, h & 0xff, 0x01];
  return bytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(":");
}
