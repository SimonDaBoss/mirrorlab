/**
 * AirPlay speaks HTTP/1.1-shaped RTSP over one TCP socket: a request line
 * (METHOD url RTSP/1.0), headers, and a Content-Length body. This is a small
 * incremental parser plus a response builder.
 */
export interface RtspRequest {
  method: string;
  url: string;
  protocol: string;
  headers: Record<string, string>;
  body: Buffer;
}

export class RtspParser {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): RtspRequest[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: RtspRequest[] = [];
    for (;;) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) break;
      const head = this.buf.subarray(0, headerEnd).toString("latin1");
      const lines = head.split("\r\n");
      const [method = "", url = "", protocol = ""] = lines[0]!.split(" ");
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const i = line.indexOf(":");
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      const contentLength = Number(headers["content-length"] ?? 0);
      const bodyStart = headerEnd + 4;
      if (this.buf.length < bodyStart + contentLength) break;
      out.push({ method, url, protocol, headers, body: this.buf.subarray(bodyStart, bodyStart + contentLength) });
      this.buf = this.buf.subarray(bodyStart + contentLength);
    }
    return out;
  }
}

export interface RtspResponse {
  status?: number;
  statusText?: string;
  cseq?: string;
  headers?: Record<string, string>;
  body?: Buffer;
  contentType?: string;
}

const STATUS_TEXT: Record<number, string> = { 200: "OK", 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 453: "Not Enough Bandwidth", 500: "Internal Server Error" };

export function buildResponse(r: RtspResponse): Buffer {
  const status = r.status ?? 200;
  const lines = [`RTSP/1.0 ${status} ${r.statusText ?? STATUS_TEXT[status] ?? "OK"}`];
  if (r.cseq !== undefined) lines.push(`CSeq: ${r.cseq}`);
  lines.push("Server: AirTunes/366.0");
  if (r.body && r.body.length) {
    lines.push(`Content-Type: ${r.contentType ?? "application/octet-stream"}`);
    lines.push(`Content-Length: ${r.body.length}`);
  }
  for (const [k, v] of Object.entries(r.headers ?? {})) lines.push(`${k}: ${v}`);
  lines.push("", "");
  const head = Buffer.from(lines.join("\r\n"), "latin1");
  return r.body && r.body.length ? Buffer.concat([head, r.body]) : head;
}

export const PLIST_CONTENT_TYPE = "application/x-apple-binary-plist";
