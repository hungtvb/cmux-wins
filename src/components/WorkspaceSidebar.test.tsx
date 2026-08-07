import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../settings";
import type { Workspace, WorkspaceMetadata } from "../types";
import { WorkspaceSidebar } from "./WorkspaceSidebar";

const workspace: Workspace = {
  id: "workspace-1",
  title: "TonyMux",
  cwd: "C:\\src\\tonymux",
  panes: [{ id: "pane-1", kind: "terminal", title: "PowerShell" }],
  unread: true,
};

const metadata: WorkspaceMetadata = {
  repository: "cmux-wins",
  repositoryRoot: "C:\\src\\tonymux",
  branch: "feat/quiet-operator-foundation",
  dirty: true,
  ahead: 1,
  behind: 0,
  pullRequest: null,
  listeningPorts: [1420],
  available: true,
};

describe("WorkspaceSidebar", () => {
  it("announces modified and agent-attention state without relying on color", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceSidebar
        workspaces={[workspace]}
        metadataByWorkspace={{ [workspace.id]: metadata }}
        activeWorkspaceId={workspace.id}
        settings={DEFAULT_SETTINGS}
        onSelect={vi.fn()}
        onAdd={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(markup).toContain(">Modified<");
    expect(markup).toContain('aria-label="Unread agent alert"');
    expect(markup).toContain('aria-current="page"');
  });
});
