import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export interface AdbDevice {
  serial: string;
  state: string; // device | unauthorized | offline | ...
  model?: string;
  product?: string;
  transportId?: string;
  /** "usb" | "wifi" | "emulator" — best effort from serial format. */
  kind: "usb" | "wifi" | "emulator";
}

export interface AdbResult {
  stdout: Buffer;
  stderr: string;
}

export class AdbError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly stderr: string,
  ) {
    super(message);
  }
}

/**
 * Where to find adb, in priority order:
 *   1. MIRRORLAB_ADB environment variable
 *   2. Bundled adb (resources/adb/<platform>/adb[.exe])
 *   3. adb on PATH
 * A path ending in .js/.mjs runs under Node — used by the test device emulator.
 */
export function resolveAdb(resourcesDir: string): { file: string; source: "env" | "bundled" | "path" } {
  const env = process.env.MIRRORLAB_ADB;
  if (env) return { file: env, source: "env" };
  const exe = process.platform === "win32" ? "adb.exe" : "adb";
  const bundled = path.join(resourcesDir, "adb", process.platform, exe);
  if (existsSync(bundled)) return { file: bundled, source: "bundled" };
  return { file: exe, source: "path" };
}

/**
 * Thin adb wrapper. Every call is a fixed argv — never a host shell — so
 * device serials, paths and package names can't inject host commands.
 * Values forwarded to the *device* shell are quoted with shellQuote().
 */
export class Adb {
  constructor(readonly file: string) {}

  private command(args: string[]): [string, string[]] {
    if (/\.m?js$/.test(this.file)) return [process.execPath, [this.file, ...args]];
    return [this.file, args];
  }

  run(args: string[], opts: { timeoutMs?: number; input?: Buffer } = {}): Promise<AdbResult> {
    const [cmd, argv] = this.command(args);
    return new Promise((resolve, reject) => {
      const child = execFile(
        cmd,
        argv,
        {
          encoding: "buffer",
          maxBuffer: 256 * 1024 * 1024,
          timeout: opts.timeoutMs ?? 30_000,
          windowsHide: true,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        },
        (err, stdout, stderr) => {
          const errText = stderr.toString("utf8");
          if (err) {
            const msg = errText.trim() || stdout.toString("utf8").trim() || err.message;
            reject(new AdbError(`adb ${args.join(" ")}: ${msg}`, args, errText));
          } else resolve({ stdout, stderr: errText });
        },
      );
      if (opts.input) child.stdin?.end(opts.input);
    });
  }

  async text(args: string[], timeoutMs?: number): Promise<string> {
    return (await this.run(args, { timeoutMs })).stdout.toString("utf8");
  }

  /** Long-running adb process (server, logcat). */
  spawn(args: string[]): ChildProcess {
    const [cmd, argv] = this.command(args);
    return spawn(cmd, argv, { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  }

  async version(): Promise<string> {
    const out = await this.text(["version"], 10_000);
    return out.split(/\r?\n/)[0]?.trim() ?? out.trim();
  }

  async devices(): Promise<AdbDevice[]> {
    return parseDevices(await this.text(["devices", "-l"], 15_000));
  }

  shell(serial: string, command: string, timeoutMs?: number): Promise<string> {
    return this.text(["-s", serial, "shell", command], timeoutMs);
  }

  async execOut(serial: string, command: string, timeoutMs?: number): Promise<Buffer> {
    return (await this.run(["-s", serial, "exec-out", command], { timeoutMs })).stdout;
  }

  async push(serial: string, local: string, remote: string): Promise<void> {
    await this.run(["-s", serial, "push", local, remote], { timeoutMs: 120_000 });
  }

  async install(serial: string, apk: string): Promise<string> {
    return this.text(["-s", serial, "install", "-r", "-g", apk], 300_000);
  }

  /** Allocate a local TCP port forwarded to a device abstract socket; returns the port. */
  async forward(serial: string, remote: string): Promise<number> {
    const out = (await this.text(["-s", serial, "forward", "tcp:0", remote])).trim();
    const port = Number.parseInt(out, 10);
    if (!Number.isFinite(port) || port <= 0) throw new AdbError(`Unexpected forward output: ${out}`, [], "");
    return port;
  }

  async removeForward(serial: string, port: number): Promise<void> {
    await this.run(["-s", serial, "forward", "--remove", `tcp:${port}`]).catch(() => undefined);
  }

  connect(hostPort: string): Promise<string> {
    return this.text(["connect", hostPort], 20_000);
  }

  disconnect(hostPort: string): Promise<string> {
    return this.text(["disconnect", hostPort], 10_000);
  }

  pair(hostPort: string, code: string): Promise<string> {
    return this.text(["pair", hostPort, code], 30_000);
  }

  async mdnsServices(): Promise<string> {
    return this.text(["mdns", "services"], 10_000);
  }

  /** Switch a USB device to TCP/IP and connect to it over Wi-Fi. Returns host:port. */
  async switchToWifi(serial: string, port = 5555): Promise<string> {
    const ip = parseWlanIp(await this.shell(serial, "ip -f inet addr show wlan0"));
    if (!ip) throw new AdbError("Could not find the device's Wi-Fi IP address — is Wi-Fi on?", [], "");
    await this.text(["-s", serial, "tcpip", String(port)]);
    const target = `${ip}:${port}`;
    // The adb daemon restarts; give it a moment.
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const out = await this.connect(target).catch((e: Error) => e.message);
      if (/connected to/.test(out)) return target;
    }
    throw new AdbError(`Could not connect to ${target}`, [], "");
  }
}

export function parseDevices(out: string): AdbDevice[] {
  const devices: AdbDevice[] = [];
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("List of devices") || t.startsWith("*")) continue;
    const [serial, state, ...rest] = t.split(/\s+/);
    if (!serial || !state) continue;
    const d: AdbDevice = { serial, state, kind: deviceKind(serial) };
    for (const kv of rest) {
      const [k, v] = kv.split(":");
      if (k === "model") d.model = v?.replace(/_/g, " ");
      else if (k === "product") d.product = v;
      else if (k === "transport_id") d.transportId = v;
    }
    devices.push(d);
  }
  return devices;
}

function deviceKind(serial: string): AdbDevice["kind"] {
  if (serial.startsWith("emulator-")) return "emulator";
  if (/^127\.0\.0\.1:|^localhost:/.test(serial)) return "emulator"; // LDPlayer, BlueStacks, etc.
  if (/:\d+$/.test(serial) || serial.includes("._adb-tls-connect.")) return "wifi";
  return "usb";
}

export function parseWlanIp(out: string): string | null {
  const m = out.match(/inet (\d+\.\d+\.\d+\.\d+)/);
  return m ? m[1]! : null;
}

/** Quote a value for the Android (mksh/toybox) shell. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
