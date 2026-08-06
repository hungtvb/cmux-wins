export const DEFAULT_TERMINAL_HISTORY_LINES = 500;
export const MAX_TERMINAL_HISTORY_LINES = 5_000;
export const MAX_TERMINAL_HISTORY_BYTES_PER_PANE = 512 * 1024;
export const MAX_TERMINAL_HISTORY_BYTES_TOTAL = 4 * 1024 * 1024;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

function stripTerminalControlSequences(value: string): string {
  type ParserState = "normal" | "escape" | "csi" | "osc" | "string" | "oscEscape" | "stringEscape";
  let state: ParserState = "normal";
  let result = "";

  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;

    if (state === "normal") {
      if (codePoint === 0x1b) {
        state = "escape";
      } else if (codePoint === 0x9b) {
        state = "csi";
      } else if (codePoint === 0x9d) {
        state = "osc";
      } else if ([0x90, 0x98, 0x9e, 0x9f].includes(codePoint)) {
        state = "string";
      } else if (character === "\n" || character === "\t") {
        result += character;
      } else if (
        codePoint >= 0x20 &&
        codePoint !== 0x7f &&
        !(codePoint >= 0x80 && codePoint <= 0x9f) &&
        codePoint !== 0x2028 &&
        codePoint !== 0x2029
      ) {
        result += character;
      }
      continue;
    }

    if (state === "escape") {
      if (character === "[" || codePoint === 0x9b) state = "csi";
      else if (character === "]" || codePoint === 0x9d) state = "osc";
      else if (
        ["P", "X", "^", "_"].includes(character) ||
        [0x90, 0x98, 0x9e, 0x9f].includes(codePoint)
      ) state = "string";
      else if (codePoint === 0x1b) state = "escape";
      else if (codePoint < 0x20 || codePoint > 0x2f) state = "normal";
      continue;
    }

    if (state === "csi") {
      if (codePoint === 0x1b) state = "escape";
      else if (codePoint === 0x9b) state = "csi";
      else if (codePoint === 0x9d) state = "osc";
      else if ([0x90, 0x98, 0x9e, 0x9f].includes(codePoint)) state = "string";
      else if (codePoint >= 0x40 && codePoint <= 0x7e) state = "normal";
      continue;
    }

    if (state === "osc") {
      if (codePoint === 0x07 || codePoint === 0x9c) state = "normal";
      else if (codePoint === 0x1b) state = "oscEscape";
      continue;
    }

    if (state === "string") {
      if (codePoint === 0x9c) state = "normal";
      else if (codePoint === 0x1b) state = "stringEscape";
      continue;
    }

    if (state === "oscEscape") {
      state = character === "\\" ? "normal" : "osc";
      continue;
    }

    state = character === "\\" ? "normal" : "string";
  }

  return result;
}
function trimOldestUtf8Bytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0 || !value) return "";

  const encoded = utf8Encoder.encode(value);
  if (encoded.byteLength <= maxBytes) return value;

  let startIndex = encoded.byteLength - maxBytes;
  while (startIndex < encoded.byteLength && (encoded[startIndex] & 0xc0) === 0x80) {
    startIndex += 1;
  }

  return utf8Decoder.decode(encoded.subarray(startIndex)).replace(/^\n+/, "");
}

export function normalizeTerminalHistoryLineLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TERMINAL_HISTORY_LINES;
  }

  return Math.round(Math.min(MAX_TERMINAL_HISTORY_LINES, Math.max(0, value)));
}

export function sanitizeTerminalHistory(
  value: unknown,
  maxLines = DEFAULT_TERMINAL_HISTORY_LINES,
  maxBytes = MAX_TERMINAL_HISTORY_BYTES_PER_PANE,
): string {
  const lineLimit = normalizeTerminalHistoryLineLimit(maxLines);
  if (typeof value !== "string" || lineLimit === 0 || maxBytes <= 0) return "";

  const normalizedNewlines = value.replace(/\r\n?/g, "\n");
  const inertText = stripTerminalControlSequences(normalizedNewlines);
  const lines = inertText.split("\n");
  const lineBounded = lines.slice(-lineLimit).join("\n").replace(/^\n+|\n+$/g, "");

  return trimOldestUtf8Bytes(lineBounded, maxBytes);
}

export function terminalHistoryByteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}
