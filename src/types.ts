import type { TerminalPaneSettings } from "./settings";

export type TerminalPaneModel = {
  id: string;
  kind: "terminal";
  title: string;
  terminalSettings?: TerminalPaneSettings;
  restored?: boolean;
};

export type BrowserPaneModel = {
  id: string;
  kind: "browser";
  title: string;
  url: string;
};

export type Pane = TerminalPaneModel | BrowserPaneModel;

export type Workspace = {
  id: string;
  title: string;
  cwd: string;
  panes: Pane[];
  unread: boolean;
};

export type PullRequestMetadata = {
  number: number;
  title: string;
  url: string;
  state: string;
};

export type WorkspaceMetadata = {
  repository: string | null;
  repositoryRoot: string | null;
  branch: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
  pullRequest: PullRequestMetadata | null;
  listeningPorts: number[];
  available: boolean;
};

export type TerminalOutputEvent = {
  sessionId: string;
  data: string;
};
