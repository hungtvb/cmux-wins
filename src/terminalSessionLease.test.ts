import { describe, expect, it } from "vitest";
import {
  TerminalSessionLeaseRegistry,
  createTerminalClientId,
} from "./terminalSessionLease";

describe("terminal session leases", () => {
  it("prevents stale cleanup from releasing a newer pane owner", () => {
    const leases = new TerminalSessionLeaseRegistry();
    leases.claim("terminal-1", "client-old");
    leases.claim("terminal-1", "client-new");

    expect(leases.release("terminal-1", "client-old")).toBe(false);
    expect(leases.owns("terminal-1", "client-new")).toBe(true);
    expect(leases.release("terminal-1", "client-new")).toBe(true);
    expect(leases.owns("terminal-1", "client-new")).toBe(false);
  });

  it("creates bounded backend-safe client identifiers", () => {
    const clientId = createTerminalClientId("terminal / unsafe id");

    expect(clientId.length).toBeGreaterThan(0);
    expect(clientId.length).toBeLessThanOrEqual(128);
    expect(clientId).toMatch(/^[a-zA-Z0-9_.:-]+$/);
  });
});
