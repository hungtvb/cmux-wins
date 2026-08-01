import type { Pane, Workspace } from "../types";

const MAX_EVENT_TEXT_CHARS = 1024;

export type FrontendAutomationEvent =
  | {
      kind: "workspaceCreated";
      workspaceId: string;
      title: string;
      cwd: string;
    }
  | {
      kind: "workspaceClosed";
      workspaceId: string;
    }
  | {
      kind: "workspaceSelected";
      workspaceId: string;
    }
  | {
      kind: "paneCreated";
      workspaceId: string;
      paneId: string;
      paneKind: Pane["kind"];
      title: string;
      url?: string;
    }
  | {
      kind: "paneUpdated";
      workspaceId: string;
      paneId: string;
      paneKind: Pane["kind"];
      title: string;
      url?: string;
    }
  | {
      kind: "paneClosed";
      workspaceId: string;
      paneId: string;
      paneKind: Pane["kind"];
    }
  | {
      kind: "attentionRequested";
      workspaceId: string;
      paneId: string;
      message: string;
    }
  | {
      kind: "attentionCleared";
      workspaceId: string;
      paneId: string;
    };

export type WorkspaceEventSnapshot = {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  attention: Record<string, string>;
};

type PaneContext = {
  workspaceId: string;
  pane: Pane;
};

function normalizeEventText(value: string): string {
  return Array.from(value.replaceAll("\0", ""))
    .slice(0, MAX_EVENT_TEXT_CHARS)
    .join("");
}

function paneContexts(workspaces: Workspace[]): Map<string, PaneContext> {
  const contexts = new Map<string, PaneContext>();
  for (const workspace of workspaces) {
    for (const pane of workspace.panes) {
      contexts.set(pane.id, { workspaceId: workspace.id, pane });
    }
  }
  return contexts;
}

function paneEventPayload(
  kind: "paneCreated" | "paneUpdated",
  context: PaneContext,
): FrontendAutomationEvent {
  return {
    kind,
    workspaceId: context.workspaceId,
    paneId: context.pane.id,
    paneKind: context.pane.kind,
    title: normalizeEventText(context.pane.title),
    ...(context.pane.kind === "browser"
      ? { url: normalizeEventText(context.pane.url) }
      : {}),
  };
}

function paneChanged(previous: Pane, current: Pane): boolean {
  if (previous.kind !== current.kind || previous.title !== current.title) return true;
  return (
    previous.kind === "browser" &&
    current.kind === "browser" &&
    previous.url !== current.url
  );
}

export function diffWorkspaceEvents(
  previous: WorkspaceEventSnapshot,
  current: WorkspaceEventSnapshot,
): FrontendAutomationEvent[] {
  const events: FrontendAutomationEvent[] = [];
  const previousWorkspaces = new Map(
    previous.workspaces.map((workspace) => [workspace.id, workspace]),
  );
  const currentWorkspaces = new Map(
    current.workspaces.map((workspace) => [workspace.id, workspace]),
  );
  const previousPanes = paneContexts(previous.workspaces);
  const currentPanes = paneContexts(current.workspaces);

  for (const workspace of current.workspaces) {
    if (!previousWorkspaces.has(workspace.id)) {
      events.push({
        kind: "workspaceCreated",
        workspaceId: workspace.id,
        title: normalizeEventText(workspace.title),
        cwd: normalizeEventText(workspace.cwd),
      });
    }
  }

  for (const [paneId, context] of currentPanes) {
    const previousContext = previousPanes.get(paneId);
    if (!previousContext) {
      events.push(paneEventPayload("paneCreated", context));
    } else if (
      previousContext.workspaceId !== context.workspaceId ||
      paneChanged(previousContext.pane, context.pane)
    ) {
      events.push(paneEventPayload("paneUpdated", context));
    }
  }

  for (const [paneId, message] of Object.entries(current.attention)) {
    if (previous.attention[paneId] === message) continue;
    const context = currentPanes.get(paneId) ?? previousPanes.get(paneId);
    if (!context) continue;
    events.push({
      kind: "attentionRequested",
      workspaceId: context.workspaceId,
      paneId,
      message: normalizeEventText(message),
    });
  }

  for (const paneId of Object.keys(previous.attention)) {
    const paneWasRemoved = previousPanes.has(paneId) && !currentPanes.has(paneId);
    if (paneId in current.attention && !paneWasRemoved) continue;
    const context = previousPanes.get(paneId) ?? currentPanes.get(paneId);
    if (!context) continue;
    events.push({
      kind: "attentionCleared",
      workspaceId: context.workspaceId,
      paneId,
    });
  }

  for (const [paneId, context] of previousPanes) {
    if (!currentPanes.has(paneId)) {
      events.push({
        kind: "paneClosed",
        workspaceId: context.workspaceId,
        paneId,
        paneKind: context.pane.kind,
      });
    }
  }

  for (const workspace of previous.workspaces) {
    if (!currentWorkspaces.has(workspace.id)) {
      events.push({
        kind: "workspaceClosed",
        workspaceId: workspace.id,
      });
    }
  }

  if (
    current.activeWorkspaceId !== previous.activeWorkspaceId &&
    currentWorkspaces.has(current.activeWorkspaceId)
  ) {
    events.push({
      kind: "workspaceSelected",
      workspaceId: current.activeWorkspaceId,
    });
  }

  return events;
}
