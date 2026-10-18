/** Android keycodes and KeyboardEvent.code → keycode mapping (values from android/keycodes.h). */

export const Keycode = {
  HOME: 3,
  BACK: 4,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  POWER: 26,
  CAMERA: 27,
  A: 29,
  TAB: 61,
  SPACE: 62,
  ENTER: 66,
  DEL: 67,
  MENU: 82,
  NOTIFICATION: 83,
  SEARCH: 84,
  MEDIA_PLAY_PAUSE: 85,
  MEDIA_NEXT: 87,
  MEDIA_PREVIOUS: 88,
  PAGE_UP: 92,
  PAGE_DOWN: 93,
  ESCAPE: 111,
  FORWARD_DEL: 112,
  MOVE_HOME: 122,
  MOVE_END: 123,
  INSERT: 124,
  F1: 131,
  VOLUME_MUTE: 164,
  APP_SWITCH: 187,
  BRIGHTNESS_DOWN: 220,
  BRIGHTNESS_UP: 221,
  SCREENSHOT: 120, // KEYCODE_SYSRQ triggers a device screenshot on most builds
} as const;

export const Meta = {
  SHIFT_ON: 0x01,
  ALT_ON: 0x02,
  SHIFT_LEFT_ON: 0x40,
  ALT_LEFT_ON: 0x10,
  CTRL_ON: 0x1000,
  CTRL_LEFT_ON: 0x2000,
  META_ON: 0x10000,
  META_LEFT_ON: 0x20000,
} as const;

const special: Record<string, number> = {
  Enter: Keycode.ENTER,
  NumpadEnter: Keycode.ENTER,
  Backspace: Keycode.DEL,
  Delete: Keycode.FORWARD_DEL,
  Tab: Keycode.TAB,
  Escape: Keycode.ESCAPE,
  ArrowUp: Keycode.DPAD_UP,
  ArrowDown: Keycode.DPAD_DOWN,
  ArrowLeft: Keycode.DPAD_LEFT,
  ArrowRight: Keycode.DPAD_RIGHT,
  Home: Keycode.MOVE_HOME,
  End: Keycode.MOVE_END,
  PageUp: Keycode.PAGE_UP,
  PageDown: Keycode.PAGE_DOWN,
  Insert: Keycode.INSERT,
  Space: Keycode.SPACE,
  ContextMenu: Keycode.MENU,
  AudioVolumeUp: Keycode.VOLUME_UP,
  AudioVolumeDown: Keycode.VOLUME_DOWN,
  AudioVolumeMute: Keycode.VOLUME_MUTE,
  MediaPlayPause: Keycode.MEDIA_PLAY_PAUSE,
  MediaTrackNext: Keycode.MEDIA_NEXT,
  MediaTrackPrevious: Keycode.MEDIA_PREVIOUS,
};

/** Keys whose effect is not text, so they go as keycodes rather than through text injection. */
export function keycodeForCode(code: string): number | undefined {
  if (code in special) return special[code];
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return Keycode.A + (m[1]!.charCodeAt(0) - 65);
  m = /^Digit(\d)$/.exec(code);
  if (m) return 7 + Number(m[1]); // KEYCODE_0 = 7
  m = /^F(\d{1,2})$/.exec(code);
  if (m && Number(m[1]) <= 12) return Keycode.F1 + Number(m[1]) - 1;
  return undefined;
}

export function metaState(e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): number {
  let m = 0;
  if (e.shiftKey) m |= Meta.SHIFT_ON | Meta.SHIFT_LEFT_ON;
  if (e.ctrlKey) m |= Meta.CTRL_ON | Meta.CTRL_LEFT_ON;
  if (e.altKey) m |= Meta.ALT_ON | Meta.ALT_LEFT_ON;
  if (e.metaKey) m |= Meta.META_ON | Meta.META_LEFT_ON;
  return m;
}

/** Named keys accepted by the agent API (press_key). */
export const namedKeys: Record<string, number> = {
  home: Keycode.HOME,
  back: Keycode.BACK,
  recents: Keycode.APP_SWITCH,
  app_switch: Keycode.APP_SWITCH,
  menu: Keycode.MENU,
  power: Keycode.POWER,
  volume_up: Keycode.VOLUME_UP,
  volume_down: Keycode.VOLUME_DOWN,
  mute: Keycode.VOLUME_MUTE,
  enter: Keycode.ENTER,
  delete: Keycode.DEL,
  backspace: Keycode.DEL,
  forward_delete: Keycode.FORWARD_DEL,
  tab: Keycode.TAB,
  escape: Keycode.ESCAPE,
  up: Keycode.DPAD_UP,
  down: Keycode.DPAD_DOWN,
  left: Keycode.DPAD_LEFT,
  right: Keycode.DPAD_RIGHT,
  search: Keycode.SEARCH,
  play_pause: Keycode.MEDIA_PLAY_PAUSE,
  camera: Keycode.CAMERA,
  brightness_up: Keycode.BRIGHTNESS_UP,
  brightness_down: Keycode.BRIGHTNESS_DOWN,
};
