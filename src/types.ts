export type Pane = {
  id: string;
  title: string;
};

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
