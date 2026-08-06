export const OPEN_SETTINGS_EVENT = "tonymux-open-settings";

export function requestOpenSettings(): void {
  window.dispatchEvent(new Event(OPEN_SETTINGS_EVENT));
}
