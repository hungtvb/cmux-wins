# TonyMux Design System — Tony Workspace

> **Status:** Active product baseline
> **Version:** 2.0
> **Primary mode:** Workspace
> **Shared foundation:** `tony-design-system` 1.0

This document is the product-specific source of truth for TonyMux UI design, review, and implementation. Shared Tony foundations define the visual DNA; this file defines how those foundations apply to a Windows desktop terminal workspace.

## Product definition

TonyMux is a Windows 11 developer workspace for terminal-driven and AI-assisted workflows. It is not an API dashboard, analytics console, model router, billing product, or mobile application.

The interface prioritizes:

- multiple project workspaces;
- ConPTY terminal panes;
- native WebView2 browser panes;
- split-pane work;
- repository, branch, pull request, divergence, and listening-port context;
- agent-attention signals;
- keyboard-first commands;
- settings, shell profiles, trust state, shortcuts, and session restoration;
- local automation without an operations-dashboard shell.

A TonyMux screen must still read as a developer workspace when labels and branding are removed.

## Product mode: Workspace

TonyMux uses the shared Tony **Workspace** mode:

- compact but legible information density;
- sidebars, command surfaces, panes, structured status, and technical metadata;
- Inter for general UI and JetBrains Mono only for commands, paths, identifiers, logs, and shortcuts;
- borders and surface changes before cards or shadows;
- explicit loading, error, disabled, selected, active, and attention states;
- no charts, KPI cards, or dashboard regions unless they answer a real operational question.

## Direction: Tony Workspace

Tony Workspace is dark-primary, warm-neutral, precise, and low-distraction. It keeps the useful structure of the original Quiet Operator direction while replacing its cool blue product identity with the shared Tony foundation.

Use:

- warm neutral surfaces;
- Tony Lime as a controlled brand and high-importance selection signal;
- blue only for keyboard focus and informational states;
- semantic green, amber, and red for health, caution, and failure;
- border-led flat surfaces;
- explicit text or icons alongside status colors;
- terminal and browser content as the visual center.

Avoid:

- cyberpunk neon and decorative glow;
- glass across primary surfaces;
- dashboard card grids and decorative charts;
- large gradients;
- all-monospace UI;
- Tony Lime as success green or on every action;
- excessive rounded pills;
- effects that compete with terminal or browser content.

## Principles

1. **Content over chrome** — terminal and browser content dominate.
2. **Tony identity with restraint** — Lime marks brand, a selected workspace, the active pane, and a controlled primary action.
3. **Focus remains independent** — blue focus rings identify keyboard focus and are never replaced by Lime.
4. **Dense, not cramped** — technical context is grouped and readable at desktop density.
5. **State is explicit** — pair color with text, icon, shape, or position.
6. **Keyboard first, pointer complete** — fast by keyboard and discoverable by pointer.
7. **Progressive detail** — trust, persistence, and automation details remain available without overwhelming the workspace.

## Foundation tokens

Reusable components consume semantic tokens instead of raw colors.

```css
:root {
  color-scheme: dark;

  --tm-canvas: #10100f;
  --tm-surface-0: #151513;
  --tm-surface-1: #191917;
  --tm-surface-2: #222220;
  --tm-surface-3: #282825;
  --tm-hover: #2d2d2a;

  --tm-border-subtle: #2d2d2a;
  --tm-border-default: #3d3d39;
  --tm-border-strong: #5f5f59;

  --tm-text-strong: #f5f5f4;
  --tm-text: #c6c6c1;
  --tm-text-muted: #a4a49f;
  --tm-text-faint: #73736e;

  --tm-brand: #d4ff40;
  --tm-brand-strong: #e3ff8a;
  --tm-on-brand: #101204;
  --tm-brand-soft: rgba(212, 255, 64, 0.10);
  --tm-brand-soft-strong: rgba(212, 255, 64, 0.16);
  --tm-brand-border: rgba(212, 255, 64, 0.36);

  --tm-focus: #7aa7ff;
  --tm-focus-soft: rgba(122, 167, 255, 0.12);
  --tm-focus-ring: rgba(122, 167, 255, 0.88);

  --tm-info: #7aa7ff;
  --tm-success: #86d9a5;
  --tm-warning: #f1bd72;
  --tm-danger: #ff9aa8;

  --tm-font-ui: "Inter Variable", Inter, -apple-system, BlinkMacSystemFont,
    "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --tm-font-mono: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;

  --tm-motion-fast: 120ms;
  --tm-motion-standard: 180ms;
  --tm-ease: cubic-bezier(0.2, 0, 0, 1);
}
```

### Color contract

| Token family | Reserved meaning |
|---|---|
| Tony Lime | brand marker, selected workspace, active pane marker, agent/AI signal, one controlled primary action |
| Blue | visible keyboard focus, information, browser loading, restored-history boundary |
| Green | connected, running, healthy, trusted, or clean |
| Amber | modified, degraded, changed, timeout, or caution |
| Red | destructive, failed, blocked, invalid, missing, or untrusted |
| Warm neutral | application chrome, content hierarchy, hover, inactive controls |

Tony Lime and green are not interchangeable. Pane selection and keyboard focus may coexist: selection uses Lime structure; the focused control uses the blue focus ring.

### Typography

| Role | Size / line height | Use |
|---|---:|---|
| Workspace title | 14 / 20 | active workspace identity |
| UI body | 13 / 19 | workspace titles and primary labels |
| Compact control | 11–12 / 16 | desktop buttons and pane chrome |
| Metadata | 10–11 / 15 | repository, path, secondary context |
| Micro label | 8–10 / 13 | counts, state chips, keyboard hints |
| Mono | 10–13 / 1.35 | terminal, branch, port, command, shortcut |

Inter Variable is the primary UI face. Segoe UI remains a platform fallback. JetBrains Mono is the default terminal and technical face; existing user-saved terminal font preferences remain valid.

### Dimensions

TonyMux uses a 4px spacing rhythm.

| Surface | Target |
|---|---:|
| Expanded sidebar | 248px |
| Workspace topbar | 56px |
| Pane header | 32px |
| Standard control | 32px high |
| Compact icon button | 28–32px square |
| Workspace row | 68px minimum; 84px with metadata |
| Minimum pane width | 300–320px |
| Resizer hit target | 8px |
| Visible resizer grip | 2px |

Use 4px radius for tiny labels, 6px for controls, 8px for workspace rows and menus, and 12px only for the command palette and Settings. Primary surfaces use borders rather than shadows. Shadows are reserved for elevated popovers and dialogs.

## Layout contract

```text
┌──────────────────────┬────────────────────────────────────────────┐
│ Workspace sidebar    │ Contextual workspace topbar                │
│                      ├─────────────────────┬──────────────────────┤
│ repository           │ Terminal pane       │ Browser/terminal     │
│ branch               │                     │ pane                 │
│ PR / divergence      │                     │                      │
│ listening ports      │                     │                      │
│ agent attention      │                     │                      │
└──────────────────────┴─────────────────────┴──────────────────────┘
```

Git, pull-request, port, session, and agent information belongs in contextual chrome around terminal and browser panes, not in a separate analytics dashboard.

## Component rules

### `WorkspaceSidebar`

- Active row uses a Lime inset edge, restrained Lime tint, and stronger text.
- Modified state uses amber plus an accessible `Modified` label.
- Agent input uses a Lime bell plus an accessible unread label.
- PR, divergence, and ports remain compact neutral metadata chips.
- Close appears on hover or focus and remains keyboard reachable.
- Workspace numbers stay visible for `Ctrl+1` through `Ctrl+9`.

### `WorkspaceTopbar`

- Leading area: sidebar toggle, workspace title, clean/modified state, repository, branch, and pane context.
- Action area: one Lime `New workspace` action, neutral pane actions, command palette, overflow, and Settings.
- Clean is green; modified is amber. Neither uses Lime.
- Collapse text labels before removing actions at narrower desktop widths.

### `ResizablePaneGrid`

- Use a neutral split canvas.
- Keep the keyboard-accessible resizer.
- Hover/active resizer feedback uses Lime; actual keyboard focus still receives a blue outline.
- Focus belongs to the active pane, not the grid background.

### `TerminalPane`

- Terminal content is darker and flatter than application chrome.
- The active pane uses a thin Lime structural marker.
- Agent attention uses a named `Needs input` Lime chip; it does not rely on color alone.
- Restored history uses informational blue so it is not confused with live selection or AI attention.

### `BrowserPane`

- Navigation stays in one compact row.
- Native WebView2 content remains dominant.
- Loading uses informational blue.
- Timeout/caution uses amber and errors use red with inline recovery actions.

### `CommandPalette`

- Target width: 640px, positioned near 10–12vh.
- Search receives focus immediately.
- Group by Workspace, Pane, Application, and Destructive.
- Selected commands use a flat Lime-tinted state; destructive commands keep red semantics.

### `SettingsDialog`

- Group settings by Shells, Terminal, Keyboard shortcuts, Persistence, Trusted executables, and Import/Export/Recovery.
- Selected profiles and the Save action use controlled Lime states.
- Form focus remains blue.
- Success, warning, and error messages use semantic colors.
- Progressive disclosure contains trust identity and recovery detail.

## Responsive behavior

TonyMux remains desktop-first.

- At narrower desktop widths, reduce the sidebar and collapse action text before removing actions.
- When the workspace stage itself is 620px wide or narrower, panes stack vertically and the pointer resizer is removed. This threshold follows available pane space rather than the outer window width, so hiding the sidebar can preserve a horizontal split.
- Dialogs switch to one-column forms and wrapped action rows.
- No mobile bottom navigation, card feed, or dashboard transformation is introduced.

## Accessibility and motion

- Visible blue 2px focus rings with an offset where space permits.
- Status never depends on color alone.
- Icon-only controls require accessible labels and tooltips.
- Pane resizer supports keyboard adjustment.
- Command palette and Settings manage focus and close with Escape.
- Dense pointer targets are at least 28px; primary controls are 32px.
- Motion is 120–180ms and communicates state only.
- `prefers-reduced-motion` and forced-colors modes are supported.

## Composition gate

Before adding UI structure, use this order:

1. typography hierarchy;
2. spacing;
3. alignment and grid;
4. divider or border;
5. surface change;
6. card;
7. shadow.

A card, table, chart, gradient, or dashboard region must answer a concrete user question. Remove it when the function is decorative or duplicates existing context.

## Review gate

A TonyMux UI change is ready for approval only when:

- the terminal/browser workflow remains visually dominant;
- warm neutral and semantic tokens replace reusable raw colors;
- Tony Lime is controlled and not used as success;
- keyboard focus remains visibly blue;
- realistic clean, modified, attention, loading, error, disabled, selected, and restored states are checked;
- narrow desktop behavior does not overflow or hide primary actions;
- reduced-motion and forced-colors behavior remain intact;
- exact-build tests and visual evidence identify the reviewed revision.

## Cheap kill-test

The design fails if a screenshot can be mistaken for an analytics dashboard or a generic blue developer tool. A valid TonyMux screen visibly contains workspace navigation, repository/branch context, a terminal, a browser or second terminal, pane-level selection, keyboard-first actions, warm neutral surfaces, and a restrained Tony Lime signal.
