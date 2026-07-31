export type TerminalPaneModel = {
  id: string;
  kind: "terminal";
  title: string;
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

export type TerminalOutputEvent = {
  sessionId: string;
  data: string;
};
