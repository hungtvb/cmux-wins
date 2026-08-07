/**
 * Font availability helpers for the Settings dialog.
 *
 * WebView2 (Chromium) exposes `document.fonts` (a FontFaceSet). `check()` is
 * not reliable here: Chromium resolves an unknown family to an auto-generated
 * fallback and reports it as present. We therefore use `fonts.load()`, which
 * returns the list of FontFace objects actually loaded for the family — an
 * empty array means the family is not installed. This never installs or
 * downloads fonts; it only queries the local font set.
 */

export type FontCheckStatus = "available" | "unavailable" | "unknown";

export type FontCheckResult = {
  /** The full stack the user selected. */
  family: string;
  status: FontCheckStatus;
  /** First explicit family in the stack that was not found, if any. */
  missingFamily: string | null;
};

const GENERIC_FAMILIES = new Set(["monospace", "sans-serif", "serif", "cursive", "fantasy"]);

export function extractFamilies(familyStack: string): string[] {
  // Split a CSS font-family stack on commas, strip quotes and whitespace.
  return familyStack
    .split(",")
    .map((part) => part.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/**
 * Resolve the first installed family in a stack. Async because it relies on
 * `document.fonts.load()`, which goes through the font loading pipeline.
 */
export async function checkFontAvailability(familyStack: string): Promise<FontCheckResult> {
  const base = { family: familyStack, missingFamily: null };
  if (typeof document === "undefined" || !document.fonts?.load) {
    return { ...base, status: "unknown" };
  }
  const families = extractFamilies(familyStack);
  if (families.length === 0) {
    return { ...base, status: "unknown" };
  }

  for (const family of families) {
    if (GENERIC_FAMILIES.has(family)) break;
    try {
      const loaded = await document.fonts.load(`16px "${family}"`);
      if (loaded.length > 0) {
        return { ...base, status: "available" };
      }
    } catch {
      return { ...base, status: "unknown" };
    }
  }

  const explicit = families.filter((family) => !GENERIC_FAMILIES.has(family));
  if (explicit.length === 0) {
    return { ...base, status: "available" };
  }
  return { ...base, status: "unavailable", missingFamily: explicit[0] ?? null };
}