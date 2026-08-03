import {
  cloneDefaultShortcutBindings,
  findShortcutConflicts,
  getShortcutAction,
  normalizeShortcutBindings,
  type ShortcutBindings,
} from "./shortcuts";
import {
  DEFAULT_TERMINAL_HISTORY_LINES,
  normalizeTerminalHistoryLineLimit,
} from "./terminalHistory";

export const SETTINGS_VERSION = 4;
export const SETTINGS_STORAGE_KEY = "tonymux.settings.v4";
export const LEGACY_SETTINGS_STORAGE_KEYS = [
  "tonymux.settings.v3",
  "tonymux.settings.v2",
  "tonymux.settings.v1",
] as const;

export const SHELL_PROFILES = [
  {
    id: "windows-powershell",
    label: "Windows PowerShell",
    executable: "powershell.exe",
    description: "Built-in Windows PowerShell 5.1",
  },
  {
    id: "powershell-7",
    label: "PowerShell 7",
    executable: "pwsh.exe",
    description: "Modern cross-platform PowerShell",
  },
  {
    id: "command-prompt",
    label: "Command Prompt",
    executable: "cmd.exe",
    description: "Classic Windows command processor",
  },
  {
    id: "wsl",
    label: "WSL",
    executable: "wsl.exe",
    description: "Default Windows Subsystem for Linux distribution",
  },
] as const;

export type ShellProfileId = (typeof SHELL_PROFILES)[number]["id"];
export type CursorStyle = "block" | "underline" | "bar";

export type TerminalAppearance = {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  scrollback: number;
};

export type WorkspacePersistenceSettings = {
  restoreWorkspaces: boolean;
  terminalHistoryLines: number;
};

export type AppSettings = {
  version: typeof SETTINGS_VERSION;
  defaultShellProfileId: ShellProfileId;
  defaultWorkingDirectory: string;
  startupCommand: string;
  terminal: TerminalAppearance;
  persistence: WorkspacePersistenceSettings;
  shortcuts: ShortcutBindings;
};

export type TerminalPaneSettings = {
  shellProfileId: ShellProfileId;
  workingDirectory: string;
  startupCommand: string;
  appearance: TerminalAppearance;
};

export const DEFAULT_SETTINGS: AppSettings = {
  version: SETTINGS_VERSION,
  defaultShellProfileId: "windows-powershell",
  defaultWorkingDirectory: "",
  startupCommand: "",
  terminal: {
    fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.25,
    cursorStyle: "bar",
    cursorBlink: true,
    scrollback: 10_000,
  },
  persistence: {
    restoreWorkspaces: true,
    terminalHistoryLines: DEFAULT_TERMINAL_HISTORY_LINES,
  },
  shortcuts: cloneDefaultShortcutBindings(),
};

export const DEFAULT_TERMINAL_PANE_SETTINGS: TerminalPaneSettings =
  snapshotTerminalSettings(DEFAULT_SETTINGS);

const PROFILE_IDS = new Set<ShellProfileId>(SHELL_PROFILES.map((profile) => profile.id));
const CURSOR_STYLES = new Set<CursorStyle>(["block", "underline", "bar"]);

function finiteNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function safeString(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === "string" ? value.slice(0, maxLength) : fallback;
}

export function normalizeTerminalAppearance(value: unknown): TerminalAppearance {
  const appearance = value as Partial<TerminalAppearance> | null;
  return {
    fontFamily: safeString(
      appearance?.fontFamily,
      DEFAULT_SETTINGS.terminal.fontFamily,
      256,
    ).trim() || DEFAULT_SETTINGS.terminal.fontFamily,
    fontSize: finiteNumber(
      appearance?.fontSize,
      DEFAULT_SETTINGS.terminal.fontSize,
      10,
      24,
    ),
    lineHeight: finiteNumber(
      appearance?.lineHeight,
      DEFAULT_SETTINGS.terminal.lineHeight,
      1,
      2,
    ),
    cursorStyle:
      typeof appearance?.cursorStyle === "string" &&
      CURSOR_STYLES.has(appearance.cursorStyle as CursorStyle)
        ? (appearance.cursorStyle as CursorStyle)
        : DEFAULT_SETTINGS.terminal.cursorStyle,
    cursorBlink:
      typeof appearance?.cursorBlink === "boolean"
        ? appearance.cursorBlink
        : DEFAULT_SETTINGS.terminal.cursorBlink,
    scrollback: Math.round(
      finiteNumber(
        appearance?.scrollback,
        DEFAULT_SETTINGS.terminal.scrollback,
        1_000,
        100_000,
      ),
    ),
  };
}

export function normalizeSettings(value: unknown): AppSettings {
  const candidate =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};

  const rawProfile = candidate.defaultShellProfileId ?? candidate.shellProfileId;
  const defaultShellProfileId =
    typeof rawProfile === "string" && PROFILE_IDS.has(rawProfile as ShellProfileId)
      ? (rawProfile as ShellProfileId)
      : DEFAULT_SETTINGS.defaultShellProfileId;

  const rawWorkingDirectory =
    candidate.defaultWorkingDirectory ?? candidate.workingDirectory;

  const persistence =
    candidate.persistence && typeof candidate.persistence === "object"
      ? (candidate.persistence as Record<string, unknown>)
      : {};

  return {
    version: SETTINGS_VERSION,
    defaultShellProfileId,
    defaultWorkingDirectory: safeString(rawWorkingDirectory, "", 1_024).trim(),
    startupCommand: safeString(candidate.startupCommand, "", 4_096).trim(),
    terminal: normalizeTerminalAppearance(candidate.terminal),
    persistence: {
      restoreWorkspaces:
        typeof persistence.restoreWorkspaces === "boolean"
          ? persistence.restoreWorkspaces
          : DEFAULT_SETTINGS.persistence.restoreWorkspaces,
      terminalHistoryLines: normalizeTerminalHistoryLineLimit(
        persistence.terminalHistoryLines,
      ),
    },
    shortcuts: normalizeShortcutBindings(candidate.shortcuts),
  };
}

export function normalizeTerminalPaneSettings(
  value: unknown,
  fallback: AppSettings = DEFAULT_SETTINGS,
): TerminalPaneSettings {
  const candidate =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const fallbackSnapshot = snapshotTerminalSettings(fallback);
  const shellProfileId =
    typeof candidate.shellProfileId === "string" &&
    PROFILE_IDS.has(candidate.shellProfileId as ShellProfileId)
      ? (candidate.shellProfileId as ShellProfileId)
      : fallbackSnapshot.shellProfileId;

  return {
    shellProfileId,
    workingDirectory: safeString(
      candidate.workingDirectory,
      fallbackSnapshot.workingDirectory,
      1_024,
    ).trim(),
    startupCommand: safeString(
      candidate.startupCommand,
      fallbackSnapshot.startupCommand,
      4_096,
    ).trim(),
    appearance: normalizeTerminalAppearance(
      candidate.appearance ?? fallbackSnapshot.appearance,
    ),
  };
}

export function snapshotTerminalSettings(
  settings: AppSettings,
  workspaceDirectory = "",
): TerminalPaneSettings {
  return {
    shellProfileId: settings.defaultShellProfileId,
    workingDirectory: workspaceDirectory || settings.defaultWorkingDirectory,
    startupCommand: settings.startupCommand,
    appearance: { ...settings.terminal },
  };
}

export function validateSettings(settings: AppSettings): string[] {
  const errors: string[] = [];
  if (/[\0\r\n]/.test(settings.defaultWorkingDirectory)) {
    errors.push("Default working directory must be a single path without control characters.");
  }
  if (/[\0\r\n]/.test(settings.startupCommand)) {
    errors.push("Startup command must be a single command without line breaks.");
  }
  if (!settings.terminal.fontFamily.trim()) {
    errors.push("Terminal font family is required.");
  }
  for (const conflict of findShortcutConflicts(settings.shortcuts)) {
    const labels = conflict.actionIds.map((actionId) => getShortcutAction(actionId).label);
    errors.push(`Shortcut ${conflict.binding} is assigned to both ${labels.join(" and ")}.`);
  }
  return errors;
}

function cloneDefaultSettings(): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    terminal: { ...DEFAULT_SETTINGS.terminal },
    persistence: { ...DEFAULT_SETTINGS.persistence },
    shortcuts: cloneDefaultShortcutBindings(),
  };
}

export function loadSettings(storage: Pick<Storage, "getItem"> = localStorage): AppSettings {
  try {
    const raw =
      storage.getItem(SETTINGS_STORAGE_KEY) ??
      LEGACY_SETTINGS_STORAGE_KEYS.map((key) => storage.getItem(key)).find(Boolean) ??
      null;
    if (!raw) return cloneDefaultSettings();

    const settings = normalizeSettings(JSON.parse(raw));
    if (findShortcutConflicts(settings.shortcuts).length > 0) {
      return { ...settings, shortcuts: cloneDefaultShortcutBindings() };
    }
    return settings;
  } catch {
    return cloneDefaultSettings();
  }
}

export function saveSettings(
  settings: AppSettings,
  storage: Pick<Storage, "setItem" | "removeItem"> = localStorage,
): void {
  storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(normalizeSettings(settings)));
  for (const key of LEGACY_SETTINGS_STORAGE_KEYS) storage.removeItem(key);
}

export function importSettings(raw: string): AppSettings {
  const parsed = JSON.parse(raw) as unknown;
  const settings = normalizeSettings(parsed);
  const errors = validateSettings(settings);
  if (errors.length) throw new Error(errors.join(" "));
  return settings;
}

export function exportSettings(settings: AppSettings): string {
  return `${JSON.stringify(normalizeSettings(settings), null, 2)}\n`;
}
