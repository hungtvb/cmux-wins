import { Bot, Trash2 } from "lucide-react";
import type { AgentKind } from "../../resumeModel";
import { AGENT_SETUP_INFO, type AgentHooksSetupResult } from "../../agentIntegrations";

type AgentIntegrationsSectionProps = {
  agentSetupStatus: Record<string, string | AgentHooksSetupResult>;
  agentSetupBusy: Record<string, boolean>;
  installAgentHooks: (agent: AgentKind) => Promise<void>;
  clearResumeRecords: () => Promise<void>;
};

export function AgentIntegrationsSection({
  agentSetupStatus,
  agentSetupBusy,
  installAgentHooks,
  clearResumeRecords,
}: AgentIntegrationsSectionProps) {
  return (
    <section className="settings-section" aria-labelledby="settings-agents-title">
      <div className="settings-section__heading">
        <div className="settings-section__heading-main">
          <h3 id="settings-agents-title">Agent integrations</h3>
          <p className="settings-section__description">
            Install hooks so agent CLIs record their last session. The Resume action in the
            workspace topbar re-attaches a session in a new pane — the agent executable must be
            in your trusted identities first.
          </p>
        </div>
      </div>
      <div className="agent-integrations">
        {AGENT_SETUP_INFO.map(({ agent, title, description }) => {
          const status = agentSetupStatus[agent];
          const busy = agentSetupBusy[agent] === true;
          const installed = typeof status === "object" && status !== null;
          return (
            <div className="agent-integrations__row" key={agent}>
              <div className="agent-integrations__row-main">
                <span className="agent-integrations__icon" aria-hidden="true">
                  <Bot size={14} />
                </span>
                <div className="agent-integrations__text">
                  <strong>{title}</strong>
                  <small>{description}</small>
                  {installed ? (
                    <small className="agent-integrations__path">
                      Hook: {status.scriptPath}
                      <br />
                      Config: {status.configPath}
                    </small>
                  ) : typeof status === "string" && status ? (
                    <small className="agent-integrations__status">{status}</small>
                  ) : null}
                </div>
              </div>
              <button
                type="button"
                className="settings-action"
                disabled={busy}
                onClick={() => void installAgentHooks(agent)}
              >
                {installed ? "Reinstall" : busy ? "Installing…" : "Install hooks"}
              </button>
            </div>
          );
        })}
        <div className="agent-integrations__footer">
          <button
            type="button"
            className="settings-action"
            onClick={() => void clearResumeRecords()}
          >
            <Trash2 size={13} />
            Clear saved sessions
          </button>
          <small>
            Sessions are saved to the resume store; nothing is executed until you click Resume.
          </small>
        </div>
      </div>
    </section>
  );
}