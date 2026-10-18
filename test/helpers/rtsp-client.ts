import net from "node:net";

export class RtspClient {
  private socket!: net.Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private cseq = 0;
  private pending: { resolve: (r: { status: number; body: Buffer }) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];
  async connect(port: number) {
    this.socket = net.connect(port, "127.0.0.1");
    this.socket.on("data", (data) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      for (;;) {
        const end = this.buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const headers = this.buffer.subarray(0, end).toString("latin1");
        const size = Number(/content-length:\s*(\d+)/i.exec(headers)?.[1] ?? 0);
        if (this.buffer.length < end + 4 + size) return;
        const body = Buffer.from(this.buffer.subarray(end + 4, end + 4 + size));
        this.buffer = this.buffer.subarray(end + 4 + size);
        const next = this.pending.shift();
        if (next) { clearTimeout(next.timer); next.resolve({ status: Number(headers.split(" ")[1]), body }); }
      }
    });
    this.socket.on("error", (e) => this.fail(e));
    this.socket.on("close", () => this.fail(new Error("RTSP client connection closed")));
    await new Promise<void>((resolve, reject) => { this.socket.once("connect", resolve); this.socket.once("error", reject); });
  }
  request(method: string, url: string, body: Buffer = Buffer.alloc(0), contentType = "application/octet-stream", extraHeaders: string[] = []) {
    return new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
      const timer = setTimeout(() => { this.close(); reject(new Error(`RTSP timed out: ${method} ${url}`)); }, 8000);
      this.pending.push({ resolve, reject, timer });
      const head = `${method} ${url} RTSP/1.0\r\nCSeq: ${++this.cseq}\r\nContent-Length: ${body.length}\r\n${body.length ? `Content-Type: ${contentType}\r\n` : ""}${extraHeaders.map((h) => h + "\r\n").join("")}\r\n`;
      this.socket.write(Buffer.concat([Buffer.from(head, "latin1"), body]));
    });
  }
  private fail(e: Error) { for (const p of this.pending.splice(0)) { clearTimeout(p.timer); p.reject(e); } }
  close() { this.socket?.destroy(); this.fail(new Error("RTSP client closed")); }
}
