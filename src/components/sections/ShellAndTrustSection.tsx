import {
  AlertTriangle,
  CheckCircle2,
  Network,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  ShieldX,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import type { ChangeEvent } from "react";
import {
  MAX_CUSTOM_SHELL_PROFILES,
  MAX_SSH_PROFILES,
  SHELL_PROFILES,
  normalizeCustomShellExecutable,
  validateCustomShellExecutable,
  validateSshHost,
  validateSshIdentityFile,
  validateSshPort,
  validateSshUser,
} from "../../settings";
import type {
  AppSettings,
  CustomShellProfile,
} from "../../settings";
import { formatFileSize } from "../formatFileSize";

type TrustedExecutableStatus = "trusted" | "changed" | "missing" | "unavailable";

type TrustedShellStoreSnapshot = {
  healthy: boolean;
  error: string | null;
  entries: Array<{
    executable: string;
    sha256: string;
    sizeBytes: number;
    status: TrustedExecutableStatus;
    detail: string | null;
  }>;
};

type TrustedExecutableSnapshot = {
  executable: string;
  sha256: string;
  sizeBytes: number;
  status: TrustedExecutableStatus;
  detail: string | null;
};

type ShellAndTrustSectionProps = {
  draft: AppSettings;
  setDraft: (updater: (current: AppSettings) => AppSettings) => void;
  trustedExecutables: Record<string, boolean>;
  trustStore: TrustedShellStoreSnapshot;
  trustStoreLoading: boolean;
  trustStorePendingPath: string | null;
  trustPendingId: string | null;
  trustStatus: string;
  trustStoreStatusId: string;
  onAddCustomShellProfile: () => void;
  onUpdateCustomShellProfile: (
    id: string,
    field: "label" | "executable",
    value: string,
  ) => void;
  onRemoveCustomShellProfile: (id: string) => Promise<void>;
  onTrustCustomShellProfile: (profile: CustomShellProfile) => Promise<void>;
  onRefreshTrustState: () => void;
  onClearTrustedExecutables: () => Promise<void>;
  onRevokeTrustedExecutable: (entry: TrustedExecutableSnapshot) => Promise<void>;
  onAddSshProfile: () => void;
  onUpdateSshProfile: (
    id: string,
    field: "label" | "host" | "user" | "identityFile",
    value: string,
  ) => void;
  onUpdateSshProfilePort: (id: string, value: string) => void;
  onRemoveSshProfile: (id: string) => void;
};

export function ShellAndTrustSection({
  draft,
  setDraft,
  trustedExecutables,
  trustStore,
  trustStoreLoading,
  trustStorePendingPath,
  trustPendingId,
  trustStatus,
  trustStoreStatusId,
  onAddCustomShellProfile,
  onUpdateCustomShellProfile,
  onRemoveCustomShellProfile,
  onTrustCustomShellProfile,
  onRefreshTrustState,
  onClearTrustedExecutables,
  onRevokeTrustedExecutable,
  onAddSshProfile,
  onUpdateSshProfile,
  onUpdateSshProfilePort,
  onRemoveSshProfile,
}: ShellAndTrustSectionProps) {
  return (
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
              TonyMux launches only absolute local .exe paths explicitly trusted on this Windows
              account.
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
            onClick={onAddCustomShellProfile}
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
                      onClick={() => void onRemoveCustomShellProfile(profile.id)}
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
                          onUpdateCustomShellProfile(profile.id, "label", event.target.value)
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
                          onUpdateCustomShellProfile(
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
                        {executableError ??
                          "Arguments and environment-variable expansion are not allowed."}
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
                      title={
                        !trustStore.healthy
                          ? "Reset the trust store before adding trust."
                          : undefined
                      }
                      onClick={() => void onTrustCustomShellProfile(profile)}
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
                Trust is bound to the canonical path, SHA-256 fingerprint and file size. Updates
                require trust again.
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
              onClick={() => void onRefreshTrustState()}
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
                onClick={() => void onClearTrustedExecutables()}
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
              <ul
                className="trusted-shell-store__list"
                aria-label="Trusted executable identities"
              >
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
                      <div
                        className={`trusted-shell-entry__status trusted-shell-entry__status--${entry.status}`}
                      >
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
                        onClick={() => void onRevokeTrustedExecutable(entry)}
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
                  onClick={() => void onClearTrustedExecutables()}
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
              Remote terminal panes spawn the Windows OpenSSH client (ssh.exe) inside a ConPTY
              pane. Password prompts, host-key confirmation and interactive shells work directly
              in the terminal.
            </small>
          </div>
          <button
            className="settings-button settings-button--quiet settings-button--compact"
            type="button"
            disabled={draft.sshProfiles.length >= MAX_SSH_PROFILES}
            onClick={onAddSshProfile}
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
                          onUpdateSshProfile(profile.id, "label", event.target.value)
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
                          onUpdateSshProfile(profile.id, "host", event.target.value)
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
                          onUpdateSshProfilePort(profile.id, event.target.value)
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
                          onUpdateSshProfile(profile.id, "user", event.target.value)
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
                          onUpdateSshProfile(profile.id, "identityFile", event.target.value)
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
                      onClick={() => onRemoveSshProfile(profile.id)}
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
  );
}