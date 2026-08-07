import { Plus, ShieldCheck, Trash2 } from "lucide-react";
import type { ChangeEvent, KeyboardEvent } from "react";

type BrowserOriginsSectionProps = {
  trustedOrigins: string[];
  originInput: string;
  originNotice: string | null;
  originBusy: boolean;
  setOriginInput: (value: string) => void;
  addTrustedOrigin: () => Promise<void>;
  revokeTrustedOrigin: (origin: string) => Promise<void>;
  clearTrustedOrigins: () => Promise<void>;
};

export function BrowserOriginsSection({
  trustedOrigins,
  originInput,
  originNotice,
  originBusy,
  setOriginInput,
  addTrustedOrigin,
  revokeTrustedOrigin,
  clearTrustedOrigins,
}: BrowserOriginsSectionProps) {
  return (
    <section className="settings-section" aria-labelledby="settings-browser-origins-title">
      <div className="settings-section__heading">
        <div className="settings-section__heading-main">
          <ShieldCheck size={15} aria-hidden="true" />
          <div>
            <h3 id="settings-browser-origins-title">Trusted browser origins</h3>
            <p className="settings-section__description">
              Agents may evaluate JavaScript inside a browser pane only when the pane is on a
              loopback address (localhost, 127.0.0.1, ::1) or on an origin you trust here. Loopback
              is always allowed and needs no entry.
            </p>
          </div>
        </div>
      </div>
      <div className="agent-integrations">
        {trustedOrigins.length === 0 ? (
          <div className="agent-integrations__row">
            <div className="agent-integrations__row-main">
              <div className="agent-integrations__text">
                <strong>No trusted origins</strong>
                <small>Browser eval is fail-closed: remote origins require explicit trust.</small>
              </div>
            </div>
          </div>
        ) : (
          trustedOrigins.map((origin) => (
            <div className="agent-integrations__row" key={origin}>
              <div className="agent-integrations__row-main">
                <div className="agent-integrations__text">
                  <strong>{origin}</strong>
                  <small>Remote origin allowed for browser.eval</small>
                </div>
              </div>
              <button
                type="button"
                className="settings-action"
                disabled={originBusy}
                onClick={() => void revokeTrustedOrigin(origin)}
              >
                Remove
              </button>
            </div>
          ))
        )}
        <div className="agent-integrations__row agent-integrations__row--input">
          <div className="agent-integrations__row-main">
            <div className="agent-integrations__text">
              <strong>Add origin</strong>
              <small>e.g. https://example.com or https://example.com:8443</small>
            </div>
          </div>
          <div className="agent-integrations__add">
            <input
              type="text"
              value={originInput}
              placeholder="https://…"
              onChange={(event: ChangeEvent<HTMLInputElement>) => setOriginInput(event.target.value)}
              onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                if (event.key === "Enter") void addTrustedOrigin();
              }}
              aria-label="Trusted browser origin"
            />
            <button
              type="button"
              className="settings-action"
              disabled={originBusy || originInput.trim().length === 0}
              onClick={() => void addTrustedOrigin()}
            >
              <Plus size={13} />
              Add
            </button>
          </div>
        </div>
        {originNotice ? (
          <div className="agent-integrations__footer">
            <small className="agent-integrations__status">{originNotice}</small>
          </div>
        ) : null}
        <div className="agent-integrations__footer">
          <button
            type="button"
            className="settings-action"
            disabled={originBusy || trustedOrigins.length === 0}
            onClick={() => void clearTrustedOrigins()}
          >
            <Trash2 size={13} />
            Clear all origins
          </button>
          <small>
            Loopback origins stay evaluable even with an empty list; this only revokes remote
            trust.
          </small>
        </div>
      </div>
    </section>
  );
}