/**
 * Font availability helpers for the Settings dialog.
 *
 * WebView2 (Chromium) exposes `document.fonts` (a FontFaceSet) which supports
 * `check()` to ask whether a given font string is available without triggering
 * a download. We use it to give a non-blocking hint in Settings when a chosen
 * family (e.g. a Nerd Font for Oh My Posh) is likely unavailable on the box.
 * This never installs or downloads fonts — it only reads the available set.
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

export function checkFontAvailability(familyStack: string): FontCheckResult {
  if (typeof document === "undefined" || !document.fonts?.check) {
    return { family: familyStack, status: "unknown", missingFamily: null };
  }
  const families = extractFamilies(familyStack);
  if (families.length === 0) {
    return { family: familyStack, status: "unknown", missingFamily: null };
  }

  let firstUnavailable: string | null = null;
  let seenExplicit = false;
  for (const family of families) {
    // A generic family is always available; stop at the first generic because
    // everything after it is just a generic fallback.
    if (GENERIC_FAMILIES.has(family)) break;
    seenExplicit = true;
    if (document.fonts.check(`16px "${family}"`)) {
      // This explicit family resolves — the stack is fine.
      return { family: familyStack, status: "available", missingFamily: null };
    }
    if (firstUnavailable === null) firstUnavailable = family;
  }

  if (!seenExplicit) {
    // Only generics in the stack — always usable.
    return { family: familyStack, status: "available", missingFamily: null };
  }

  return {
    family: familyStack,
    status: "unavailable",
    missingFamily: firstUnavailable,
  };
}