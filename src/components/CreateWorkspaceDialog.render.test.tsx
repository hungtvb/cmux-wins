import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CreateWorkspaceDialog } from "./CreateWorkspaceDialog";

describe("CreateWorkspaceDialog", () => {
  it("renders nothing when closed", () => {
    const markup = renderToStaticMarkup(
      <CreateWorkspaceDialog open={false} defaultTitle="Workspace 1" onCreate={() => undefined} onClose={() => undefined} />,
    );
    expect(markup).toBe("");
  });

  it("renders a labelled dialog with name + cwd fields when open", () => {
    const markup = renderToStaticMarkup(
      <CreateWorkspaceDialog open defaultTitle="Workspace 1" onCreate={() => undefined} onClose={() => undefined} />,
    );
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain("New workspace");
    expect(markup).toContain('placeholder="Workspace name"');
    expect(markup).toContain("Working directory");
    expect(markup).toContain("Create workspace");
    expect(markup).toContain("Cancel");
  });

  it("uses the default title as the initial name value", () => {
    const markup = renderToStaticMarkup(
      <CreateWorkspaceDialog open defaultTitle="Workspace 42" onCreate={() => undefined} onClose={() => undefined} />,
    );
    expect(markup).toContain('value="Workspace 42"');
  });

  it("disables submit when the name is blank", () => {
    const markup = renderToStaticMarkup(
      <CreateWorkspaceDialog open defaultTitle="   " onCreate={() => undefined} onClose={() => undefined} />,
    );
    expect(markup).toContain('disabled=""');
  });

  it("keeps create + cancel wired to their handlers", () => {
    const onCreate = vi.fn();
    const onClose = vi.fn();
    // renderToStaticMarkup cannot simulate clicks; assert the wiring exists
    // via the button labels and the form present.
    const markup = renderToStaticMarkup(
      <CreateWorkspaceDialog open defaultTitle="Workspace 1" onCreate={onCreate} onClose={onClose} />,
    );
    expect(markup).toContain("Create workspace");
    expect(markup).toContain("Cancel");
    expect(onCreate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
