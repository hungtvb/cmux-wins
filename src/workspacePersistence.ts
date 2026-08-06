import {
  DEFAULT_SETTINGS,
  normalizeTerminalPaneSettings,
  snapshotTerminalSettings,
  type AppSettings,
} from "./settings";
import {
  MAX_TERMINAL_HISTORY_BYTES_PER_PANE,
  MAX_TERMINAL_HISTORY_BYTES_TOTAL,
  sanitizeTerminalHistory,
  terminalHistoryByteLength,
} from "./terminalHistory";
import type { Pane, Workspace } from "./types";

export const WORKSPACE_STATE_VERSION = 5 as const;
export const WORKSPACE_STATE_STORAGE_KEY = "tonymux.workspaces.v5";
export const WORKSPACE_STATE_PREVIOUS_KEY = "tonymux.workspaces.v5.previous";
export const LEGACY_WORKSPACE_STORAGE_KEYS = [
  "tonymux.workspaces.v4",
  "tonymux.workspaces.v4.previous",
  "tonymux.workspaces.v3",
  "tonymux.workspaces.v3.previous",
  "cmux-wins.workspaces.v2",
  "cmux-wins.workspaces.v1",
] as const;

export const DEFAULT_BROWSER_URL = "https://github.com";
export const MIN_SPLIT_RATIO = 28;
export const MAX_SPLIT_RATIO = 72;

const MAX_WORKSPACES = 32;
const MAX_PANES_PER_WORKSPACE = 16;
const MAX_TITLE_LENGTH = 128;
const MAX_CWD_LENGTH = 1_024;
const MAX_URL_LENGTH = 2_048;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type IdFactory = () => string;

type HistoryBudget = {
  remainingBytes: number;
};

export type WorkspaceState = {
  version: typeof WORKSPACE_STATE_VERSION;
  workspaces: Workspace[];
  activeWorkspaceId: string;
  activePaneByWorkspace: Record<string, string>;
  splitRatioByWorkspace: Record<string, number>;
};

export type WorkspaceStateLoadStatus =
  | "disabled"
  | "empty"
  | "current"
  | "recovered"
  | "migrated";

export type WorkspaceStateLoadResult = {
  state: WorkspaceState;
  status: WorkspaceStateLoadStatus;
};

function defaultIdFactory(): string {
  return crypto.randomUUID();
}

function boundedString(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/[\0\r\n]/g, " ").trim().slice(0, maxLength);
  return normalized || fallback;
}

function boundedOptionalString(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\0\r\n]/g, " ").trim().slice(0, maxLength);
}

function safeBrowserUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) return DEFAULT_BROWSER_URL;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      return DEFAULT_BROWSER_URL;
    }
    return url.toString();
  } catch {
    return DEFAULT_BROWSER_URL;
  }
}

function claimId(value: unknown, used: Set<string>, idFactory: IdFactory): string {
  let candidate = typeof value === "string" && ID_PATTERN.test(value) ? value : "";
  if (!candidate || used.has(candidate)) {
    do {
      candidate = idFactory();
    } while (!ID_PATTERN.test(candidate) || used.has(candidate));
  }
  used.add(candidate);
  return candidate;
}

function clampSplitRatio(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 50;
  return Math.round(Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, value)) * 100) / 100;
}

export function createTerminalPane(
  settings: AppSettings = DEFAULT_SETTINGS,
  workspaceDirectory = "",
  title = "PowerShell",
  idFactory: IdFactory = defaultIdFactory,
): Pane {
  return {
    id: idFactory(),
    kind: "terminal",
    title,
    terminalSettings: snapshotTerminalSettings(settings, workspaceDirectory),
  };
}

export function createBrowserPane(
  url = DEFAULT_BROWSER_URL,
  idFactory: IdFactory = defaultIdFactory,
): Pane {
  return {
    id: idFactory(),
    kind: "browser",
    title: "Browser",
    url: safeBrowserUrl(url),
  };
}

export function createWorkspace(
  settings: AppSettings = DEFAULT_SETTINGS,
  title = "Workspace",
  cwd = "",
  idFactory: IdFactory = defaultIdFactory,
): Workspace {
  const workspaceId = idFactory();
  return {
    id: workspaceId,
    title,
    cwd,
    panes: [createTerminalPane(settings, cwd, "PowerShell", idFactory)],
    unread: false,
  };
}

function normalizePane(
  value: unknown,
  settings: AppSettings,
  workspaceDirectory: string,
  usedPaneIds: Set<string>,
  historyBudget: HistoryBudget,
  idFactory: IdFactory,
): Pane {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const id = claimId(candidate.id, usedPaneIds, idFactory);
  const title = boundedString(candidate.title, candidate.kind === "browser" ? "Browser" : "PowerShell", MAX_TITLE_LENGTH);

  if (candidate.kind === "browser") {
    return {
      id,
      kind: "browser",
      title,
      url: safeBrowserUrl(candidate.url),
    };
  }

  const fallbackSnapshot = snapshotTerminalSettings(settings, workspaceDirectory);
  const historySnapshot = sanitizeTerminalHistory(
    candidate.historySnapshot,
    settings.persistence.terminalHistoryLines,
    Math.min(MAX_TERMINAL_HISTORY_BYTES_PER_PANE, historyBudget.remainingBytes),
  );
  historyBudget.remainingBytes -= terminalHistoryByteLength(historySnapshot);

  return {
    id,
    kind: "terminal",
    title,
    terminalSettings: normalizeTerminalPaneSettings(
      candidate.terminalSettings ?? fallbackSnapshot,
      settings,
    ),
    ...(historySnapshot ? { historySnapshot } : {}),
    restored: true,
  };
}

function normalizeWorkspace(
  value: unknown,
  settings: AppSettings,
  usedWorkspaceIds: Set<string>,
  usedPaneIds: Set<string>,
  historyBudget: HistoryBudget,
  idFactory: IdFactory,
): Workspace | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const id = claimId(candidate.id, usedWorkspaceIds, idFactory);
  const cwd = boundedOptionalString(candidate.cwd, MAX_CWD_LENGTH);
  const rawPanes = Array.isArray(candidate.panes)
    ? candidate.panes.slice(0, MAX_PANES_PER_WORKSPACE)
    : [];
  const panes = rawPanes.map((pane) =>
    normalizePane(pane, settings, cwd, usedPaneIds, historyBudget, idFactory),
  );

  return {
    id,
    title: boundedString(candidate.title, "Workspace", MAX_TITLE_LENGTH),
    cwd,
    panes: panes.length
      ? panes
      : [normalizePane({}, settings, cwd, usedPaneIds, historyBudget, idFactory)],
    unread: false,
  };
}

function candidateWorkspaces(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value.length ? value : null;
  if (!value || typeof value !== "object") return null;
  const workspaces = (value as Record<string, unknown>).workspaces;
  return Array.isArray(workspaces) && workspaces.length ? workspaces : null;
}

function normalizeCandidate(
  value: unknown,
  settings: AppSettings,
  idFactory: IdFactory,
): WorkspaceState | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const version = (value as Record<string, unknown>).version;
    if (typeof version === "number" && version > WORKSPACE_STATE_VERSION) return null;
  }

  const rawWorkspaces = candidateWorkspaces(value);
  if (!rawWorkspaces) return null;

  const usedWorkspaceIds = new Set<string>();
  const usedPaneIds = new Set<string>();
  const historyBudget: HistoryBudget = {
    remainingBytes: settings.persistence.terminalHistoryLines > 0
      ? MAX_TERMINAL_HISTORY_BYTES_TOTAL
      : 0,
  };
  const workspaces = rawWorkspaces
    .slice(0, MAX_WORKSPACES)
    .map((workspace) =>
      normalizeWorkspace(
        workspace,
        settings,
        usedWorkspaceIds,
        usedPaneIds,
        historyBudget,
        idFactory,
      ),
    )
    .filter((workspace): workspace is Workspace => workspace !== null);
  if (!workspaces.length) return null;

  const envelope = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  const requestedActiveWorkspaceId = envelope.activeWorkspaceId;
  const activeWorkspaceId =
    typeof requestedActiveWorkspaceId === "string" && workspaceIds.has(requestedActiveWorkspaceId)
      ? requestedActiveWorkspaceId
      : workspaces[0].id;

  const rawActivePanes =
    envelope.activePaneByWorkspace && typeof envelope.activePaneByWorkspace === "object"
      ? (envelope.activePaneByWorkspace as Record<string, unknown>)
      : {};
  const rawSplitRatios =
    envelope.splitRatioByWorkspace && typeof envelope.splitRatioByWorkspace === "object"
      ? (envelope.splitRatioByWorkspace as Record<string, unknown>)
      : {};
  const activePaneByWorkspace: Record<string, string> = {};
  const splitRatioByWorkspace: Record<string, number> = {};

  for (const workspace of workspaces) {
    const paneIds = new Set(workspace.panes.map((pane) => pane.id));
    const requestedPaneId = rawActivePanes[workspace.id];
    activePaneByWorkspace[workspace.id] =
      typeof requestedPaneId === "string" && paneIds.has(requestedPaneId)
        ? requestedPaneId
        : workspace.panes[0].id;
    splitRatioByWorkspace[workspace.id] = clampSplitRatio(rawSplitRatios[workspace.id]);
  }

  return {
    version: WORKSPACE_STATE_VERSION,
    workspaces,
    activeWorkspaceId,
    activePaneByWorkspace,
    splitRatioByWorkspace,
  };
}

export function createDefaultWorkspaceState(
  settings: AppSettings = DEFAULT_SETTINGS,
  idFactory: IdFactory = defaultIdFactory,
): WorkspaceState {
  const workspace = createWorkspace(settings, "Main", "", idFactory);
  return {
    version: WORKSPACE_STATE_VERSION,
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
    activePaneByWorkspace: { [workspace.id]: workspace.panes[0].id },
    splitRatioByWorkspace: { [workspace.id]: 50 },
  };
}

export function normalizeWorkspaceState(
  value: unknown,
  settings: AppSettings = DEFAULT_SETTINGS,
  idFactory: IdFactory = defaultIdFactory,
): WorkspaceState {
  return normalizeCandidate(value, settings, idFactory) ?? createDefaultWorkspaceState(settings, idFactory);
}

function parseStoredState(
  raw: string | null,
  settings: AppSettings,
  idFactory: IdFactory,
): WorkspaceState | null {
  if (!raw) return null;
  try {
    return normalizeCandidate(JSON.parse(raw) as unknown, settings, idFactory);
  } catch {
    return null;
  }
}

export function loadWorkspaceState(
  settings: AppSettings = DEFAULT_SETTINGS,
  storage: StorageLike = localStorage,
  idFactory: IdFactory = defaultIdFactory,
): WorkspaceStateLoadResult {
  if (!settings.persistence.restoreWorkspaces) {
    return { state: createDefaultWorkspaceState(settings, idFactory), status: "disabled" };
  }

  const current = parseStoredState(storage.getItem(WORKSPACE_STATE_STORAGE_KEY), settings, idFactory);
  if (current) return { state: current, status: "current" };

  const previous = parseStoredState(storage.getItem(WORKSPACE_STATE_PREVIOUS_KEY), settings, idFactory);
  if (previous) return { state: previous, status: "recovered" };

  for (const key of LEGACY_WORKSPACE_STORAGE_KEYS) {
    const migrated = parseStoredState(storage.getItem(key), settings, idFactory);
    if (migrated) return { state: migrated, status: "migrated" };
  }

  return { state: createDefaultWorkspaceState(settings, idFactory), status: "empty" };
}

export function clearWorkspaceState(storage: StorageLike = localStorage): void {
  storage.removeItem(WORKSPACE_STATE_STORAGE_KEY);
  storage.removeItem(WORKSPACE_STATE_PREVIOUS_KEY);
  for (const key of LEGACY_WORKSPACE_STORAGE_KEYS) storage.removeItem(key);
}

export function saveWorkspaceState(
  value: unknown,
  settings: AppSettings = DEFAULT_SETTINGS,
  storage: StorageLike = localStorage,
): void {
  if (!settings.persistence.restoreWorkspaces) {
    clearWorkspaceState(storage);
    return;
  }

  const normalized = normalizeWorkspaceState(value, settings);
  const currentRaw = storage.getItem(WORKSPACE_STATE_STORAGE_KEY);
  const current = parseStoredState(currentRaw, settings, defaultIdFactory);
  if (current) {
    storage.setItem(WORKSPACE_STATE_PREVIOUS_KEY, JSON.stringify(current));
  } else {
    const previous = parseStoredState(
      storage.getItem(WORKSPACE_STATE_PREVIOUS_KEY),
      settings,
      defaultIdFactory,
    );
    if (previous) storage.setItem(WORKSPACE_STATE_PREVIOUS_KEY, JSON.stringify(previous));
    else storage.removeItem(WORKSPACE_STATE_PREVIOUS_KEY);
  }
  storage.setItem(WORKSPACE_STATE_STORAGE_KEY, JSON.stringify(normalized));
  for (const key of LEGACY_WORKSPACE_STORAGE_KEYS) storage.removeItem(key);
}
