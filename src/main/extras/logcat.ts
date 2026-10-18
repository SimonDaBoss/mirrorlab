import type { ChildProcess } from "node:child_process";
import type { Adb } from "../adb";

export interface LogLine {
  t: number; // epoch ms (device clock)
  pid: number;
  tid: number;
  level: string; // V D I W E F
  tag: string;
  msg: string;
}

/** Parse one `logcat -v epoch` line: "  1697584000.123  1234  1250 I Tag: message". */
export function parseLogLine(line: string): LogLine | null {
  const m = /^\s*(\d+\.\d+)\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+(.*?)\s*:\s?(.*)$/.exec(line);
  if (!m) return null;
  return { t: Math.round(Number(m[1]) * 1000), pid: Number(m[2]), tid: Number(m[3]), level: m[4]!, tag: m[5]!, msg: m[6]! };
}

/** Streams logcat for one device into a ring buffer and batched callbacks. */
export class LogcatStream {
  private proc?: ChildProcess;
  private partial = "";
  readonly buffer: LogLine[] = [];
  private pendingBatch: LogLine[] = [];
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly adb: Adb,
    private readonly serial: string,
    private readonly onBatch: (lines: LogLine[]) => void,
    private readonly capacity = 5000,
  ) {}

  start(): void {
    if (this.proc) return;
    // -T 1: start from the most recent line, then follow.
    this.proc = this.adb.spawn(["-s", this.serial, "logcat", "-v", "epoch", "-T", "1"]);
    this.proc.stdout?.setEncoding("utf8");
    this.proc.stdout?.on("data", (chunk: string) => {
      const text = this.partial + chunk;
      const lines = text.split(/\r?\n/);
      this.partial = lines.pop() ?? "";
      for (const l of lines) {
        const p = parseLogLine(l);
        if (!p) continue;
        this.buffer.push(p);
        this.pendingBatch.push(p);
      }
      if (this.buffer.length > this.capacity) this.buffer.splice(0, this.buffer.length - this.capacity);
      this.timer ??= setTimeout(() => {
        this.timer = undefined;
        const batch = this.pendingBatch;
        this.pendingBatch = [];
        if (batch.length) this.onBatch(batch);
      }, 150);
    });
    this.proc.on("exit", () => (this.proc = undefined));
  }

  stop(): void {
    this.proc?.kill();
    this.proc = undefined;
  }

  /** Recent lines, optionally only from one app's processes. */
  async recent(opts: { lines?: number; packageName?: string; minLevel?: string } = {}): Promise<LogLine[]> {
    let lines = this.buffer;
    if (!this.proc || lines.length === 0) {
      const out = await this.adb.shell(this.serial, `logcat -d -v epoch -t ${opts.lines ?? 300}`);
      lines = out.split(/\r?\n/).map(parseLogLine).filter((x): x is LogLine => !!x);
    }
    if (opts.packageName) {
      const pids = (await this.adb.shell(this.serial, `pidof ${opts.packageName.replace(/[^\w.:]/g, "")}`).catch(() => ""))
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number);
      lines = lines.filter((l) => pids.includes(l.pid));
    }
    if (opts.minLevel) {
      const order = "VDIWEFA";
      const min = order.indexOf(opts.minLevel.toUpperCase());
      lines = lines.filter((l) => order.indexOf(l.level) >= min);
    }
    return lines.slice(-(opts.lines ?? 300));
  }
}

export function formatLog(l: LogLine): string {
  return `${new Date(l.t).toISOString().slice(11, 23)} ${String(l.pid).padStart(5)} ${l.level} ${l.tag}: ${l.msg}`;
}
