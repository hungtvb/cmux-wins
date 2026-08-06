export const BROWSER_PANE_EVENT_NAME = "browser-pane-event";

const MAX_PANE_ID_LENGTH = 128;
const MAX_BROWSER_URL_LENGTH = 2_048;
const MAX_BROWSER_TITLE_CHARS = 128;
const MAX_BROWSER_MESSAGE_CHARS = 512;
const PANE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export type BrowserPaneEventKind =
  | "load-started"
  | "load-finished"
  | "title-changed"
  | "navigation-blocked"
  | "new-window-blocked"
  | "download-blocked";

export type BrowserPaneEvent = {
  paneId: string;
  kind: BrowserPaneEventKind;
  url?: string;
  title?: string;
  message?: string;
};

export type BrowserPaneFeedback = {
  tone: "notice" | "error";
  message: string;
  retryable: boolean;
};

const EVENT_KINDS = new Set<BrowserPaneEventKind>([
  "load-started",
  "load-finished",
  "title-changed",
  "navigation-blocked",
  "new-window-blocked",
  "download-blocked",
]);

function boundedText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  // Strip C0 control characters, DEL, and Unicode directional isolates
  // before persisting anything derived from a URL.
  // eslint-disable-next-line no-control-regex
  const normalized = value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ").trim();
  if (!normalized) return undefined;
  return Array.from(normalized).slice(0, maxChars).join("");
}

export function normalizeBrowserEventUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_BROWSER_URL_LENGTH) return undefined;

  try {
    const parsed = new URL(value);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    ) {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function normalizeBrowserPaneEvent(value: unknown): BrowserPaneEvent | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const paneId = boundedText(candidate.paneId, MAX_PANE_ID_LENGTH);
  const kind = candidate.kind;

  if (!paneId || !PANE_ID_PATTERN.test(paneId)) return null;
  if (typeof kind !== "string" || !EVENT_KINDS.has(kind as BrowserPaneEventKind)) {
    return null;
  }

  const event: BrowserPaneEvent = {
    paneId,
    kind: kind as BrowserPaneEventKind,
  };
  const url = normalizeBrowserEventUrl(candidate.url);
  const title = boundedText(candidate.title, MAX_BROWSER_TITLE_CHARS);
  const message = boundedText(candidate.message, MAX_BROWSER_MESSAGE_CHARS);

  if (url) event.url = url;
  if (title) event.title = title;
  if (message) event.message = message;
  return event;
}

export function feedbackForBrowserEvent(
  event: BrowserPaneEvent,
): BrowserPaneFeedback | null {
  switch (event.kind) {
    case "navigation-blocked":
      return {
        tone: "notice",
        message: event.message ?? "TonyMux blocked this browser navigation.",
        retryable: false,
      };
    case "new-window-blocked":
      return {
        tone: "notice",
        message: event.message ?? "TonyMux blocked a popup or new-window request.",
        retryable: false,
      };
    case "download-blocked":
      return {
        tone: "notice",
        message: event.message ?? "TonyMux blocked a browser download.",
        retryable: false,
      };
    default:
      return null;
  }
}
