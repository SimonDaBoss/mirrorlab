/** Types shared across main, preload and renderer. */

export interface Settings {
  maxSize: number; // 0 = native resolution
  videoBitRate: number; // bits/s
  maxFps: number; // 0 = unlimited
  audio: boolean;
  stayAwake: boolean;
  showTouches: boolean;
  turnScreenOff: boolean;
  alwaysOnTop: boolean;
  clipboardSync: boolean;
  agentEnabled: boolean;
  agentPort: number;
  agentToken: string;
  /** Agent may only act while you watch: actions require the device's mirror window to be open. */
  agentRequiresWindow: boolean;
  /** iOS AirPlay receiver: advertise over the network so iPhones can mirror to this PC. */
  iosEnabled: boolean;
  iosName: string;
  iosPort: number;
}

export const defaultSettings = (): Omit<Settings, "agentToken"> => ({
  maxSize: 1920,
  videoBitRate: 8_000_000,
  maxFps: 60,
  audio: true,
  stayAwake: true,
  showTouches: false,
  turnScreenOff: false,
  alwaysOnTop: false,
  clipboardSync: true,
  agentEnabled: true,
  agentPort: 47800,
  agentRequiresWindow: true,
  iosEnabled: true,
  iosName: "Mirrorlab",
  iosPort: 7000,
});

/** Main → mirror window stream events (BigInt pts converted to number µs). */
export type WireStreamEvent =
  | { kind: "pcm"; sampleRate: number; channels: number; data: Float32Array }
  | { kind: "codec"; codecId: number }
  | { kind: "session"; width: number; height: number }
  | { kind: "packet"; config: boolean; keyFrame: boolean; pts: number | null; data: Uint8Array; rotation?: number };

export interface UiNode {
  id: number;
  depth: number;
  className: string;
  text: string;
  resourceId: string;
  contentDesc: string;
  packageName: string;
  clickable: boolean;
  scrollable: boolean;
  focusable: boolean;
  enabled: boolean;
  /** Bounds in mirror-video coordinates (the same space as screenshots and tap). */
  bounds: [number, number, number, number];
}

export interface TimelineEntry {
  t: number; // epoch ms
  source: "user" | "agent" | "system";
  kind: string; // tap | swipe | text | key | note | screenshot | app | ...
  detail: string;
  screenshot?: string; // file name inside the timeline folder
}

export interface DoctorReport {
  adbPath: string;
  adbSource: string;
  adbVersion?: string;
  adbError?: string;
  serverJar: string;
  serverJarOk: boolean;
  notes: string[];
}
