import {
  Download,
  RotateCcw,
  Settings2,
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
import type { AgentHooksSetupResult } from "../agentIntegrations";
import { checkFontAvailability, type FontCheckResult } from "../fontAvailability";
import { TerminalAppearanceSection } from "./sections/TerminalAppearanceSection";
import { AgentIntegrationsSection } from "./sections/AgentIntegrationsSection";
import { BrowserOriginsSection } from "./sections/BrowserOriginsSection";
import { ShellAndTrustSection } from "./sections/ShellAndTrustSection";
import { PersistenceSection } from "./sections/PersistenceSection";
import { ShortcutsSection } from "./sections/ShortcutsSection";
import {
  DEFAULT_SETTINGS,
  MAX_CUSTOM_SHELL_PROFILES,
  MAX_SSH_PROFILES,
  countCustomShellProfilesUsingExecutable,
  exportSettings,
  findCustomShellProfile,
  importSettings,
  normalizeCustomShellExecutable,
  normalizeSettings,
  validateCustomShellExecutable,
  validateSettings,
  type AppSettings,
  type CustomShellProfile,
  type SshProfile,
} from "../settings";
import {
  DEFAULT_SHORTCUT_BINDINGS,
  findShortcutConflict,
  formatShortcutBinding,
  getShortcutAction,
  shortcutFromKeyboardEvent,
  type ShortcutActionId,
} from "../shortcuts";
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
  const [fontCheck, setFontCheck] = useState<FontCheckResult>(() => ({
    family: settings.terminal.fontFamily,
    status: "unknown",
    missingFamily: null,
  }));
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

  // Non-blocking availability hint for the selected terminal font.
  useEffect(() => {
    let cancelled = false;
    void checkFontAvailability(draft.terminal.fontFamily).then((result) => {
      if (!cancelled) setFontCheck(result);
    });
    return () => {
      cancelled = true;
    };
  }, [draft.terminal.fontFamily]);

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

          <ShellAndTrustSection
            draft={draft}
            setDraft={setDraft}
            trustedExecutables={trustedExecutables}
            trustStore={trustStore}
            trustStoreLoading={trustStoreLoading}
            trustStorePendingPath={trustStorePendingPath}
            trustPendingId={trustPendingId}
            trustStatus={trustStatus}
            trustStoreStatusId={trustStoreStatusId}
            onAddCustomShellProfile={addCustomShellProfile}
            onUpdateCustomShellProfile={updateCustomShellProfile}
            onRemoveCustomShellProfile={removeCustomShellProfile}
            onTrustCustomShellProfile={trustCustomShellProfile}
            onRefreshTrustState={() => {
              void refreshTrustState(
                draftRef.current.customShellProfiles,
                "Trust status refreshed.",
              );
            }}
            onClearTrustedExecutables={clearTrustedExecutables}
            onRevokeTrustedExecutable={revokeTrustedExecutable}
            onAddSshProfile={addSshProfile}
            onUpdateSshProfile={updateSshProfile}
            onUpdateSshProfilePort={updateSshProfilePort}
            onRemoveSshProfile={removeSshProfile}
          />

          <TerminalAppearanceSection
            terminal={draft.terminal}
            fontCheck={fontCheck}
            onChange={updateTerminal}
          />

          <AgentIntegrationsSection
            agentSetupStatus={agentSetupStatus}
            agentSetupBusy={agentSetupBusy}
            installAgentHooks={installAgentHooks}
            clearResumeRecords={clearResumeRecords}
          />

          <BrowserOriginsSection
            trustedOrigins={trustedOrigins}
            originInput={originInput}
            originNotice={originNotice}
            originBusy={originBusy}
            setOriginInput={setOriginInput}
            addTrustedOrigin={addTrustedOrigin}
            revokeTrustedOrigin={revokeTrustedOrigin}
            clearTrustedOrigins={clearTrustedOrigins}
          />

          <ShortcutsSection
            shortcuts={draft.shortcuts}
            recordingActionId={recordingActionId}
            shortcutError={shortcutError}
            shortcutsHelpId={shortcutsHelpId}
            shortcutsStatusId={shortcutsStatusId}
            resetShortcuts={resetShortcuts}
            recordShortcut={recordShortcut}
            clearShortcut={clearShortcut}
            setRecordingActionId={setRecordingActionId}
            setShortcutError={setShortcutError}
          />

          <PersistenceSection
            persistence={draft.persistence}
            setDraft={setDraft}
            historyHelpId={historyHelpId}
            clearSavedWorkspaceState={clearSavedWorkspaceState}
          />

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
