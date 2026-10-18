import { CodecId } from "../shared/protocol";
import type { WireStreamEvent } from "../shared/types";

/**
 * Opus (scrcpy default, 48 kHz stereo) → WebCodecs AudioDecoder → Web Audio.
 * A small jitter buffer keeps latency near 40–60 ms; if it drifts past
 * 250 ms (e.g. after a stall) it snaps back instead of lagging forever.
 */
export class AudioPipeline {
  readonly ctx = new AudioContext({ latencyHint: "interactive", sampleRate: 48000 });
  readonly gain = this.ctx.createGain();
  /** Tap for recordings. */
  readonly recordDest = this.ctx.createMediaStreamDestination();
  private decoder?: AudioDecoder;
  private nextTime = 0;
  private supported = true;
  active = false;
  played = 0;

  constructor() {
    this.gain.connect(this.ctx.destination);
    this.gain.connect(this.recordDest);
  }

  set muted(m: boolean) {
    this.gain.gain.value = m ? 0 : 1;
  }
  get muted() {
    return this.gain.gain.value === 0;
  }

  handle(ev: WireStreamEvent): void {
    if (ev.kind === "pcm") {
      const frames = ev.data.length / ev.channels;
      const buf = this.ctx.createBuffer(ev.channels, frames, ev.sampleRate);
      for (let ch = 0; ch < ev.channels; ch++) {
        const plane = buf.getChannelData(ch);
        for (let i = 0; i < frames; i++) plane[i] = ev.data[i * ev.channels + ch]!;
      }
      this.active = true;
      this.schedule(buf);
      return;
    }
    if (ev.kind === "codec") {
      this.supported = ev.codecId === CodecId.OPUS;
      return;
    }
    if (ev.kind !== "packet" || !this.supported) return;
    if (ev.config) {
      this.decoder?.close();
      this.decoder = new AudioDecoder({ output: (d) => this.play(d), error: (e) => console.warn("audio decoder", e) });
      // The config packet is an OpusHead (scrcpy strips Android's AOPUSHDR wrapper).
      this.decoder.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 2, description: ev.data });
      this.active = true;
      return;
    }
    if (this.decoder?.state !== "configured") return;
    this.decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: ev.pts ?? 0, data: ev.data }));
  }

  private play(data: AudioData) {
    if (this.ctx.state === "suspended") void this.ctx.resume();
    const buf = this.ctx.createBuffer(data.numberOfChannels, data.numberOfFrames, data.sampleRate);
    for (let ch = 0; ch < data.numberOfChannels; ch++) {
      const plane = new Float32Array(data.numberOfFrames);
      data.copyTo(plane, { planeIndex: ch, format: "f32-planar" });
      buf.copyToChannel(plane, ch);
    }
    data.close();
    this.schedule(buf);
  }

  private schedule(buf: AudioBuffer) {
    if (this.ctx.state === "suspended") void this.ctx.resume();
    const now = this.ctx.currentTime;
    if (this.nextTime < now + 0.02 || this.nextTime > now + 0.25) this.nextTime = now + 0.04;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    src.start(this.nextTime);
    this.nextTime += buf.duration;
    this.played++;
  }

  close() {
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    void this.ctx.close();
  }
}
