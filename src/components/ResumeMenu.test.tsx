import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResumeMenu } from "./ResumeMenu";
import type { ResumeRecord } from "../resumeModel";

function record(agent: ResumeRecord["agent"], sessionId = "abc123", cwd = "C:\\proj\\app"): ResumeRecord {
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

describe("ResumeMenu", () => {
  it("renders a toggle button labelled for resume", () => {
    const markup = renderToStaticMarkup(
      <ResumeMenu records={[]} notice={null} onResume={() => undefined} onOpenSettings={() => undefined} />,
    );
    expect(markup).toContain('aria-label="Resume agent session"');
    expect(markup).toContain("Resume agent session");
  });

  it("shows an empty state message when the menu is open with no records", () => {
    const markup = renderToStaticMarkup(
      <ResumeMenu records={[]} notice={null} onResume={() => undefined} onOpenSettings={() => undefined} defaultOpen />,
    );
    expect(markup).toContain('role="menu"');
    expect(markup).toContain("No sessions to resume in this workspace");
  });

  it("renders one menu item per record with a compact agent label", () => {
    const records = [record("claude", "0123456789abcdef"), record("codex", "x")];
    const markup = renderToStaticMarkup(
      <ResumeMenu records={records} notice={null} onResume={() => undefined} onOpenSettings={() => undefined} defaultOpen />,
    );
    expect(markup.match(/role="menuitem"/g)).toHaveLength(2);
    expect(markup).toContain("Claude Code · 0123456789");
    expect(markup).toContain("Codex · x");
  });

  it("shows the notice text when provided", () => {
    const markup = renderToStaticMarkup(
      <ResumeMenu
        records={[]}
        notice="Could not verify the agent executable"
        onResume={() => undefined}
        onOpenSettings={() => undefined}
        defaultOpen
      />,
    );
    expect(markup).toContain("Could not verify the agent executable");
    expect(markup).toContain("resume-menu__notice");
  });

  it("exposes the agent integrations settings entrypoint", () => {
    const markup = renderToStaticMarkup(
      <ResumeMenu records={[]} notice={null} onResume={() => undefined} onOpenSettings={() => undefined} defaultOpen />,
    );
    expect(markup).toContain("Agent integrations");
    expect(markup).toContain("resume-menu__settings");
  });
});