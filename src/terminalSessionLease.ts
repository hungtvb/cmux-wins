const MAX_CLIENT_ID_LENGTH = 128;

export class TerminalSessionLeaseRegistry {
  private readonly owners = new Map<string, string>();

  claim(sessionId: string, clientId: string): void {
    this.owners.set(sessionId, clientId);
  }

  owns(sessionId: string, clientId: string): boolean {
    return this.owners.get(sessionId) === clientId;
  }

  release(sessionId: string, clientId: string): boolean {
    if (!this.owns(sessionId, clientId)) return false;
    this.owners.delete(sessionId);
    return true;
  }
}

let nextClientSequence = 0;

export function createTerminalClientId(sessionId: string): string {
  nextClientSequence += 1;
  const randomPart = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${nextClientSequence}`;
  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 48) || "terminal";
  return `${safeSessionId}:${randomPart}`.slice(0, MAX_CLIENT_ID_LENGTH);
}

export const terminalSessionLeases = new TerminalSessionLeaseRegistry();
