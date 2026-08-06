import { describe, expect, it } from "vitest";
import {
  agentSessionLabel,
  cwdKey,
  isAgentKind,
  quotePowerShellArg,
  recordsForCwd,
  toStartupCommand,
  type ResumeRecord,
} from "./resumeModel";

function record(agent: ResumeRecord["agent"], cwd: string, sessionId = "abc123"): ResumeRecord {
  return {
    agent,
    sessionId,
    cwd,
    updatedAt: 1,
    executable: agent === "claude" ? "C:\\tools\\claude.exe" : agent,
    args: agent === "claude"
      ? ["--resume", sessionId, "--cwd", cwd]
      : ["resume", sessionId, "--cd", cwd],
  };
}

describe("cwdKey", () => {
  it("normalizes case and trailing separators", () => {
    expect(cwdKey("C:\\Proj\\App\\")).toBe("c:\\proj\\app");
    expect(cwdKey("C:\\Proj\\App")).toBe("c:\\proj\\app");
    expect(cwdKey("C:/Proj/App/")).toBe("c:/proj/app");
    expect(cwdKey("/home/me/proj")).toBe("/home/me/proj");
  });
});

describe("quotePowerShellArg", () => {
  it("quotes whitespace and quotes, doubles inner quotes", () => {
    expect(quotePowerShellArg("claude")).toBe("claude");
    expect(quotePowerShellArg("C:\\My Project")).toBe("'C:\\My Project'");
    expect(quotePowerShellArg("C:\\it's")).toBe("'C:\\it''s'");
    expect(quotePowerShellArg("")).toBe("''");
  });
});

describe("toStartupCommand", () => {
  it("renders claude resume command", () => {
    const r = record("claude", "C:\\My Project\\app", "sess-1");
    expect(toStartupCommand(r)).toBe(
      "C:\\tools\\claude.exe --resume sess-1 --cwd 'C:\\My Project\\app'",
    );
  });

  it("renders codex resume command with --cd", () => {
    const r = record("codex", "C:\\app");
    expect(toStartupCommand(r)).toContain("resume abc123 --cd");
  });
});

describe("recordsForCwd", () => {
  it("matches case-insensitively with trailing separators", () => {
    const records = [record("claude", "C:\\Proj\\App\\"), record("codex", "D:\\other")];
    const matches = recordsForCwd(records, "c:\\proj\\app");
    expect(matches).toHaveLength(1);
    expect(matches[0].agent).toBe("claude");
  });
});

describe("isAgentKind", () => {
  it("guards known agents", () => {
    expect(isAgentKind("claude")).toBe(true);
    expect(isAgentKind("codex")).toBe(true);
    expect(isAgentKind("opencode")).toBe(true);
    expect(isAgentKind("gemini")).toBe(false);
  });
});

describe("agentSessionLabel", () => {
  it("truncates long session ids", () => {
    expect(agentSessionLabel(record("claude", "C:\\x", "0123456789abcdef"))).toBe(
      "Claude Code · 0123456789",
    );
    expect(agentSessionLabel(record("codex", "C:\\x", "abc"))).toBe("Codex · abc");
  });
});
