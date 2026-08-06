/**
 * Frontend mirror of `src-tauri/src/resume.rs`: the resume store shape, the
 * PowerShell-safe startup command rendering, and cwd key normalization.
 *
 * The Rust side is the source of truth for parsing/persistence; this module
 * only renders and filters what the UI needs. Keep the quoting logic in sync
 * with `ResumeRecord::to_startup_command` (single-quote + `''` doubling).
 */

export type AgentKind = "claude" | "codex" | "opencode";

export type ResumeRecord = {
  agent: AgentKind;
  sessionId: string;
  cwd: string;
  updatedAt: number;
  executable: string;
  args: string[];
};

export const AGENT_DISPLAY_NAMES: Record<AgentKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "opencode",
};

export function isAgentKind(value: string): value is AgentKind {
  return value === "claude" || value === "codex" || value === "opencode";
}

/**
 * Normalized cwd key: trimmed, trailing separators stripped, lowercased
 * (Windows paths are case-insensitive). Mirrors `cwd_key` in resume.rs.
 */
export function cwdKey(cwd: string): string {
  return cwd.trim().replace(/[\\/]+$/, "").toLowerCase();
}

/** PowerShell single-quote escaping — mirrors `quote_powershell_arg`. */
export function quotePowerShellArg(value: string): string {
  if (value.length === 0) return "''";
  const escaped = value.replace(/'/g, "''");
  if (/[\s"']/.test(value)) {
    return `'${escaped}'`;
  }
  return value;
}

/** Render a record as the startup command typed into the terminal pane. */
export function toStartupCommand(record: ResumeRecord): string {
  const parts = [quotePowerShellArg(record.executable)];
  for (const arg of record.args) {
    parts.push(quotePowerShellArg(arg));
  }
  return parts.join(" ");
}

/** Records whose normalized cwd matches the workspace directory. */
export function recordsForCwd(records: ResumeRecord[], cwd: string): ResumeRecord[] {
  const key = cwdKey(cwd);
  return records.filter((record) => cwdKey(record.cwd) === key);
}

/** Compact label for a menu item: e.g. "Claude Code · 1f3a9c" (short id). */
export function agentSessionLabel(record: ResumeRecord): string {
  const shortId =
    record.sessionId.length > 10 ? record.sessionId.slice(0, 10) : record.sessionId;
  return `${AGENT_DISPLAY_NAMES[record.agent]} · ${shortId}`;
}
