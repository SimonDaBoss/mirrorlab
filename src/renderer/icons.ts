/** 24×24 stroke icons (drawn for Mirrorlab; Lucide-style geometry). */
const svg = (d: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

export const icons = {
  logo: svg('<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M2.5 8v8M21.5 8v8"/><path d="M10 18.5h4"/>'),
  back: svg('<path d="M15 6l-6 6 6 6"/>'),
  home: svg('<circle cx="12" cy="12" r="7"/>'),
  recents: svg('<rect x="6" y="6" width="12" height="12" rx="2"/>'),
  volUp: svg('<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M17 9.5a4 4 0 0 1 0 5M19.5 7a7.5 7.5 0 0 1 0 10"/>'),
  volDown: svg('<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M17 9.5a4 4 0 0 1 0 5"/>'),
  power: svg('<path d="M12 3v8"/><path d="M6.4 7.2a8 8 0 1 0 11.2 0"/>'),
  rotate: svg('<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/>'),
  camera: svg('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
  record: svg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5" fill="currentColor"/>'),
  screenOff: svg('<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M3 3l18 18"/>'),
  speaker: svg('<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M17 9.5a4 4 0 0 1 0 5"/>'),
  mute: svg('<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M17 9l5 5M22 9l-5 5"/>'),
  bell: svg('<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>'),
  inspect: svg('<path d="M4 4h6M4 4v6M20 4h-6M20 4v6M4 20h6M4 20v-6"/><path d="M13 13l7 7M13 13v5l1.5-1.5L17 19"/>'),
  logcat: svg('<path d="M4 6h16M4 12h10M4 18h13"/>'),
  timeline: svg('<path d="M6 3v18"/><circle cx="6" cy="7" r="2"/><circle cx="6" cy="17" r="2"/><path d="M10 7h10M10 17h8"/>'),
  agent: svg('<rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 3v4"/><circle cx="9" cy="13" r="1.2" fill="currentColor"/><circle cx="15" cy="13" r="1.2" fill="currentColor"/>'),
  pin: svg('<path d="M9 3h6l-1 6 4 3v2H6v-2l4-3z"/><path d="M12 14v7"/>'),
  fullscreen: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  usb: svg('<path d="M12 3v15"/><circle cx="12" cy="19.5" r="1.5"/><path d="M12 8l-4 3v2M12 11l4-2v-2"/><path d="M10 3h4"/>'),
  wifi: svg('<path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19" r="1" fill="currentColor"/>'),
  emulator: svg('<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/>'),
  copy: svg('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'),
};
