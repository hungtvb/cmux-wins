import type { AgentKind } from "./resumeModel";

export type AgentHooksSetupResult = {
  agent: AgentKind;
  scriptPath: string;
  configPath: string;
  message: string;
};

export type AgentSetupInfoItem = {
  agent: AgentKind;
  title: string;
  description: string;
};

export const AGENT_SETUP_INFO: AgentSetupInfoItem[] = [
  {
    agent: "claude",
    title: "Claude Code",
    description:
      "Stop + SessionEnd hooks save the resume command after every turn and at session end.",
  },
  {
    agent: "codex",
    title: "Codex",
    description: "SessionEnd hook writes the resume command within Codex's 3s teardown budget.",
  },
  {
    agent: "opencode",
    title: "opencode",
    description: "Global plugin records sessions from session idle events.",
  },
];