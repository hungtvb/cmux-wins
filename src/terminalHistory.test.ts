import { describe, expect, it } from "vitest";
import {
  MAX_TERMINAL_HISTORY_BYTES_PER_PANE,
  MAX_TERMINAL_HISTORY_LINES,
  normalizeTerminalHistoryLineLimit,
  sanitizeTerminalHistory,
  terminalHistoryByteLength,
} from "./terminalHistory";

describe("terminal history", () => {
  it("normalizes line endings and removes terminal control payloads", () => {
    const history = sanitizeTerminalHistory(
      "one\r\n\u001b]0;owned\u0007two\u001b[31m red\u001b[0m\rthree\u009dnotify\u009c\tfour",
      50,
    );

    expect(history).toBe("one\ntwo red\nthree\tfour");
    expect(history).not.toContain("\u001b");
    expect(history).not.toContain("\u0007");
    expect(history).not.toContain("\u009d");
  });

  it("drops complete OSC 8, DCS, APC and nested escape payloads", () => {
    const history = sanitizeTerminalHistory(
      [
        "before",
        "\u001b]8;;https://example.com\u001b\\linked\u001b]8;;\u001b\\ after",
        "\u001bPprivate-device-payload\u001b\\visible",
        "\u001b_secret-apc\u001b\\done",
        "\u001b[31\u001b]0;nested\u0007safe",
      ].join("\n"),
      50,
    );

    expect(history).toBe("before\nlinked after\nvisible\ndone\nsafe");
    expect(history).not.toMatch(/example|private|secret|nested/);
  });

  it("keeps the newest lines deterministically", () => {
    expect(sanitizeTerminalHistory("one\ntwo\nthree\nfour", 2, 100)).toBe("three\nfour");
  });

  it("truncates from the oldest UTF-8 content without splitting characters", () => {
    const history = sanitizeTerminalHistory("old\n🙂🙂new", 10, 9);

    expect(history).toBe("🙂new");
    expect(terminalHistoryByteLength(history)).toBeLessThanOrEqual(9);
  });

  it("supports an explicit disabled value and clamps configured limits", () => {
    expect(sanitizeTerminalHistory("secret", 0)).toBe("");
    expect(normalizeTerminalHistoryLineLimit(-1)).toBe(0);
    expect(normalizeTerminalHistoryLineLimit(99_999)).toBe(MAX_TERMINAL_HISTORY_LINES);
  });

  it("enforces the per-pane byte ceiling", () => {
    const history = sanitizeTerminalHistory(
      "x".repeat(MAX_TERMINAL_HISTORY_BYTES_PER_PANE + 32),
      MAX_TERMINAL_HISTORY_LINES,
    );

    expect(terminalHistoryByteLength(history)).toBe(MAX_TERMINAL_HISTORY_BYTES_PER_PANE);
  });
});
