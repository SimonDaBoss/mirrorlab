import { h264CodecString } from "../shared/protocol";
import type { WireStreamEvent } from "../shared/types";

export interface VideoStats {
  fps: number;
  decoded: number;
  dropped: number;
  width: number;
  height: number;
  codec: string;
}

/**
 * H.264 Annex-B → WebCodecs → canvas. iOS preserves compressed references and
 * paces decoded output by timestamps, absorbing short bursts with 32 ms lead.
 * Android can additionally request keyframes to recover from decoder backlog.
 */
export class VideoPipeline {
  private decoder?: VideoDecoder;
  private codec = "";
  private config?: Uint8Array;
  private needKey = true;
  private latest?: VideoFrame;
  private presentation: VideoFrame[] = [];
  private presentationOrigin?: number;
  private rotations = new Map<number, number>();
  private frameRotations = new WeakMap<VideoFrame, number>();
  private rafPending = false;
  private ctx: CanvasRenderingContext2D;
  private frameCount = 0;
  private lastFpsAt = performance.now();
  readonly stats: VideoStats = { fps: 0, decoded: 0, dropped: 0, width: 0, height: 0, codec: "" };
  size?: { width: number; height: number };
  onResize?: (w: number, h: number) => void;
  onFirstFrame?: () => void;
  private gotFirst = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly requestKeyframe: () => void,
    private readonly preserveReferences = false,
  ) {
    const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
    if (!ctx) throw new Error("Canvas 2D unavailable");
    this.ctx = ctx;
  }

  handle(ev: WireStreamEvent): void {
    if (ev.kind === "session") {
      this.size = { width: ev.width, height: ev.height };
      this.stats.width = ev.width;
      this.stats.height = ev.height;
      if (this.canvas.width !== ev.width || this.canvas.height !== ev.height) {
        this.canvas.width = ev.width;
        this.canvas.height = ev.height;
      }
      this.onResize?.(ev.width, ev.height);
      return;
    }
    if (ev.kind !== "packet") return;
    if (ev.config) {
      this.config = ev.data;
      const codec = h264CodecString(ev.data) ?? "avc1.42e01f";
      if (codec !== this.codec || !this.decoder || this.decoder.state === "closed") this.configure(codec);
      this.needKey = true;
      return;
    }
    const dec = this.decoder;
    if (!dec || dec.state !== "configured") return;
    if (this.needKey && !ev.keyFrame) {
      this.stats.dropped++;
      return;
    }
    if (!this.preserveReferences && dec.decodeQueueSize > 6 && !ev.keyFrame) {
      // Falling behind (slow decoder or a stall): skip to the next keyframe.
      this.stats.dropped++;
      if (!this.needKey) {
        this.needKey = true;
        this.requestKeyframe();
      }
      return;
    }
    let data = ev.data;
    if (ev.keyFrame && this.config) {
      const merged = new Uint8Array(this.config.length + data.length);
      merged.set(this.config, 0);
      merged.set(data, this.config.length);
      data = merged;
    }
    this.needKey = false;
    try {
      this.rotations.set(ev.pts ?? 0, ev.rotation ?? 0);
      dec.decode(new EncodedVideoChunk({ type: ev.keyFrame ? "key" : "delta", timestamp: ev.pts ?? 0, data }));
    } catch (e) {
      console.warn("decode failed", e);
      this.recover();
    }
  }

  private configure(codec: string) {
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    this.codec = codec;
    this.stats.codec = codec;
    this.decoder = new VideoDecoder({
      output: (frame) => this.onFrame(frame),
      error: (e) => {
        console.warn("decoder error", e);
        this.recover();
      },
    });
    // Annex-B: no `description`; SPS/PPS travel in-band with keyframes.
    // "no-preference" lets Chromium use the GPU decoder when one exists.
    this.decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: "no-preference" });
  }

  private recover() {
    this.needKey = true;
    if (this.decoder?.state === "closed" && this.codec) this.configure(this.codec);
    this.requestKeyframe();
  }

  private onFrame(frame: VideoFrame) {
    this.frameRotations.set(frame, this.rotations.get(frame.timestamp) ?? 0);
    this.rotations.delete(frame.timestamp);
    this.stats.decoded++;
    if (this.preserveReferences) {
      const now = performance.now();
      this.presentationOrigin ??= now + 32 - frame.timestamp / 1000;
      this.presentation.push(frame);
      // Bound latency by dropping decoded output, preserving every H.264 reference.
      const due = this.presentationOrigin + frame.timestamp / 1000;
      if (this.presentation.length > 8 || now - due > 100 || due - now > 150) {
        while (this.presentation.length > 2) { this.presentation.shift()!.close(); this.stats.dropped++; }
        this.presentationOrigin = now + 16 - this.presentation[0]!.timestamp / 1000;
      }
    } else {
      this.latest?.close();
      this.latest = frame;
    }
    if (!this.rafPending) {
      this.rafPending = true;
      requestAnimationFrame(() => this.draw());
    }
  }

  private draw() {
    this.rafPending = false;
    let f = this.latest;
    if (this.preserveReferences) {
      const now = performance.now();
      while (this.presentation.length && this.presentationOrigin! + this.presentation[0]!.timestamp / 1000 <= now + 2) {
        if (f) { f.close(); this.stats.dropped++; }
        f = this.presentation.shift();
      }
      if (this.presentation.length) {
        this.rafPending = true;
        requestAnimationFrame(() => this.draw());
      }
    }
    if (!f) return;
    this.latest = undefined;
    const rotation = this.frameRotations.get(f) ?? 0;
    const width = rotation % 2 ? f.displayHeight : f.displayWidth;
    const height = rotation % 2 ? f.displayWidth : f.displayHeight;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    if (this.size?.width !== width || this.size?.height !== height) {
      this.size = { width, height }; this.stats.width = width; this.stats.height = height;
      this.onResize?.(width, height);
    }
    if (rotation) {
      this.ctx.save(); this.ctx.translate(width / 2, height / 2); this.ctx.rotate(rotation * Math.PI / 2);
      this.ctx.drawImage(f, -f.displayWidth / 2, -f.displayHeight / 2, f.displayWidth, f.displayHeight);
      this.ctx.restore();
    } else this.ctx.drawImage(f, 0, 0, width, height);
    f.close();
    this.frameCount++;
    const now = performance.now();
    if (now - this.lastFpsAt >= 1000) {
      this.stats.fps = Math.round((this.frameCount * 1000) / (now - this.lastFpsAt));
      this.frameCount = 0;
      this.lastFpsAt = now;
    }
    if (!this.gotFirst) {
      this.gotFirst = true;
      this.onFirstFrame?.();
    }
  }

  /** PNG of the last drawn frame, scaled so the longest edge ≤ maxDim. */
  async snapshot(maxDim = 0): Promise<Uint8Array> {
    if (!this.gotFirst) return new Uint8Array(0);
    const { width, height } = this.canvas;
    const k = maxDim > 0 ? Math.min(1, maxDim / Math.max(width, height)) : 1;
    let src: HTMLCanvasElement = this.canvas;
    if (k < 1) {
      src = document.createElement("canvas");
      src.width = Math.round(width * k);
      src.height = Math.round(height * k);
      src.getContext("2d")!.drawImage(this.canvas, 0, 0, src.width, src.height);
    }
    const blob = await new Promise<Blob | null>((r) => src.toBlob(r, "image/png"));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array(0);
  }

  close() {
    this.latest?.close();
    this.latest = undefined;
    for (const frame of this.presentation.splice(0)) frame.close();
    this.presentationOrigin = undefined;
    this.rotations.clear();
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
  }

  reset() {
    this.close();
    this.latest = undefined;
    this.decoder = undefined;
    this.config = undefined;
    this.codec = "";
    this.needKey = true;
    this.gotFirst = false;
  }
}
