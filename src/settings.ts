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

export const SETTINGS_VERSION = 5;
export const SETTINGS_STORAGE_KEY = "tonymux.settings.v5";
export const LEGACY_SETTINGS_STORAGE_KEYS = [
  "tonymux.settings.v4",
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

export const MAX_CUSTOM_SHELL_PROFILES = 12;
export const MAX_CUSTOM_SHELL_LABEL_LENGTH = 64;
export const MAX_CUSTOM_SHELL_EXECUTABLE_LENGTH = 1_024;
export const CUSTOM_SHELL_PROFILE_ID_PATTERN = /^custom:[A-Za-z0-9_-]{8,80}$/;

export const MAX_SSH_PROFILES = 12;
export const MAX_SSH_LABEL_LENGTH = 64;
export const SSH_PROFILE_ID_PATTERN = /^ssh:[A-Za-z0-9_-]{8,80}$/;
export const SSH_HOST_PATTERN = /^[A-Za-z0-9._:-]{1,253}$/;
export const SSH_USER_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
export const MAX_SSH_IDENTITY_FILE_LENGTH = 1_024;

export type BuiltInShellProfileId = (typeof SHELL_PROFILES)[number]["id"];
export type ShellProfileId = string;
export type CursorStyle = "block" | "underline" | "bar";

export type CustomShellProfile = {
  id: string;
  label: string;
  executable: string;
};

export type SshProfile = {
  id: string;
  label: string;
  host: string;
  port: number;
  user: string;
  identityFile: string;
};

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
  customShellProfiles: CustomShellProfile[];
  sshProfiles: SshProfile[];
  defaultWorkingDirectory: string;
  startupCommand: string;
  terminal: TerminalAppearance;
  persistence: WorkspacePersistenceSettings;
  shortcuts: ShortcutBindings;
};

export type TerminalPaneSettings = {
  shellProfileId: ShellProfileId;
  customShellExecutable?: string;
  workingDirectory: string;
  startupCommand: string;
  appearance: TerminalAppearance;
};

export const DEFAULT_SETTINGS: AppSettings = {
  version: SETTINGS_VERSION,
  defaultShellProfileId: "windows-powershell",
  customShellProfiles: [],
  sshProfiles: [],
  defaultWorkingDirectory: "",
  startupCommand: "",
  terminal: {
    fontFamily: '"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
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

const BUILT_IN_PROFILE_IDS = new Set<BuiltInShellProfileId>(
  SHELL_PROFILES.map((profile) => profile.id),
);
const CURSOR_STYLES = new Set<CursorStyle>(["block", "underline", "bar"]);

function finiteNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function safeString(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === "string" ? value.slice(0, maxLength) : fallback;
}

export function isBuiltInShellProfileId(value: unknown): value is BuiltInShellProfileId {
  return typeof value === "string" && BUILT_IN_PROFILE_IDS.has(value as BuiltInShellProfileId);
}

export function validateCustomShellExecutable(value: string): string | null {
  // Reject C0 control characters in executable paths (newlines, NUL, etc.).
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(value)) {
    return "Executable path cannot contain control characters.";
  }
  const executable = value.trim().replaceAll("/", "\\");
  if (!executable) return "Executable path is required.";
  if (executable.length > MAX_CUSTOM_SHELL_EXECUTABLE_LENGTH) {
    return `Executable path must be at most ${MAX_CUSTOM_SHELL_EXECUTABLE_LENGTH} characters.`;
  }
  if (/[%"<>|?*]/.test(executable)) {
    return "Executable path cannot contain environment variables, quotes or wildcards.";
  }
  if (!/^[A-Za-z]:\\/.test(executable)) {
    return "Executable path must be an absolute local Windows path such as C:\\Tools\\shell.exe.";
  }
  if (executable.slice(2).includes(":")) {
    return "Executable path cannot contain an additional drive or stream separator.";
  }

  const segments = executable.slice(3).split("\\");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.endsWith(".") ||
        segment.endsWith(" "),
    )
  ) {
    return "Executable path contains an empty, relative or unsupported path segment.";
  }
  if (!segments.at(-1)?.toLowerCase().endsWith(".exe")) {
    return "Custom shell executable must end in .exe and cannot include arguments.";
  }
  return null;
}

export function normalizeCustomShellExecutable(value: unknown): string {
  if (typeof value !== "string" || validateCustomShellExecutable(value)) return "";
  const executable = value.trim().replaceAll("/", "\\");
  return `${executable[0].toUpperCase()}${executable.slice(1)}`;
}

function normalizeCustomShellProfiles(value: unknown): CustomShellProfile[] {
  if (!Array.isArray(value)) return [];

  const profiles: CustomShellProfile[] = [];
  const usedIds = new Set<string>();

  for (const candidateValue of value.slice(0, MAX_CUSTOM_SHELL_PROFILES)) {
    if (!candidateValue || typeof candidateValue !== "object") continue;
    const candidate = candidateValue as Record<string, unknown>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const label = safeString(candidate.label, "", MAX_CUSTOM_SHELL_LABEL_LENGTH).trim();
    const executable = normalizeCustomShellExecutable(candidate.executable);

    if (
      !CUSTOM_SHELL_PROFILE_ID_PATTERN.test(id) ||
      !label ||
      !executable ||
      usedIds.has(id)
    ) {
      continue;
    }

    usedIds.add(id);
    profiles.push({ id, label, executable });
  }

  return profiles;
}

export function validateSshHost(value: string): string | null {
  const host = value.trim();
  if (!host) return "Host is required.";
  if (!SSH_HOST_PATTERN.test(host)) {
    return "Host can only contain letters, digits, dots, dashes, underscores or colons.";
  }
  return null;
}

export function validateSshUser(value: string): string | null {
  const user = value.trim();
  if (!user) return "User is required.";
  if (!SSH_USER_PATTERN.test(user)) {
    return "User can only contain letters, digits, dots, dashes or underscores.";
  }
  return null;
}

export function validateSshPort(value: number): string | null {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    return "Port must be an integer between 1 and 65535.";
  }
  return null;
}

export function validateSshIdentityFile(value: string): string | null {
  const identityFile = value.trim();
  if (!identityFile) return null;
  // Reject C0 control characters in identity file paths.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(identityFile)) {
    return "Identity file path cannot contain control characters.";
  }
  if (identityFile.length > MAX_SSH_IDENTITY_FILE_LENGTH) {
    return `Identity file path must be at most ${MAX_SSH_IDENTITY_FILE_LENGTH} characters.`;
  }
  return null;
}

export function normalizeSshIdentityFile(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, MAX_SSH_IDENTITY_FILE_LENGTH);
}

function normalizeSshProfiles(value: unknown): SshProfile[] {
  if (!Array.isArray(value)) return [];

  const profiles: SshProfile[] = [];
  const usedIds = new Set<string>();

  for (const candidateValue of value.slice(0, MAX_SSH_PROFILES)) {
    if (!candidateValue || typeof candidateValue !== "object") continue;
    const candidate = candidateValue as Record<string, unknown>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const label = safeString(candidate.label, "", MAX_SSH_LABEL_LENGTH).trim();
    const host = typeof candidate.host === "string" ? candidate.host.trim() : "";
    const port =
      typeof candidate.port === "number" && Number.isInteger(candidate.port)
        ? candidate.port
        : 22;
    const user = typeof candidate.user === "string" ? candidate.user.trim() : "";
    const identityFile = normalizeSshIdentityFile(candidate.identityFile);

    if (
      !SSH_PROFILE_ID_PATTERN.test(id) ||
      !label ||
      validateSshHost(host) ||
      validateSshPort(port) ||
      validateSshUser(user) ||
      validateSshIdentityFile(identityFile) ||
      usedIds.has(id)
    ) {
      continue;
    }

    usedIds.add(id);
    profiles.push({ id, label, host, port, user, identityFile });
  }

  return profiles;
}

export function findSshProfile(
  settings: Pick<AppSettings, "sshProfiles">,
  profileId: string,
): SshProfile | undefined {
  return settings.sshProfiles.find((profile) => profile.id === profileId);
}

export function isSshProfileId(profileId: string): boolean {
  return SSH_PROFILE_ID_PATTERN.test(profileId);
}

export function findCustomShellProfile(
  settings: Pick<AppSettings, "customShellProfiles">,
  profileId: string,
): CustomShellProfile | undefined {
  return settings.customShellProfiles.find((profile) => profile.id === profileId);
}

export function countCustomShellProfilesUsingExecutable(
  settings: Pick<AppSettings, "customShellProfiles">,
  executable: string,
  excludeProfileId?: string,
): number {
  const key = normalizeCustomShellExecutable(executable).toLocaleLowerCase("en-US");
  if (!key) return 0;
  return settings.customShellProfiles.filter(
    (profile) =>
      profile.id !== excludeProfileId &&
      normalizeCustomShellExecutable(profile.executable).toLocaleLowerCase("en-US") === key,
  ).length;
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

  const customShellProfiles = normalizeCustomShellProfiles(candidate.customShellProfiles);
  const customProfileIds = new Set(customShellProfiles.map((profile) => profile.id));
  const sshProfiles = normalizeSshProfiles(candidate.sshProfiles);
  const sshProfileIds = new Set(sshProfiles.map((profile) => profile.id));
  const rawProfile = candidate.defaultShellProfileId ?? candidate.shellProfileId;
  const defaultShellProfileId =
    isBuiltInShellProfileId(rawProfile) ||
    (typeof rawProfile === "string" && customProfileIds.has(rawProfile)) ||
    (typeof rawProfile === "string" && sshProfileIds.has(rawProfile))
      ? rawProfile
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
    customShellProfiles,
    sshProfiles,
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

  let shellProfileId = fallbackSnapshot.shellProfileId;
  let customShellExecutable = fallbackSnapshot.customShellExecutable;

  if (isBuiltInShellProfileId(candidate.shellProfileId)) {
    shellProfileId = candidate.shellProfileId;
    customShellExecutable = undefined;
  } else if (
    typeof candidate.shellProfileId === "string" &&
    SSH_PROFILE_ID_PATTERN.test(candidate.shellProfileId)
  ) {
    shellProfileId = candidate.shellProfileId;
    customShellExecutable = undefined;
  } else if (
    typeof candidate.shellProfileId === "string" &&
    CUSTOM_SHELL_PROFILE_ID_PATTERN.test(candidate.shellProfileId)
  ) {
    const executable = normalizeCustomShellExecutable(candidate.customShellExecutable);
    if (executable) {
      shellProfileId = candidate.shellProfileId;
      customShellExecutable = executable;
    }
  }

  return {
    shellProfileId,
    ...(customShellExecutable ? { customShellExecutable } : {}),
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
  const customProfile = findCustomShellProfile(settings, settings.defaultShellProfileId);
  return {
    shellProfileId: customProfile?.id ?? settings.defaultShellProfileId,
    ...(customProfile ? { customShellExecutable: customProfile.executable } : {}),
    workingDirectory: workspaceDirectory || settings.defaultWorkingDirectory,
    startupCommand: settings.startupCommand,
    appearance: { ...settings.terminal },
  };
}

/**
 * Build terminal pane settings for an SSH profile. The returned settings carry
 * the SSH profile id in `shellProfileId` so `resolveSshConnection` can look the
 * connection up when spawning the pane. `cwd` is intentionally not applied:
 * the remote working directory is owned by the SSH session (the local `cwd`
 * would only affect the initial ssh.exe process).
 */
export function snapshotSshTerminalSettings(
  settings: AppSettings,
  profileId: string,
): TerminalPaneSettings {
  return {
    shellProfileId: profileId,
    workingDirectory: "",
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

  if (settings.customShellProfiles.length > MAX_CUSTOM_SHELL_PROFILES) {
    errors.push(`TonyMux supports at most ${MAX_CUSTOM_SHELL_PROFILES} custom shell profiles.`);
  }
  const ids = new Set<string>();
  for (const profile of settings.customShellProfiles) {
    if (!CUSTOM_SHELL_PROFILE_ID_PATTERN.test(profile.id)) {
      errors.push(`Custom shell profile ${profile.label || profile.id} has an invalid stable ID.`);
    }
    if (!profile.label.trim()) {
      errors.push("Every custom shell profile needs a display name.");
    } else if (profile.label.trim().length > MAX_CUSTOM_SHELL_LABEL_LENGTH) {
      errors.push(
        `Custom shell profile ${profile.label.trim()} exceeds ${MAX_CUSTOM_SHELL_LABEL_LENGTH} characters.`,
      );
    }
    const executableError = validateCustomShellExecutable(profile.executable);
    if (executableError) {
      errors.push(`${profile.label.trim() || "Custom shell"}: ${executableError}`);
    }
    if (ids.has(profile.id)) {
      errors.push(`Custom shell profile ID ${profile.id} is duplicated.`);
    }
    ids.add(profile.id);

  }

  if (
    !isBuiltInShellProfileId(settings.defaultShellProfileId) &&
    !settings.customShellProfiles.some((profile) => profile.id === settings.defaultShellProfileId)
  ) {
    errors.push("The selected shell profile no longer exists.");
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
    customShellProfiles: [],
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
  try {
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(normalizeSettings(settings)));
  } catch {
    // Storage may be unavailable/quota-limited in hardened WebView2 contexts.
    // The in-memory settings still apply for this session; persistence is best-effort.
  }
  for (const key of LEGACY_SETTINGS_STORAGE_KEYS) {
    try {
      storage.removeItem(key);
    } catch {
      // Non-fatal: cleanup of legacy keys is best-effort.
    }
  }
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
