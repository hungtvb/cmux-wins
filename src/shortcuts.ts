export const SHORTCUT_ACTIONS = [
  { id: "settings.open", label: "Open settings", description: "Open the TonyMux settings dialog", section: "General", defaultBinding: "Ctrl+Comma" },
  { id: "commandPalette.open", label: "Open command palette", description: "Search and run TonyMux actions", section: "General", defaultBinding: "Ctrl+KeyK" },
  { id: "notifications.toggle", label: "Show notifications", description: "Open the agent attention panel", section: "General", defaultBinding: "Ctrl+Shift+KeyU" },
  { id: "workspace.new", label: "New workspace", description: "Create a local developer workspace", section: "Workspace", defaultBinding: "Ctrl+KeyN" },
  { id: "workspace.close", label: "Close workspace", description: "Close the active workspace and its panes", section: "Workspace", defaultBinding: "Ctrl+Shift+KeyW" },
  { id: "pane.splitTerminal", label: "Split terminal", description: "Add another terminal pane", section: "Panes", defaultBinding: "Ctrl+Shift+KeyD" },
  { id: "pane.openBrowser", label: "Open browser pane", description: "Create an embedded WebView2 browser", section: "Panes", defaultBinding: "Ctrl+Shift+KeyB" },
  { id: "layout.toggleSidebar", label: "Toggle sidebar", description: "Show or hide the workspace navigator", section: "View", defaultBinding: "Ctrl+KeyB" },
  { id: "workspace.select1", label: "Switch to workspace 1", description: "Activate workspace slot 1", section: "Workspace", defaultBinding: "Ctrl+Digit1" },
  { id: "workspace.select2", label: "Switch to workspace 2", description: "Activate workspace slot 2", section: "Workspace", defaultBinding: "Ctrl+Digit2" },
  { id: "workspace.select3", label: "Switch to workspace 3", description: "Activate workspace slot 3", section: "Workspace", defaultBinding: "Ctrl+Digit3" },
  { id: "workspace.select4", label: "Switch to workspace 4", description: "Activate workspace slot 4", section: "Workspace", defaultBinding: "Ctrl+Digit4" },
  { id: "workspace.select5", label: "Switch to workspace 5", description: "Activate workspace slot 5", section: "Workspace", defaultBinding: "Ctrl+Digit5" },
  { id: "workspace.select6", label: "Switch to workspace 6", description: "Activate workspace slot 6", section: "Workspace", defaultBinding: "Ctrl+Digit6" },
  { id: "workspace.select7", label: "Switch to workspace 7", description: "Activate workspace slot 7", section: "Workspace", defaultBinding: "Ctrl+Digit7" },
  { id: "workspace.select8", label: "Switch to workspace 8", description: "Activate workspace slot 8", section: "Workspace", defaultBinding: "Ctrl+Digit8" },
  { id: "workspace.select9", label: "Switch to workspace 9", description: "Activate workspace slot 9", section: "Workspace", defaultBinding: "Ctrl+Digit9" },
] as const;

export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];
export type ShortcutActionId = ShortcutAction["id"];
export type ShortcutBinding = string | null;
export type ShortcutBindings = Record<ShortcutActionId, ShortcutBinding>;

export type ShortcutKeyboardEvent = {
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  code: string;
  isComposing?: boolean;
  repeat?: boolean;
};

export type ShortcutConflict = {
  binding: string;
  actionIds: ShortcutActionId[];
};

const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift"] as const;
const MODIFIER_SET = new Set<string>(MODIFIER_ORDER);
const ALLOWED_NAMED_CODES = new Set([
  "Backspace", "Delete", "Enter", "Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown", "Comma", "Period", "Slash", "Semicolon", "Quote",
  "BracketLeft", "BracketRight", "Backslash", "Minus", "Equal", "Backquote",
]);

const CODE_LABELS: Record<string, string> = {
  Backspace: "Backspace", Delete: "Delete", Enter: "Enter", Space: "Space",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
  Home: "Home", End: "End", PageUp: "Page Up", PageDown: "Page Down",
  Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'",
  BracketLeft: "[", BracketRight: "]", Backslash: "\\", Minus: "-", Equal: "=", Backquote: "`",
};

export const DEFAULT_SHORTCUT_BINDINGS = Object.fromEntries(
  SHORTCUT_ACTIONS.map((action) => [action.id, action.defaultBinding]),
) as ShortcutBindings;

function isAllowedCode(code: string): boolean {
  return /^Key[A-Z]$/.test(code) || /^Digit[0-9]$/.test(code) || /^F(?:[1-9]|1[0-2])$/.test(code) || ALLOWED_NAMED_CODES.has(code);
}

function isReservedSystemChord(ctrl: boolean, alt: boolean, code: string): boolean {
  return (ctrl && alt && code === "Delete") || (alt && !ctrl && code === "F4");
}

export function normalizeShortcutBinding(value: unknown, fallback: ShortcutBinding = null): ShortcutBinding {
  if (value === null) return null;
  if (typeof value !== "string") return fallback;
  const tokens = value.split("+").map((token) => token.trim()).filter(Boolean);
  const modifiers = new Set<string>();
  let code = "";
  for (const token of tokens) {
    if (MODIFIER_SET.has(token)) {
      if (modifiers.has(token)) return fallback;
      modifiers.add(token);
      continue;
    }
    if (code || !isAllowedCode(token)) return fallback;
    code = token;
  }
  const ctrl = modifiers.has("Ctrl");
  const alt = modifiers.has("Alt");
  if (!code || (!ctrl && !alt) || isReservedSystemChord(ctrl, alt, code)) return fallback;
  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), code].join("+");
}

export function normalizeShortcutBindings(value: unknown): ShortcutBindings {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(SHORTCUT_ACTIONS.map((action) => [
    action.id,
    Object.prototype.hasOwnProperty.call(candidate, action.id)
      ? normalizeShortcutBinding(candidate[action.id], action.defaultBinding)
      : action.defaultBinding,
  ])) as ShortcutBindings;
}

export function cloneDefaultShortcutBindings(): ShortcutBindings {
  return { ...DEFAULT_SHORTCUT_BINDINGS };
}

export function shortcutFromKeyboardEvent(event: ShortcutKeyboardEvent): ShortcutBinding {
  if (event.isComposing || event.repeat || event.metaKey) return null;
  if (!event.ctrlKey && !event.altKey) return null;
  if (!isAllowedCode(event.code) || event.code === "Tab" || event.code === "Escape") return null;
  if (isReservedSystemChord(event.ctrlKey, event.altKey, event.code)) return null;
  return [event.ctrlKey ? "Ctrl" : null, event.altKey ? "Alt" : null, event.shiftKey ? "Shift" : null, event.code]
    .filter(Boolean)
    .join("+");
}

export function shortcutMatchesEvent(binding: ShortcutBinding, event: ShortcutKeyboardEvent): boolean {
  return Boolean(binding) && shortcutFromKeyboardEvent(event) === binding;
}

export function formatShortcutBinding(binding: ShortcutBinding): string {
  if (!binding) return "Unassigned";
  return binding.split("+").map((token) => {
    if (token.startsWith("Key")) return token.slice(3);
    if (token.startsWith("Digit")) return token.slice(5);
    return CODE_LABELS[token] ?? token;
  }).join(" + ");
}

export function findShortcutConflicts(bindings: ShortcutBindings): ShortcutConflict[] {
  const actionsByBinding = new Map<string, ShortcutActionId[]>();
  for (const action of SHORTCUT_ACTIONS) {
    const binding = bindings[action.id];
    if (!binding) continue;
    const actionIds = actionsByBinding.get(binding) ?? [];
    actionIds.push(action.id);
    actionsByBinding.set(binding, actionIds);
  }
  return [...actionsByBinding.entries()]
    .filter(([, actionIds]) => actionIds.length > 1)
    .map(([binding, actionIds]) => ({ binding, actionIds }));
}

export function findShortcutConflict(bindings: ShortcutBindings, actionId: ShortcutActionId, binding: ShortcutBinding): ShortcutActionId | null {
  if (!binding) return null;
  return SHORTCUT_ACTIONS.find((action) => action.id !== actionId && bindings[action.id] === binding)?.id ?? null;
}

export function getShortcutAction(actionId: ShortcutActionId): ShortcutAction {
  const action = SHORTCUT_ACTIONS.find((candidate) => candidate.id === actionId);
  if (!action) throw new Error(`Unknown shortcut action: ${actionId}`);
  return action;
}

export function getWorkspaceShortcutActionId(index: number): ShortcutActionId | null {
  return index >= 0 && index < 9 ? (`workspace.select${index + 1}` as ShortcutActionId) : null;
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  const element = target as {
    tagName?: string;
    isContentEditable?: boolean;
    classList?: { contains: (name: string) => boolean };
    closest?: (selector: string) => unknown;
  } | null;
  if (!element) return false;
  if (element.classList?.contains("xterm-helper-textarea") || element.closest?.(".xterm")) return false;
  const tagName = element.tagName?.toUpperCase();
  return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT" || Boolean(element.isContentEditable) || Boolean(element.closest?.('[contenteditable="true"]'));
}
