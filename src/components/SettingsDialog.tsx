import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Database,
  Download,
  Keyboard,
  Network,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings2,
  ShieldCheck,
  ShieldX,
  TerminalSquare,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import type { AgentKind } from "../resumeModel";
import {
  DEFAULT_SETTINGS,
  MAX_CUSTOM_SHELL_PROFILES,
  MAX_SSH_PROFILES,
  SHELL_PROFILES,
  countCustomShellProfilesUsingExecutable,
  exportSettings,
  findCustomShellProfile,
  importSettings,
  normalizeCustomShellExecutable,
  normalizeSettings,
  validateCustomShellExecutable,
  validateSettings,
  validateSshHost,
  validateSshIdentityFile,
  validateSshPort,
  validateSshUser,
  type AppSettings,
  type CustomShellProfile,
  type CursorStyle,
  type SshProfile,
} from "../settings";
import {
  DEFAULT_SHORTCUT_BINDINGS,
  SHORTCUT_ACTIONS,
  findShortcutConflict,
  formatShortcutBinding,
  getShortcutAction,
  shortcutFromKeyboardEvent,
  type ShortcutActionId,
} from "../shortcuts";
import { MAX_TERMINAL_HISTORY_LINES } from "../terminalHistory";
import { ConfirmDialog } from "./ConfirmDialog";

type SettingsDialogProps = {
  open: boolean;
  settings: AppSettings;
  onSave: (settings: AppSettings) => void;
  onClearWorkspaceState: () => void;
  onClose: () => void;
};

function cloneSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    customShellProfiles: settings.customShellProfiles.map((profile) => ({ ...profile })),
    sshProfiles: settings.sshProfiles.map((profile) => ({ ...profile })),
    terminal: { ...settings.terminal },
    persistence: { ...settings.persistence },
    shortcuts: { ...settings.shortcuts },
  };
}

type TrustedExecutableStatus = "trusted" | "changed" | "missing" | "unavailable";

type AgentHooksSetupResult = {
  agent: AgentKind;
  scriptPath: string;
  configPath: string;
  message: string;
};

const AGENT_SETUP_INFO: {
  agent: AgentKind;
  title: string;
  description: string;
}[] = [
  {
    agent: "claude",
    title: "Claude Code",
    description: "Stop + SessionEnd hooks save the resume command after every turn and at session end.",
  },
  {
    agent: "codex",
    title: "Codex",
    description: "SessionEnd hook writes the resume command within Codex's 3s teardown budget.",
  },
  {
    agent: "opencode",
    title: "opencode",
    description: "Global plugin records sessions from session idle events.",
  },
];

type TrustedExecutableSnapshot = {
  executable: string;
  sha256: string;
  sizeBytes: number;
  status: TrustedExecutableStatus;
  detail: string | null;
};

type TrustedShellStoreSnapshot = {
  healthy: boolean;
  error: string | null;
  entries: TrustedExecutableSnapshot[];
};

type TrustState = {
  store: TrustedShellStoreSnapshot;
  profiles: Record<string, boolean>;
};

const EMPTY_TRUST_STORE: TrustedShellStoreSnapshot = {
  healthy: true,
  error: null,
  entries: [],
};

async function queryTrustState(profiles: CustomShellProfile[]): Promise<TrustState> {
  const [store, profileEntries] = await Promise.all([
    invoke<TrustedShellStoreSnapshot>("get_trusted_shell_store").catch((cause) => ({
      healthy: false,
      error: String(cause),
      entries: [],
    })),
    Promise.all(
      profiles.map(async (profile) => {
        if (validateCustomShellExecutable(profile.executable)) {
          return [profile.id, false] as const;
        }
        try {
          const trusted = await invoke<boolean>("is_shell_executable_trusted", {
            executable: profile.executable,
          });
          return [profile.id, trusted] as const;
        } catch {
          return [profile.id, false] as const;
        }
      }),
    ),
  ]);
  return { store, profiles: Object.fromEntries(profileEntries) };
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (const nextUnit of units.slice(1)) {
    if (value < 1024) break;
    value /= 1024;
    unit = nextUnit;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

export function SettingsDialog({
  open,
  settings,
  onSave,
  onClearWorkspaceState,
  onClose,
}: SettingsDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const historyHelpId = useId();
  const shortcutsHelpId = useId();
  const shortcutsStatusId = useId();
  const trustStoreStatusId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const errorSummaryRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const trustQueryGenerationRef = useRef(0);
  const [draft, setDraft] = useState(() => cloneSettings(settings));
  const draftRef = useRef(draft);
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [recordingActionId, setRecordingActionId] = useState<ShortcutActionId | null>(null);
  const [shortcutError, setShortcutError] = useState("");
  const [trustedExecutables, setTrustedExecutables] = useState<Record<string, boolean>>({});
  const [trustStore, setTrustStore] = useState<TrustedShellStoreSnapshot>(EMPTY_TRUST_STORE);
  const [trustStoreLoading, setTrustStoreLoading] = useState(false);
  const [trustPendingId, setTrustPendingId] = useState<string | null>(null);
  const [trustStorePendingPath, setTrustStorePendingPath] = useState<string | null>(null);
  const [trustStatus, setTrustStatus] = useState("");
  const [agentSetupStatus, setAgentSetupStatus] = useState<
    Record<string, string | AgentHooksSetupResult>
  >({});
  const [agentSetupBusy, setAgentSetupBusy] = useState<Record<string, boolean>>({});

  const installAgentHooks = async (agent: AgentKind) => {
    setAgentSetupBusy((busy) => ({ ...busy, [agent]: true }));
    setAgentSetupStatus((status) => ({ ...status, [agent]: "Installing…" }));
    try {
      const result = await invoke<AgentHooksSetupResult>("setup_agent_hooks", { agent });
      setAgentSetupStatus((status) => ({ ...status, [agent]: result }));
    } catch (error) {
      setAgentSetupStatus((status) => ({
        ...status,
        [agent]: `Failed to install: ${String(error)}`,
      }));
    } finally {
      setAgentSetupBusy((busy) => ({ ...busy, [agent]: false }));
    }
  };

  const clearResumeRecords = async () => {
    setConfirmRequest({
      title: "Clear resume sessions",
      message: "Clear every saved agent resume session?",
      confirmLabel: "Clear",
      danger: true,
      action: async () => {
        await invoke<number>("clear_all_resume_records").catch(() => undefined);
      },
    });
  };

  const [confirmRequest, setConfirmRequest] = useState<{
    title: string;
    message: string;
    confirmLabel?: string;
    danger?: boolean;
    action: () => void | Promise<void>;
  } | null>(null);

  const [trustedOrigins, setTrustedOrigins] = useState<string[]>([]);
  const [originInput, setOriginInput] = useState("");
  const [originNotice, setOriginNotice] = useState<string | null>(null);
  const [originBusy, setOriginBusy] = useState(false);

  const refreshTrustedOrigins = useCallback(async () => {
    try {
      const snapshot = await invoke<{ healthy: boolean; error: string | null; origins: string[] }>(
        "get_trusted_browser_origins",
      );
      setTrustedOrigins(snapshot.origins ?? []);
      setOriginNotice(snapshot.error ? `Store error: ${snapshot.error}` : null);
    } catch (error) {
      setOriginNotice(`Failed to load trusted browser origins: ${String(error)}`);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refreshTrustedOrigins();
  }, [open, refreshTrustedOrigins]);

  const addTrustedOrigin = async () => {
    const candidate = originInput.trim();
    if (!candidate) return;
    setOriginBusy(true);
    setOriginNotice(null);
    try {
      await invoke("trust_browser_origin", { origin: candidate });
      setOriginInput("");
      await refreshTrustedOrigins();
    } catch (error) {
      setOriginNotice(String(error));
    } finally {
      setOriginBusy(false);
    }
  };

  const revokeTrustedOrigin = async (origin: string) => {
    setOriginBusy(true);
    setOriginNotice(null);
    try {
      await invoke("revoke_browser_origin", { origin });
      await refreshTrustedOrigins();
    } catch (error) {
      setOriginNotice(String(error));
    } finally {
      setOriginBusy(false);
    }
  };

  const clearTrustedOrigins = async () => {
    setConfirmRequest({
      title: "Clear trusted origins",
      message: "Remove every trusted browser origin?",
      confirmLabel: "Clear",
      danger: true,
      action: async () => {
        setOriginBusy(true);
        setOriginNotice(null);
        try {
          await invoke<number>("clear_trusted_browser_origins");
          await refreshTrustedOrigins();
        } catch (error) {
          setOriginNotice(String(error));
        } finally {
          setOriginBusy(false);
        }
      },
    });
  };

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      requestAnimationFrame(() => returnFocusRef.current?.focus());
    };
  }, [open]);

  useEffect(() => {
    if (!open || errors.length === 0) return;
    requestAnimationFrame(() => errorSummaryRef.current?.focus());
  }, [errors, open]);

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    setDraft(cloneSettings(settings));
    setErrors([]);
    setNotice("");
    setSaving(false);
    setRecordingActionId(null);
    setShortcutError("");
    setTrustPendingId(null);
    setTrustStorePendingPath(null);
    setTrustStoreLoading(true);
    setTrustStatus("");
    const trustQueryGeneration = ++trustQueryGenerationRef.current;
    void queryTrustState(settings.customShellProfiles).then((trustState) => {
      if (!disposed && trustQueryGeneration === trustQueryGenerationRef.current) {
        setTrustedExecutables(trustState.profiles);
        setTrustStore(trustState.store);
        setTrustStoreLoading(false);
      }
    });
    requestAnimationFrame(() => {
      dialogRef.current
        ?.querySelector<HTMLElement>(
          'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"])',
        )
        ?.focus();
    });
    return () => {
      disposed = true;
    };
  }, [open, settings]);

  if (!open) return null;

  const updateTerminal = <Key extends keyof AppSettings["terminal"]>(
    key: Key,
    value: AppSettings["terminal"][Key],
  ) => {
    setDraft((current) => ({
      ...current,
      terminal: { ...current.terminal, [key]: value },
    }));
  };

  const refreshTrustState = async (
    profiles: CustomShellProfile[] = draftRef.current.customShellProfiles,
    successMessage?: string,
  ) => {
    const generation = ++trustQueryGenerationRef.current;
    setTrustStoreLoading(true);
    const trustState = await queryTrustState(profiles);
    if (generation !== trustQueryGenerationRef.current) return;
    setTrustedExecutables(trustState.profiles);
    setTrustStore(trustState.store);
    setTrustStoreLoading(false);
    if (successMessage) setTrustStatus(successMessage);
  };

  const addCustomShellProfile = () => {
    if (draft.customShellProfiles.length >= MAX_CUSTOM_SHELL_PROFILES) return;
    trustQueryGenerationRef.current += 1;
    setTrustStoreLoading(false);
    const profile: CustomShellProfile = {
      id: `custom:${crypto.randomUUID()}`,
      label: "Custom shell",
      executable: "",
    };
    setDraft((current) => ({
      ...current,
      // Only adopt the new profile as default when there is no default yet
      // (or the current default is the empty "system default"). Adding a
      // profile must not silently hijack a user's existing choice.
      defaultShellProfileId: current.defaultShellProfileId || profile.id,
      customShellProfiles: [...current.customShellProfiles, profile],
    }));
    setTrustedExecutables((current) => ({ ...current, [profile.id]: false }));
    setTrustStatus("Add an absolute .exe path, then explicitly trust it before saving.");
  };

  const updateCustomShellProfile = (
    profileId: string,
    key: "label" | "executable",
    value: string,
  ) => {
    setDraft((current) => ({
      ...current,
      customShellProfiles: current.customShellProfiles.map((profile) =>
        profile.id === profileId ? { ...profile, [key]: value } : profile,
      ),
    }));
    if (key === "executable") {
      trustQueryGenerationRef.current += 1;
      setTrustStoreLoading(false);
      setTrustedExecutables((current) => ({ ...current, [profileId]: false }));
      setTrustStatus("Executable path changed. Trust must be granted again.");
    }
  };

  const removeCustomShellProfile = async (profileId: string) => {
      const currentDraft = draftRef.current;
      const profile = currentDraft.customShellProfiles.find((candidate) => candidate.id === profileId);
      if (!profile) return;
      const executable = normalizeCustomShellExecutable(profile.executable);
      const otherReferences = countCustomShellProfilesUsingExecutable(
        currentDraft,
        executable,
        profileId,
      );

      const doRemove = () => {
        const remainingProfiles = currentDraft.customShellProfiles.filter(
          (candidate) => candidate.id !== profileId,
        );
        const nextDraft = {
          ...currentDraft,
          defaultShellProfileId:
            currentDraft.defaultShellProfileId === profileId
              ? DEFAULT_SETTINGS.defaultShellProfileId
              : currentDraft.defaultShellProfileId,
          customShellProfiles: remainingProfiles,
        };
        setDraft(nextDraft);
        draftRef.current = nextDraft;
        setTrustPendingId(null);
        setTrustStatus(`Removed ${profile.label || "profile"}.`);
      };

      if (executable && otherReferences === 0 && trustStore.healthy) {
        setConfirmRequest({
          title: "Remove profile and revoke trust",
          message: `Remove ${profile.label || "this profile"} and revoke any trust record for ${executable}? Existing terminal processes will keep running.`,
          confirmLabel: "Remove",
          danger: true,
          action: async () => {
            setTrustPendingId(profileId);
            try {
              await invoke<boolean>("revoke_shell_executable", { executable });
            } catch (cause) {
              setTrustStatus(`Unable to revoke ${executable}: ${String(cause)}`);
              setTrustPendingId(null);
              return;
            }
            doRemove();
          },
        });
      } else {
        doRemove();
      }
  };

  const trustCustomShellProfile = async (profile: CustomShellProfile) => {
    const executableError = validateCustomShellExecutable(profile.executable);
    if (executableError) {
      setTrustStatus(`${profile.label || "Custom shell"}: ${executableError}`);
      return;
    }

    const executable = normalizeCustomShellExecutable(profile.executable);
    const trustQueryGeneration = ++trustQueryGenerationRef.current;
    setTrustPendingId(profile.id);
    setTrustStatus(`Trusting ${profile.label || "custom shell"}…`);
    try {
      const trusted = await invoke<boolean>("trust_shell_executable", { executable });
      if (!trusted) throw new Error("TonyMux did not persist the trust decision.");
      const currentProfile = draftRef.current.customShellProfiles.find(
        (candidate) => candidate.id === profile.id,
      );
      if (
        trustQueryGeneration !== trustQueryGenerationRef.current ||
        normalizeCustomShellExecutable(currentProfile?.executable) !== executable
      ) {
        setTrustStatus(
          `${profile.label || "Custom shell"} changed while trust was being saved. Review and trust the current path again.`,
        );
        return;
      }
      const currentDraft = draftRef.current;
      const nextProfiles = currentDraft.customShellProfiles.map((candidate) =>
        candidate.id === profile.id ? { ...candidate, executable } : candidate,
      );
      const nextDraft = { ...currentDraft, customShellProfiles: nextProfiles };
      setDraft(nextDraft);
      draftRef.current = nextDraft;
      await refreshTrustState(
        nextProfiles,
        `${profile.label || "Custom shell"} is trusted by SHA-256 identity on this Windows account.`,
      );
    } catch (cause) {
      setTrustedExecutables((current) => ({ ...current, [profile.id]: false }));
      setTrustStatus(`Unable to trust ${profile.label || "custom shell"}: ${String(cause)}`);
    } finally {
      setTrustPendingId(null);
    }
  };

  const addSshProfile = () => {
    if (draft.sshProfiles.length >= MAX_SSH_PROFILES) return;
    const profile: SshProfile = {
      id: `ssh:${crypto.randomUUID()}`,
      label: "SSH host",
      host: "",
      port: 22,
      user: "",
      identityFile: "",
    };
    setDraft((current) => ({
      ...current,
      // Preserve an existing default: adding an SSH host must not silently
      // change what the user already chose as their default shell.
      defaultShellProfileId: current.defaultShellProfileId || profile.id,
      sshProfiles: [...current.sshProfiles, profile],
    }));
  };

  const updateSshProfile = (
    profileId: string,
    key: "label" | "host" | "user" | "identityFile",
    value: string,
  ) => {
    setDraft((current) => ({
      ...current,
      sshProfiles: current.sshProfiles.map((profile) =>
        profile.id === profileId ? { ...profile, [key]: value } : profile,
      ),
    }));
  };

  const updateSshProfilePort = (profileId: string, value: string) => {
    // Only commit a parseable port. An empty/invalid input keeps the
    // previous value so the model never holds an unusable 0 that would
    // trip validateSshPort and silently block Save.
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) return;
    setDraft((current) => ({
      ...current,
      sshProfiles: current.sshProfiles.map((profile) =>
        profile.id === profileId ? { ...profile, port: parsed } : profile,
      ),
    }));
  };

  const removeSshProfile = (profileId: string) => {
    const currentDraft = draftRef.current;
    const nextDraft = {
      ...currentDraft,
      defaultShellProfileId:
        currentDraft.defaultShellProfileId === profileId
          ? DEFAULT_SETTINGS.defaultShellProfileId
          : currentDraft.defaultShellProfileId,
      sshProfiles: currentDraft.sshProfiles.filter((candidate) => candidate.id !== profileId),
    };
    setDraft(nextDraft);
    draftRef.current = nextDraft;
  };

  const revokeTrustedExecutable = async (entry: TrustedExecutableSnapshot) => {
    setConfirmRequest({
      title: "Revoke trust",
      message: `Revoke trust for ${entry.executable}? New terminal panes cannot launch it until trusted again.`,
      confirmLabel: "Revoke",
      danger: true,
      action: async () => {
        setTrustStorePendingPath(entry.executable);
        setTrustStatus(`Revoking ${entry.executable}…`);
        try {
          await invoke<boolean>("revoke_shell_executable", { executable: entry.executable });
          await refreshTrustState(
            draftRef.current.customShellProfiles,
            `Trust revoked for ${entry.executable}.`,
          );
        } catch (cause) {
          setTrustStatus(`Unable to revoke ${entry.executable}: ${String(cause)}`);
        } finally {
          setTrustStorePendingPath(null);
        }
      },
    });
  };

  const clearTrustedExecutables = async () => {
    const healthy = trustStore.healthy;
    setConfirmRequest({
      title: healthy ? "Clear trusted executables" : "Reset trust store",
      message: healthy
        ? "Clear every trusted custom executable? All custom profiles must be trusted again before launch."
        : "Reset the unreadable trust store? Existing trust decisions will be discarded.",
      confirmLabel: healthy ? "Clear" : "Reset",
      danger: true,
      action: async () => {
        setTrustStorePendingPath("*");
        setTrustStatus(healthy ? "Clearing trusted executables…" : "Resetting trust store…");
        try {
          const removed = await invoke<number>("clear_trusted_shell_executables");
          await refreshTrustState(
            draftRef.current.customShellProfiles,
            healthy
              ? `Cleared ${removed} trusted executable${removed === 1 ? "" : "s"}.`
              : "Trust store reset. Custom executables must be trusted again.",
          );
        } catch (cause) {
          setTrustStatus(`Unable to reset trusted executables: ${String(cause)}`);
        } finally {
          setTrustStorePendingPath(null);
        }
      },
    });
  };

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && recordingActionId) {
      event.preventDefault();
      setRecordingActionId(null);
      setShortcutError("");
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const save = async () => {
    if (saving) return;
    const nextErrors = validateSettings(draft);
    setErrors(nextErrors);
    if (nextErrors.length) return;

    const normalized = normalizeSettings(draft);
    const selectedCustomProfile = findCustomShellProfile(
      normalized,
      normalized.defaultShellProfileId,
    );
    if (selectedCustomProfile) {
      setSaving(true);
      try {
        const trusted = await invoke<boolean>("is_shell_executable_trusted", {
          executable: selectedCustomProfile.executable,
        });
        setTrustedExecutables((current) => ({
          ...current,
          [selectedCustomProfile.id]: trusted,
        }));
        if (!trusted) {
          setErrors([
            `${selectedCustomProfile.label} must be explicitly trusted before it can be the default shell.`,
          ]);
          setSaving(false);
          return;
        }
      } catch (cause) {
        setErrors([`Unable to verify custom shell trust: ${String(cause)}`]);
        setSaving(false);
        return;
      }
    }

    setSaving(false);
    onSave(normalized);
    onClose();
  };

  const reset = () => {
    setDraft(cloneSettings(DEFAULT_SETTINGS));
    setErrors([]);
    setNotice("");
    setRecordingActionId(null);
    setShortcutError("");
    trustQueryGenerationRef.current += 1;
    setTrustedExecutables({});
    setTrustStore(EMPTY_TRUST_STORE);
    setTrustStoreLoading(false);
    setTrustPendingId(null);
    setTrustStorePendingPath(null);
    setTrustStatus("");
  };

  const resetShortcuts = () => {
    setDraft((current) => ({
      ...current,
      shortcuts: { ...DEFAULT_SHORTCUT_BINDINGS },
    }));
    setRecordingActionId(null);
    setShortcutError("");
    setNotice("Keyboard shortcuts reset to TonyMux defaults.");
  };

  const clearShortcut = (actionId: ShortcutActionId) => {
    setDraft((current) => ({
      ...current,
      shortcuts: { ...current.shortcuts, [actionId]: null },
    }));
    setRecordingActionId(null);
    setShortcutError("");
  };

  const recordShortcut = (
    actionId: ShortcutActionId,
    event: KeyboardEvent<HTMLButtonElement>,
  ) => {
    if (event.key === "Tab") return;
    event.preventDefault();
    event.stopPropagation();

    if (event.key === "Escape") {
      setRecordingActionId(null);
      setShortcutError("");
      return;
    }

    if (
      (event.key === "Backspace" || event.key === "Delete") &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey
    ) {
      clearShortcut(actionId);
      return;
    }

    const binding = shortcutFromKeyboardEvent(event);
    if (!binding) {
      setShortcutError(
        "Use Ctrl or Alt with a non-modifier key. Escape cancels; Backspace clears.",
      );
      return;
    }

    const conflictActionId = findShortcutConflict(draft.shortcuts, actionId, binding);
    if (conflictActionId) {
      setShortcutError(
        `${formatShortcutBinding(binding)} is already assigned to ${getShortcutAction(conflictActionId).label}.`,
      );
      return;
    }

    setDraft((current) => ({
      ...current,
      shortcuts: { ...current.shortcuts, [actionId]: binding },
    }));
    setRecordingActionId(null);
    setShortcutError("");
  };

  const clearSavedWorkspaceState = () => {
    setConfirmRequest({
      title: "Clear saved workspace state",
      message: "Clear saved TonyMux workspace state? Current panes will remain open.",
      confirmLabel: "Clear",
      danger: true,
      action: () => {
        onClearWorkspaceState();
        setNotice("Saved workspace state cleared. Current panes remain open until you close TonyMux.");
        setErrors([]);
      },
    });
  };

  const exportFile = () => {
    const blob = new Blob([exportSettings(draft)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "tonymux-settings.json";
    link.click();
    URL.revokeObjectURL(url);
  };

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      const imported = importSettings(await file.text());
      const trustQueryGeneration = ++trustQueryGenerationRef.current;
      setDraft(imported);
      draftRef.current = imported;
      setTrustStoreLoading(true);
      const trustState = await queryTrustState(imported.customShellProfiles);
      if (trustQueryGeneration === trustQueryGenerationRef.current) {
        setTrustedExecutables(trustState.profiles);
        setTrustStore(trustState.store);
        setTrustStoreLoading(false);
      }
      setErrors([]);
      setRecordingActionId(null);
      setShortcutError("");
      setTrustStatus(
        imported.customShellProfiles.length
          ? "Imported executable paths remain untrusted unless this Windows account already trusts the same file identity."
          : "",
      );
    } catch (cause) {
      setErrors([`Unable to import settings: ${String(cause)}`]);
    }
  };

  return (
    <div className="settings-scrim" role="presentation" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onMouseDown={(event: MouseEvent<HTMLDivElement>) => event.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
        <header className="settings-dialog__header">
          <div className="settings-dialog__heading">
            <span className="settings-dialog__icon" aria-hidden="true">
              <Settings2 size={18} />
            </span>
            <div>
              <h2 id={titleId}>TonyMux settings</h2>
              <p id={descriptionId}>
                New terminal panes use these values. Existing sessions keep running unchanged.
              </p>
            </div>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close settings"
            title="Close settings (Esc)"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>

        <div className="settings-dialog__body">
          {notice && (
            <div className="settings-notice" role="status">
              {notice}
            </div>
          )}

          {errors.length > 0 && (
            <div
              ref={errorSummaryRef}
              className="settings-errors"
              role="alert"
              tabIndex={-1}
              aria-label="Settings errors"
            >
              <strong>Review the following settings</strong>
              {errors.map((error) => (
                <p key={error}>{error}</p>
              ))}
            </div>
          )}

          <section className="settings-section" aria-labelledby="settings-shell-title">
            <div className="settings-section__heading">
              <TerminalSquare size={15} aria-hidden="true" />
              <div>
                <h3 id="settings-shell-title">Shell profile</h3>
                <p>Choose the allowlisted executable used by newly created terminals.</p>
              </div>
            </div>

            <div className="profile-grid" role="radiogroup" aria-label="Default shell profile">
              {SHELL_PROFILES.map((profile) => {
                const selected = draft.defaultShellProfileId === profile.id;
                return (
                  <button
                    key={profile.id}
                    className={`profile-card${selected ? " profile-card--selected" : ""}`}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        defaultShellProfileId: profile.id,
                      }))
                    }
                  >
                    <strong>{profile.label}</strong>
                    <span>{profile.description}</span>
                    <code>{profile.executable}</code>
                  </button>
                );
              })}
            </div>

            <div className="custom-profile-panel">
              <div className="custom-profile-panel__heading">
                <div>
                  <strong>Custom executables</strong>
                  <small>
                    TonyMux launches only absolute local .exe paths explicitly trusted on this Windows account.
                  </small>
                </div>
                <button
                  className="settings-button settings-button--quiet settings-button--compact"
                  type="button"
                  disabled={
                    draft.customShellProfiles.length >= MAX_CUSTOM_SHELL_PROFILES ||
                    trustPendingId !== null ||
                    trustStorePendingPath !== null
                  }
                  onClick={addCustomShellProfile}
                >
                  <Plus size={13} aria-hidden="true" />
                  Add profile
                </button>
              </div>

              {draft.customShellProfiles.length === 0 ? (
                <div className="custom-profile-empty">
                  <ShieldCheck size={16} aria-hidden="true" />
                  <span>No custom executable has been configured.</span>
                </div>
              ) : (
                <div className="custom-profile-list">
                  {draft.customShellProfiles.map((profile) => {
                    const selected = draft.defaultShellProfileId === profile.id;
                    const executableError = validateCustomShellExecutable(profile.executable);
                    const trusted = trustedExecutables[profile.id] === true;
                    const normalizedExecutable = normalizeCustomShellExecutable(profile.executable);
                    const trustedEntry = trustStore.entries.find(
                      (entry) =>
                        normalizeCustomShellExecutable(entry.executable).toLocaleLowerCase("en-US") ===
                        normalizedExecutable.toLocaleLowerCase("en-US"),
                    );
                    const identityStatus = trusted ? "trusted" : trustedEntry?.status ?? "untrusted";
                    const identityLabel =
                      identityStatus === "trusted"
                        ? "Trusted identity matches"
                        : identityStatus === "changed"
                          ? "File changed — trust again"
                          : identityStatus === "missing"
                            ? "Trusted file is missing"
                            : identityStatus === "unavailable"
                              ? "Identity check unavailable"
                              : "Not trusted";
                    const pending = trustPendingId === profile.id;
                    const fieldId = profile.id.replace(/[^A-Za-z0-9_-]/g, "-");
                    return (
                      <fieldset
                        className={`custom-profile${selected ? " custom-profile--selected" : ""}`}
                        key={profile.id}
                      >
                        <legend className="sr-only">{profile.label || "Custom shell"}</legend>
                        <div className="custom-profile__toolbar">
                          <label className="custom-profile__selector">
                            <input
                              type="radio"
                              name="default-shell-profile"
                              checked={selected}
                              onChange={() =>
                                setDraft((current) => ({
                                  ...current,
                                  defaultShellProfileId: profile.id,
                                }))
                              }
                            />
                            <span>Use as default shell</span>
                          </label>
                          <button
                            className="settings-button settings-button--danger settings-button--compact"
                            type="button"
                            aria-label={`Remove ${profile.label || "custom shell"}`}
                            disabled={trustPendingId !== null || trustStorePendingPath !== null}
                            onClick={() => void removeCustomShellProfile(profile.id)}
                          >
                            <Trash2 size={13} aria-hidden="true" />
                            Remove
                          </button>
                        </div>

                        <div className="settings-form-grid">
                          <label className="settings-field" htmlFor={`${fieldId}-label`}>
                            <span>Profile name</span>
                            <input
                              id={`${fieldId}-label`}
                              value={profile.label}
                              maxLength={64}
                              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                updateCustomShellProfile(profile.id, "label", event.target.value)
                              }
                            />
                          </label>
                          <label className="settings-field" htmlFor={`${fieldId}-executable`}>
                            <span>Executable path</span>
                            <input
                              id={`${fieldId}-executable`}
                              value={profile.executable}
                              placeholder="C:\\Tools\\shell.exe"
                              spellCheck={false}
                              aria-invalid={Boolean(executableError)}
                              aria-describedby={`${fieldId}-executable-help`}
                              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                updateCustomShellProfile(
                                  profile.id,
                                  "executable",
                                  event.target.value,
                                )
                              }
                            />
                            <small
                              id={`${fieldId}-executable-help`}
                              className={executableError ? "settings-field__error" : undefined}
                            >
                              {executableError ?? "Arguments and environment-variable expansion are not allowed."}
                            </small>
                          </label>
                        </div>

                        <div className="custom-profile__trust">
                          <span
                            className={`custom-profile__identity custom-profile__identity--${identityStatus}`}
                            title={trustedEntry?.detail ?? undefined}
                          >
                            {identityStatus === "trusted" ? (
                              <CheckCircle2 size={14} aria-hidden="true" />
                            ) : identityStatus === "missing" ? (
                              <ShieldX size={14} aria-hidden="true" />
                            ) : identityStatus === "changed" || identityStatus === "unavailable" ? (
                              <AlertTriangle size={14} aria-hidden="true" />
                            ) : (
                              <ShieldCheck size={14} aria-hidden="true" />
                            )}
                            {identityLabel}
                          </span>
                          <button
                            className="settings-button settings-button--quiet settings-button--compact"
                            type="button"
                            disabled={
                              Boolean(executableError) ||
                              !trustStore.healthy ||
                              trustPendingId !== null ||
                              trustStorePendingPath !== null
                            }
                            title={!trustStore.healthy ? "Reset the trust store before adding trust." : undefined}
                            onClick={() => void trustCustomShellProfile(profile)}
                          >
                            <ShieldCheck size={13} aria-hidden="true" />
                            {pending ? "Trusting…" : trusted ? "Trust again" : "Trust executable"}
                          </button>
                        </div>
                      </fieldset>
                    );
                  })}
                </div>
              )}

              <div className="trusted-shell-store" aria-describedby={trustStoreStatusId}>
                <div className="trusted-shell-store__heading">
                  <div>
                    <strong>Trusted executable identities</strong>
                    <small>
                      Trust is bound to the canonical path, SHA-256 fingerprint and file size. Updates require trust again.
                    </small>
                  </div>
                  <button
                    className="settings-button settings-button--quiet settings-button--compact"
                    type="button"
                    disabled={
                      trustStoreLoading ||
                      trustPendingId !== null ||
                      trustStorePendingPath !== null
                    }
                    onClick={() =>
                      void refreshTrustState(
                        draftRef.current.customShellProfiles,
                        "Trust status refreshed.",
                      )
                    }
                  >
                    <RefreshCw size={13} aria-hidden="true" />
                    {trustStoreLoading ? "Checking…" : "Refresh"}
                  </button>
                </div>

                {!trustStore.healthy ? (
                  <div className="trusted-shell-store__error" role="alert">
                    <AlertTriangle size={16} aria-hidden="true" />
                    <div>
                      <strong>Trust store needs recovery</strong>
                      <p>{trustStore.error ?? "TonyMux could not read the trust store."}</p>
                    </div>
                    <button
                      className="settings-button settings-button--danger settings-button--compact"
                      type="button"
                      disabled={trustPendingId !== null || trustStorePendingPath !== null}
                      onClick={() => void clearTrustedExecutables()}
                    >
                      <RotateCcw size={13} aria-hidden="true" />
                      {trustStorePendingPath === "*" ? "Resetting…" : "Reset trust store"}
                    </button>
                  </div>
                ) : trustStoreLoading && trustStore.entries.length === 0 ? (
                  <div className="trusted-shell-store__empty" role="status">
                    <RefreshCw size={15} aria-hidden="true" />
                    <span>Checking trusted executable identities…</span>
                  </div>
                ) : trustStore.entries.length === 0 ? (
                  <div className="trusted-shell-store__empty">
                    <ShieldCheck size={15} aria-hidden="true" />
                    <span>No executable identity is trusted on this Windows account.</span>
                  </div>
                ) : (
                  <>
                    <ul className="trusted-shell-store__list" aria-label="Trusted executable identities">
                      {trustStore.entries.map((entry) => {
                        const pending = trustStorePendingPath === entry.executable;
                        const statusLabel =
                          entry.status === "trusted"
                            ? "Identity matches"
                            : entry.status === "changed"
                              ? "File changed"
                              : entry.status === "missing"
                                ? "File missing"
                                : "Unavailable";
                        return (
                          <li className="trusted-shell-entry" key={entry.executable}>
                            <div className={`trusted-shell-entry__status trusted-shell-entry__status--${entry.status}`}>
                              {entry.status === "trusted" ? (
                                <CheckCircle2 size={15} aria-hidden="true" />
                              ) : entry.status === "missing" ? (
                                <ShieldX size={15} aria-hidden="true" />
                              ) : (
                                <AlertTriangle size={15} aria-hidden="true" />
                              )}
                              <span>{statusLabel}</span>
                            </div>
                            <div className="trusted-shell-entry__copy">
                              <code title={entry.executable}>{entry.executable}</code>
                              <small>
                                SHA-256 {entry.sha256.slice(0, 16)}… · {formatFileSize(entry.sizeBytes)}
                              </small>
                              {entry.detail && <p>{entry.detail}</p>}
                            </div>
                            <button
                              className="settings-button settings-button--danger settings-button--compact"
                              type="button"
                              disabled={trustPendingId !== null || trustStorePendingPath !== null}
                              onClick={() => void revokeTrustedExecutable(entry)}
                            >
                              <ShieldX size={13} aria-hidden="true" />
                              {pending ? "Revoking…" : "Revoke"}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                    <div className="trusted-shell-store__footer">
                      <span>{trustStore.entries.length} of 32 trust records used.</span>
                      <button
                        className="settings-button settings-button--danger settings-button--compact"
                        type="button"
                        disabled={trustPendingId !== null || trustStorePendingPath !== null}
                        onClick={() => void clearTrustedExecutables()}
                      >
                        <Trash2 size={13} aria-hidden="true" />
                        {trustStorePendingPath === "*" ? "Clearing…" : "Clear all trust"}
                      </button>
                    </div>
                  </>
                )}
              </div>

              <div
                id={trustStoreStatusId}
                className="custom-profile-status"
                role="status"
                aria-live="polite"
              >
                {trustStatus}
              </div>
            </div>

            <div className="settings-form-grid">
              <label className="settings-field settings-field--wide">
                <span>Default working directory</span>
                <input
                  value={draft.defaultWorkingDirectory}
                  placeholder="Leave empty to inherit the workspace directory"
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    setDraft((current) => ({
                      ...current,
                      defaultWorkingDirectory: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="settings-field settings-field--wide">
                <span>Startup command</span>
                <input
                  value={draft.startupCommand}
                  placeholder="Optional command sent after the shell starts"
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    setDraft((current) => ({
                      ...current,
                      startupCommand: event.target.value,
                    }))
                  }
                />
              </label>
            </div>

            <div className="custom-profile-panel">
              <div className="custom-profile-panel__heading">
                <div>
                  <strong>SSH connections</strong>
                  <small>
                    Remote terminal panes spawn the Windows OpenSSH client (ssh.exe) inside a
                    ConPTY pane. Password prompts, host-key confirmation and interactive shells
                    work directly in the terminal.
                  </small>
                </div>
                <button
                  className="settings-button settings-button--quiet settings-button--compact"
                  type="button"
                  disabled={draft.sshProfiles.length >= MAX_SSH_PROFILES}
                  onClick={addSshProfile}
                >
                  <Plus size={13} aria-hidden="true" />
                  Add SSH host
                </button>
              </div>

              {draft.sshProfiles.length === 0 ? (
                <div className="custom-profile-empty">
                  <Network size={16} aria-hidden="true" />
                  <span>No SSH connection has been configured.</span>
                </div>
              ) : (
                <div className="custom-profile-list">
                  {draft.sshProfiles.map((profile) => {
                    const selected = draft.defaultShellProfileId === profile.id;
                    const hostError = validateSshHost(profile.host);
                    const userError = validateSshUser(profile.user);
                    const portError = validateSshPort(profile.port);
                    const identityError = validateSshIdentityFile(profile.identityFile);
                    return (
                      <fieldset key={profile.id} className="ssh-profile-card">
                        <legend>
                          <input
                            type="radio"
                            name="default-ssh-profile"
                            checked={selected}
                            onChange={() =>
                              setDraft((current) => ({
                                ...current,
                                defaultShellProfileId: profile.id,
                              }))
                            }
                          />
                          <strong>{profile.label || "SSH host"}</strong>
                          <span>default</span>
                        </legend>
                        <div className="ssh-profile-grid">
                          <label className="settings-field">
                            <span>Label</span>
                            <input
                              value={profile.label}
                              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                updateSshProfile(profile.id, "label", event.target.value)
                              }
                            />
                          </label>
                          <label className="settings-field">
                            <span>Host</span>
                            <input
                              value={profile.host}
                              placeholder="example.com"
                              aria-invalid={hostError !== null}
                              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                updateSshProfile(profile.id, "host", event.target.value)
                              }
                            />
                          </label>
                          <label className="settings-field">
                            <span>Port</span>
                            <input
                              type="number"
                              min={1}
                              max={65_535}
                              value={profile.port === 0 ? "" : profile.port}
                              placeholder="22"
                              aria-invalid={portError !== null}
                              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                updateSshProfilePort(profile.id, event.target.value)
                              }
                            />
                          </label>
                          <label className="settings-field">
                            <span>User</span>
                            <input
                              value={profile.user}
                              placeholder="root"
                              aria-invalid={userError !== null}
                              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                updateSshProfile(profile.id, "user", event.target.value)
                              }
                            />
                          </label>
                          <label className="settings-field settings-field--wide">
                            <span>Identity file (optional)</span>
                            <input
                              value={profile.identityFile}
                              placeholder="C:\Users\you\.ssh\id_ed25519"
                              aria-invalid={identityError !== null}
                              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                updateSshProfile(profile.id, "identityFile", event.target.value)
                              }
                            />
                          </label>
                        </div>
                        {[hostError, userError, portError, identityError].some(Boolean) && (
                          <p className="custom-profile-error">
                            {[hostError, userError, portError, identityError]
                              .filter((error): error is string => Boolean(error))
                              .join(" ")}
                          </p>
                        )}
                        <div className="custom-profile-actions">
                          <button
                            className="settings-button settings-button--danger settings-button--compact"
                            type="button"
                            onClick={() => removeSshProfile(profile.id)}
                          >
                            <Trash2 size={13} aria-hidden="true" />
                            Remove
                          </button>
                        </div>
                      </fieldset>
                    );
                  })}
                </div>
              )}
            </div>
          </section>

          <section className="settings-section" aria-labelledby="settings-terminal-title">
            <div className="settings-section__heading">
              <TerminalSquare size={15} aria-hidden="true" />
              <div>
                <h3 id="settings-terminal-title">Terminal appearance</h3>
                <p>Dense defaults tuned for long-running developer workspaces.</p>
              </div>
            </div>

            <div className="settings-form-grid">
              <label className="settings-field settings-field--wide">
                <span>Font family</span>
                <input
                  value={draft.terminal.fontFamily}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => updateTerminal("fontFamily", event.target.value)}
                />
              </label>
              <label className="settings-field">
                <span>Font size</span>
                <input
                  type="number"
                  min={10}
                  max={24}
                  step={1}
                  value={draft.terminal.fontSize}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => updateTerminal("fontSize", Number(event.target.value))}
                />
              </label>
              <label className="settings-field">
                <span>Line height</span>
                <input
                  type="number"
                  min={1}
                  max={2}
                  step={0.05}
                  value={draft.terminal.lineHeight}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => updateTerminal("lineHeight", Number(event.target.value))}
                />
              </label>
              <label className="settings-field">
                <span>Cursor</span>
                <select
                  value={draft.terminal.cursorStyle}
                  onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                    updateTerminal("cursorStyle", event.target.value as CursorStyle)
                  }
                >
                  <option value="bar">Bar</option>
                  <option value="block">Block</option>
                  <option value="underline">Underline</option>
                </select>
              </label>
              <label className="settings-field">
                <span>Scrollback lines</span>
                <input
                  type="number"
                  min={1_000}
                  max={100_000}
                  step={1_000}
                  value={draft.terminal.scrollback}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => updateTerminal("scrollback", Number(event.target.value))}
                />
              </label>
              <label className="settings-toggle settings-field--wide">
                <input
                  type="checkbox"
                  checked={draft.terminal.cursorBlink}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => updateTerminal("cursorBlink", event.target.checked)}
                />
                <span>
                  <strong>Blinking cursor</strong>
                  <small>Disable it for reduced visual motion.</small>
                </span>
              </label>
            </div>
          </section>

          <section className="settings-section" aria-labelledby="settings-agents-title">
            <div className="settings-section__heading">
              <div className="settings-section__heading-main">
                <h3 id="settings-agents-title">Agent integrations</h3>
                <p className="settings-section__description">
                  Install hooks so agent CLIs record their last session. The Resume
                  action in the workspace topbar re-attaches a session in a new pane —
                  the agent executable must be in your trusted identities first.
                </p>
              </div>
            </div>
            <div className="agent-integrations">
              {AGENT_SETUP_INFO.map(({ agent, title, description }) => {
                const status = agentSetupStatus[agent];
                const busy = agentSetupBusy[agent] === true;
                const installed = typeof status === "object" && status !== null;
                return (
                  <div className="agent-integrations__row" key={agent}>
                    <div className="agent-integrations__row-main">
                      <span className="agent-integrations__icon" aria-hidden="true">
                        <Bot size={14} />
                      </span>
                      <div className="agent-integrations__text">
                        <strong>{title}</strong>
                        <small>{description}</small>
                        {installed ? (
                          <small className="agent-integrations__path">
                            Hook: {status.scriptPath}
                            <br />
                            Config: {status.configPath}
                          </small>
                        ) : typeof status === "string" && status ? (
                          <small className="agent-integrations__status">{status}</small>
                        ) : null}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="settings-action"
                      disabled={busy}
                      onClick={() => void installAgentHooks(agent)}
                    >
                      {installed ? "Reinstall" : busy ? "Installing…" : "Install hooks"}
                    </button>
                  </div>
                );
              })}
              <div className="agent-integrations__footer">
                <button type="button" className="settings-action" onClick={() => void clearResumeRecords()}>
                  <Trash2 size={13} />
                  Clear saved sessions
                </button>
                <small>
                  Sessions are saved to the resume store; nothing is executed until you click
                  Resume.
                </small>
              </div>
            </div>
          </section>

          <section className="settings-section" aria-labelledby="settings-browser-origins-title">
            <div className="settings-section__heading">
              <div className="settings-section__heading-main">
                <ShieldCheck size={15} aria-hidden="true" />
                <div>
                  <h3 id="settings-browser-origins-title">Trusted browser origins</h3>
                  <p className="settings-section__description">
                    Agents may evaluate JavaScript inside a browser pane only when the pane is on a
                    loopback address (localhost, 127.0.0.1, ::1) or on an origin you trust here.
                    Loopback is always allowed and needs no entry.
                  </p>
                </div>
              </div>
            </div>
            <div className="agent-integrations">
              {trustedOrigins.length === 0 ? (
                <div className="agent-integrations__row">
                  <div className="agent-integrations__row-main">
                    <div className="agent-integrations__text">
                      <strong>No trusted origins</strong>
                      <small>Browser eval is fail-closed: remote origins require explicit trust.</small>
                    </div>
                  </div>
                </div>
              ) : (
                trustedOrigins.map((origin) => (
                  <div className="agent-integrations__row" key={origin}>
                    <div className="agent-integrations__row-main">
                      <div className="agent-integrations__text">
                        <strong>{origin}</strong>
                        <small>Remote origin allowed for browser.eval</small>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="settings-action"
                      disabled={originBusy}
                      onClick={() => void revokeTrustedOrigin(origin)}
                    >
                      Remove
                    </button>
                  </div>
                ))
              )}
              <div className="agent-integrations__row agent-integrations__row--input">
                <div className="agent-integrations__row-main">
                  <div className="agent-integrations__text">
                    <strong>Add origin</strong>
                    <small>e.g. https://example.com or https://example.com:8443</small>
                  </div>
                </div>
                <div className="agent-integrations__add">
                  <input
                    type="text"
                    value={originInput}
                    placeholder="https://…"
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setOriginInput(event.target.value)}
                    onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                      if (event.key === "Enter") void addTrustedOrigin();
                    }}
                    aria-label="Trusted browser origin"
                  />
                  <button
                    type="button"
                    className="settings-action"
                    disabled={originBusy || originInput.trim().length === 0}
                    onClick={() => void addTrustedOrigin()}
                  >
                    <Plus size={13} />
                    Add
                  </button>
                </div>
              </div>
              {originNotice ? (
                <div className="agent-integrations__footer">
                  <small className="agent-integrations__status">{originNotice}</small>
                </div>
              ) : null}
              <div className="agent-integrations__footer">
                <button
                  type="button"
                  className="settings-action"
                  disabled={originBusy || trustedOrigins.length === 0}
                  onClick={() => void clearTrustedOrigins()}
                >
                  <Trash2 size={13} />
                  Clear all origins
                </button>
                <small>
                  Loopback origins stay evaluable even with an empty list; this only revokes remote
                  trust.
                </small>
              </div>
            </div>
          </section>

          <section className="settings-section" aria-labelledby="settings-shortcuts-title">
            <div className="settings-section__heading settings-section__heading--actions">
              <div className="settings-section__heading-main">
                <Keyboard size={15} aria-hidden="true" />
                <div>
                  <h3 id="settings-shortcuts-title">Keyboard shortcuts</h3>
                  <p id={shortcutsHelpId}>
                    Select a binding, then press Ctrl or Alt with another key. Physical key positions keep bindings stable across keyboard layouts.
                  </p>
                </div>
              </div>
              <button
                className="settings-button settings-button--quiet settings-button--compact"
                type="button"
                onClick={resetShortcuts}
              >
                <RotateCcw size={13} aria-hidden="true" />
                Reset shortcuts
              </button>
            </div>

            <div
              className="shortcut-list"
              role="list"
              aria-describedby={`${shortcutsHelpId} ${shortcutsStatusId}`}
            >
              {SHORTCUT_ACTIONS.map((action) => {
                const binding = draft.shortcuts[action.id];
                const recording = recordingActionId === action.id;
                return (
                  <div className="shortcut-row" role="listitem" key={action.id}>
                    <div className="shortcut-row__copy">
                      <span className="shortcut-row__section">{action.section}</span>
                      <strong>{action.label}</strong>
                      <small>{action.description}</small>
                    </div>
                    <div className="shortcut-row__actions">
                      <button
                        className={`shortcut-recorder${recording ? " shortcut-recorder--recording" : ""}`}
                        type="button"
                        aria-pressed={recording}
                        aria-label={`${action.label}: ${recording ? "press a shortcut" : formatShortcutBinding(binding)}`}
                        onClick={() => {
                          setRecordingActionId(recording ? null : action.id);
                          setShortcutError("");
                        }}
                        onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
                          if (recording) recordShortcut(action.id, event);
                        }}
                        onBlur={() => {
                          if (recording) setRecordingActionId(null);
                        }}
                      >
                        {recording ? "Press shortcut…" : formatShortcutBinding(binding)}
                      </button>
                      <button
                        className="shortcut-clear"
                        type="button"
                        disabled={!binding}
                        aria-label={`Clear shortcut for ${action.label}`}
                        title="Clear shortcut"
                        onClick={() => clearShortcut(action.id)}
                      >
                        <X size={13} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div
              id={shortcutsStatusId}
              className={`shortcut-status${shortcutError ? " shortcut-status--error" : ""}`}
              role={shortcutError ? "alert" : "status"}
              aria-live="polite"
            >
              {shortcutError ||
                (recordingActionId
                  ? `Recording ${getShortcutAction(recordingActionId).label}. Escape cancels; Backspace clears.`
                  : "Unassigned actions remain available from visible controls and the command palette.")}
            </div>
          </section>

          <section className="settings-section" aria-labelledby="settings-persistence-title">
            <div className="settings-section__heading">
              <Database size={15} aria-hidden="true" />
              <div>
                <h3 id="settings-persistence-title">Workspace restore</h3>
                <p>Restore saved layout metadata while always starting fresh terminal processes.</p>
              </div>
            </div>

            <div className="settings-form-grid">
              <label className="settings-toggle settings-field--wide">
                <input
                  type="checkbox"
                  checked={draft.persistence.restoreWorkspaces}
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    setDraft((current) => ({
                      ...current,
                      persistence: {
                        ...current.persistence,
                        restoreWorkspaces: event.target.checked,
                      },
                    }))
                  }
                />
                <span>
                  <strong>Restore workspaces on launch</strong>
                  <small>Stores bounded layout metadata and, when enabled below, inert terminal history.</small>
                </span>
              </label>
              <label className="settings-field settings-field--wide">
                <span>Restored terminal history lines</span>
                <input
                  type="number"
                  min={0}
                  max={MAX_TERMINAL_HISTORY_LINES}
                  step={100}
                  value={draft.persistence.terminalHistoryLines}
                  disabled={!draft.persistence.restoreWorkspaces}
                  aria-describedby={historyHelpId}
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    setDraft((current) => ({
                      ...current,
                      persistence: {
                        ...current.persistence,
                        terminalHistoryLines: Number(event.target.value),
                      },
                    }))
                  }
                />
                <small id={historyHelpId}>
                  Use 0 to disable history. TonyMux stores at most 5,000 lines, 512 KiB per pane and 4 MiB total.
                </small>
              </label>
              <div className="settings-persistence-action settings-field--wide">
                <div>
                  <strong>Saved workspace state</strong>
                  <small>Clearing it does not remove TonyMux settings or close current panes.</small>
                </div>
                <button
                  className="settings-button settings-button--danger"
                  type="button"
                  onClick={clearSavedWorkspaceState}
                >
                  <Trash2 size={14} />
                  Clear saved state
                </button>
              </div>
            </div>
          </section>

        </div>

        <footer className="settings-dialog__footer">
          <div className="settings-dialog__utility-actions">
            <button className="settings-button settings-button--quiet" type="button" onClick={reset}>
              <RotateCcw size={14} />
              Reset
            </button>
            <button
              className="settings-button settings-button--quiet"
              type="button"
              onClick={() => importInputRef.current?.click()}
            >
              <Upload size={14} />
              Import
            </button>
            <button
              className="settings-button settings-button--quiet"
              type="button"
              onClick={exportFile}
            >
              <Download size={14} />
              Export
            </button>
            <input
              ref={importInputRef}
              className="sr-only"
              type="file"
              tabIndex={-1}
              accept="application/json,.json"
              onChange={importFile}
            />
          </div>
          <div className="settings-dialog__primary-actions">
            <button className="settings-button settings-button--quiet" type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              className="settings-button settings-button--primary"
              type="button"
              disabled={saving}
              aria-busy={saving}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save settings"}
            </button>
          </div>
        </footer>
      </div>
      <ConfirmDialog
        open={confirmRequest !== null}
        title={confirmRequest?.title ?? ""}
        message={confirmRequest?.message ?? ""}
        confirmLabel={confirmRequest?.confirmLabel}
        danger={confirmRequest?.danger}
        onConfirm={() => void confirmRequest?.action()}
        onClose={() => setConfirmRequest(null)}
      />
    </div>
  );
}
