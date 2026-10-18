import { EventEmitter } from "node:events";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { NativeMediaServer } from "../airplay/media-bridge";

/** ready: capture filter loaded · replug: installed, needs a reconnect · missing: run USB setup */
export type UsbDriverState = "ready" | "replug" | "missing";
export interface UsbIphone { serial: string; name: string; model: string; osVersion: string; driver?: UsbDriverState; parentService?: string; captureError?: string }
export interface UsbSupport { runtimeAvailable: boolean; driverInstalled: boolean; error?: string }
export interface UsbDriverResult { ok: boolean; message: string; replug?: boolean }
const runtime = (resources: string) => path.join(resources, "usb", process.platform);
function helper(resources: string, args: string[]): Promise<string> {
  const dir = runtime(resources);
  return new Promise((resolve, reject) => execFile(path.join(dir, "iphone-usb.exe"), args, { cwd: dir, windowsHide: true, timeout: 12000, maxBuffer: 1024 * 1024 }, (e, out, err) => e ? reject(new Error(err.trim() || e.message)) : resolve(out)));
}
export async function usbSupport(resources: string): Promise<UsbSupport> {
  try { return JSON.parse(await helper(resources, ["--probe"])); }
  catch (e) { return { runtimeAvailable: false, driverInstalled: false, error: (e as Error).message }; }
}
export async function listUsbIphones(resources: string): Promise<UsbIphone[]> {
  try { return JSON.parse(await helper(resources, ["--list"])); }
  catch { return []; } // Apple Mobile Device Service may be absent; AirPlay remains available.
}

/**
 * Adds the signed libusb-win32 capture filter to this one iPhone (the same
 * per-device UpperFilter iPhoneMirror uses). Apple's own USB driver stays in
 * place. Runs elevated, so Windows shows an administrator prompt.
 */
export async function installUsbDriver(resources: string, serial: string, remove = false): Promise<UsbDriverResult> {
  if (process.platform !== "win32") throw new Error("USB capture setup is only available on Windows.");
  if (!/^[0-9A-Fa-f-]{16,48}$/.test(serial)) throw new Error("Select a connected iPhone.");
  const dir = runtime(resources);
  const script = path.join(dir, "usb-driver.ps1");
  for (const f of [script, "install-filter.exe", "libusb0.sys", "libusb0.dll"]) if (!fs.existsSync(path.resolve(dir, f))) throw new Error("USB driver files are missing. Rebuild the USB runtime (npm run build:usb).");
  const result = path.join(os.tmpdir(), `mirrorlab-usb-driver-${process.pid}-${Date.now()}.json`);
  const q = (s: string) => s.replace(/'/g, "''");
  const inner = `-NoProfile -ExecutionPolicy Bypass -File "${script}" -Serial "${serial}" -Result "${result}"${remove ? " -Remove" : ""}`;
  const command = `$p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '${q(inner)}'; exit $p.ExitCode`;
  await new Promise<void>((resolve, reject) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, timeout: 180000 }, (e, _out, err) => {
    if (e && !fs.existsSync(result)) reject(new Error(/cancel/i.test(err) ? "USB setup was cancelled at the administrator prompt." : (err.trim() || e.message)));
    else resolve();
  }));
  try { return JSON.parse(fs.readFileSync(result, "utf8").replace(/^﻿/, "")); }
  catch { throw new Error("USB setup did not report a result."); }
  finally { fs.rmSync(result, { force: true }); }
}

/** QuickTime capture runs in a separate native process using the libusb0 capture filter. */
export class UsbIphoneSession extends EventEmitter {
  private child?: ChildProcess;
  private media = new NativeMediaServer();
  private closed = false;
  private closePromise?: Promise<void>;
  private errorTail = "";
  private firstVideo = false;
  private watchdog?: ReturnType<typeof setTimeout>;
  constructor(private resources: string, readonly device: UsbIphone, private audioEnabled = true) { super(); }
  async start() {
    const support = await usbSupport(this.resources);
    if (!support.runtimeAvailable) throw new Error(support.error || "USB capture runtime is unavailable.");
    if (this.device.driver === "missing" || !support.driverInstalled) throw new Error("Set up USB for this iPhone first (Set up USB on its card).");
    if (this.device.driver === "replug") throw new Error("Unplug the iPhone and plug it back in to finish USB setup, then retry.");
    this.media.on("video", (ev) => {
      if (!this.firstVideo) {
        this.firstVideo = true; clearTimeout(this.watchdog);
        this.emit("device", { name: this.device.name, address: `usb:${this.device.serial}` });
      }
      this.emit("video", ev);
    });
    this.media.on("audio", (ev) => { if (this.audioEnabled) this.emit("audio", ev); });
    this.media.on("failure", (e) => void this.close(e));
    const port = await this.media.start();
    const dir = runtime(this.resources);
    const args = ["--capture", this.device.serial];
    if (!this.audioEnabled) args.push("--no-audio");
    this.child = spawn(path.join(dir, "iphone-usb.exe"), args, { cwd: dir, windowsHide: true, env: { ...process.env, MIRRORLAB_MEDIA_PORT: String(port), IPHONE_MIRROR_LOG_FILE: path.join(os.tmpdir(), "mirrorlab-usb.log") }, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr?.on("data", (chunk) => { this.errorTail = (this.errorTail + chunk.toString()).slice(-3000); });
    this.child.stdout?.on("data", (chunk) => this.emit("log", chunk.toString()));
    this.child.stdin?.on("error", () => undefined);
    this.child.once("error", (e) => void this.close(e));
    this.child.once("exit", (code) => { if (!this.closed) void this.close(new Error(this.lastError() || `iPhone USB capture ended (${code})`)); });
    // Activation re-enumerates the phone (up to ~18 s) before the handshake.
    this.watchdog = setTimeout(() => void this.close(new Error("No USB video arrived. Unlock your iPhone, accept Trust This Computer and retry.")), 45000);
  }
  private lastError() {
    const lines = this.errorTail.trim().split(/\r?\n/).filter((l) => !/^USB (handshake kick|restore):/.test(l));
    return lines.at(-1) ?? "";
  }
  close(error?: Error): Promise<void> {
    return this.closePromise ??= this.stop(error);
  }
  private async stop(error?: Error) {
    this.closed = true; clearTimeout(this.watchdog);
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      // The helper ends the QuickTime session and restores Apple's normal USB configuration before it exits.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { child.kill(); resolve(); }, 30000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        child.stdin?.end("stop\n");
      });
    }
    this.media.close();
    this.emit("close", error);
  }
}
