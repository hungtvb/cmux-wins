# TonyMux Design System — Quiet Operator

> **Status:** Approved product baseline
> **Version:** 1.0
> **Implementation:** Incremental adoption pending

This document is the source of truth for future TonyMux UI design, review, and implementation. Material visual-direction changes must update this document in the same pull request.

## Product definition

TonyMux is a Windows 11 developer workspace for terminal-driven and AI-assisted workflows. It is not an API dashboard, analytics console, model router, billing product, or mobile application.

The interface must prioritize:

- multiple project workspaces;
- ConPTY terminal panes;
- native WebView2 browser panes;
- split-pane work;
- repository, branch, pull request, divergence, and listening-port context;
- agent-attention signals;
- keyboard-first commands;
- settings, shell profiles, trust state, shortcuts, and session restoration;
- local automation without turning the product into an operations dashboard.

A TonyMux screen should still look like a developer workspace when labels and branding are removed.

## Direction: Quiet Operator

Quiet Operator is dark, precise, compact, and low-distraction.

Use:

- border-led flat surfaces;
- restrained technical metadata;
- Windows-native typography and behavior;
- explicit focus, running, warning, failure, and attention states;
- terminal and browser content as the visual center.

Avoid:

- cyberpunk neon or decorative glow;
- glass across primary surfaces;
- dashboard card grids and decorative charts;
- large gradients;
- mobile navigation patterns;
- excessive rounded pills;
- effects that compete with terminal or browser content.

## Principles

1. **Content over chrome** — terminal and browser content dominate.
2. **One interaction accent** — blue means focus, selection, and primary interaction.
3. **Dense, not cramped** — show technical context through grouping and hierarchy.
4. **State is explicit** — pair color with text, icon, shape, or position.
5. **Windows-native precision** — use familiar desktop sizing and interaction.
6. **Keyboard first, pointer complete** — fast by keyboard, discoverable by pointer.
7. **Progressive detail** — advanced trust and automation details stay available without overwhelming the workspace.

## Foundation tokens

These are target tokens. Existing CSS variables may migrate incrementally, but new UI should not introduce a competing palette without updating this document.

```css
:root {
  --tm-canvas: #0a0d12;
  --tm-surface-0: #0e1218;
  --tm-surface-1: #121821;
  --tm-surface-2: #18202b;
  --tm-surface-3: #202a37;
  --tm-hover: #1b2531;

  --tm-border-subtle: #222b36;
  --tm-border-default: #2d3846;
  --tm-border-strong: #425166;

  --tm-text-strong: #f1f4f8;
  --tm-text: #c7cfda;
  --tm-text-muted: #8792a2;
  --tm-text-faint: #626d7c;

  --tm-focus: #72a7ff;
  --tm-focus-soft: rgba(114, 167, 255, 0.12);
  --tm-focus-ring: rgba(114, 167, 255, 0.78);

  --tm-success: #66c997;
  --tm-warning: #e4b86a;
  --tm-danger: #ef8292;
  --tm-attention: #b9a0ff;

  --tm-font-ui: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
  --tm-font-mono: "Cascadia Code", "Cascadia Mono", Consolas, monospace;

  --tm-motion-fast: 100ms;
  --tm-motion-standard: 150ms;
  --tm-ease: cubic-bezier(0.2, 0.8, 0.2, 1);
}
```

### Semantic color contract

| Color | Reserved meaning |
|---|---|
| Blue | active workspace, active pane, keyboard focus, selected command, primary action |
| Green | connected, running, healthy, or clean |
| Amber | modified, degraded, timeout, or caution |
| Red | destructive, failure, or blocked |
| Violet | an agent or process requires human input |

Violet is not generic branding. Agent attention must remain distinct from selection and focus.

### Typography

| Token | Size / line height | Use |
|---|---:|---|
| `label-xs` | 10 / 14 | section labels and compact metadata |
| `body-sm` | 11 / 16 | secondary sidebar text and hints |
| `body` | 12 / 18 | buttons, pane titles, standard UI |
| `title-sm` | 13 / 18 | workspace title |
| `title` | 15 / 20 | dialog and command-palette title |
| `mono` | 12–13 / 1.35 | terminal, branch, port, command, shortcut |

Use monospace for technical values, not for the whole application UI.

### Dimensions

TonyMux uses a 4px spacing unit.

| Surface | Target |
|---|---:|
| Expanded sidebar | 248px |
| Workspace topbar | 54px |
| Pane header | 32px |
| Standard control | 30px high |
| Compact icon button | 28–30px square |
| Workspace row | 64px minimum |
| Minimum pane width | 320px |
| Resizer hit target | 8px |
| Visible resizer grip | 2px |

Use 4px radius for tiny labels, 6px for controls, 8px for workspace rows and menus, and 12px only for the command palette and Settings. Primary surfaces use borders rather than shadows.

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

- Active row uses a blue inset edge and calm tinted fill.
- Modified state uses amber plus explicit text or an accessible tooltip.
- Agent input uses violet plus a `Needs input` accessible label.
- PR, divergence, and ports use compact metadata chips.
- Close remains keyboard reachable.
- Workspace numbers remain visible for `Ctrl+1` through `Ctrl+9`.

### `WorkspaceTopbar`

- Leading area: sidebar toggle, workspace title, clean/modified state, repository, branch, and pane context.
- Action area: new workspace, split terminal, browser pane, clear attention, command palette, overflow, and Settings.
- Collapse text labels before removing actions at narrower desktop widths.

### `ResizablePaneGrid`

- Use a neutral split canvas.
- Keep the existing keyboard-accessible resizer.
- Focus belongs to the active pane, not the grid background.

### `TerminalPane`

- Terminal content is darker and flatter than application chrome.
- Active and agent-attention states can coexist.
- Restored history remains clearly separate from the live shell.

### `BrowserPane`

- Navigation stays in one compact row.
- Native WebView2 content remains dominant.
- Loading, timeout, rejection, and recoverable errors use inline banners.

### `CommandPalette`

- Target width: 640px, positioned near 10–12vh.
- Search receives focus immediately.
- Group by Workspace, Pane, Application, and Destructive.
- Selected commands use a flat blue-tinted background.

### `SettingsDialog`

Group settings by Shells, Terminal, Keyboard shortcuts, Persistence, Trusted executables, and Import/Export/Recovery. Use progressive disclosure for trust identity and recovery details.

## Interaction and accessibility

- Hover and focus transitions: 100–150ms.
- Avoid bounce, scale, and decorative spring motion.
- Respect `prefers-reduced-motion` globally.
- Normal text targets WCAG AA contrast.
- Icon-only controls require an accessible name and tooltip.
- Status never depends on color alone.
- Command Palette and Settings trap focus and close with Escape.
- Dense desktop targets should not fall below 28px.
- Truncated technical values retain a discoverable full value.

## Implementation mapping

| Existing surface | Quiet Operator target |
|---|---|
| `src/components/WorkspaceSidebar.tsx` | workspace hierarchy, metadata, unread attention |
| `src/components/WorkspaceTopbar.tsx` | compact contextual header and grouped actions |
| `src/components/ResizablePaneGrid.tsx` | neutral split canvas and accessible resizer |
| `src/components/TerminalPane.tsx` | focused terminal, restored boundary, attention state |
| `src/components/BrowserPane.tsx` | compact navigation and inline recovery |
| `src/components/CommandPalette.tsx` | elevated keyboard-first action surface |
| `src/components/SettingsDialog.tsx` | dense structured form and trust lifecycle |
| `src/styles.css` and feature CSS | incremental token and state migration |

The current implementation already follows parts of this direction, but its existing values are not yet the complete Quiet Operator system.

## Adoption sequence

1. Introduce `--tm-*` tokens and map current variables to them.
2. Normalize typography to Segoe UI Variable and Cascadia Code fallbacks.
3. Align sidebar, topbar, pane header, and control dimensions.
4. Separate focus blue from agent-attention violet.
5. Normalize active, loading, warning, failure, and recovery states.
6. Apply the system to Command Palette and Settings.
7. Capture common Windows desktop sizes and run accessibility checks.

Adopt the system in reviewable slices. Do not combine a full visual rewrite with structural or behavioral changes.

## Review checklist

- Does terminal or browser content remain dominant?
- Is selection blue and human-required attention violet?
- Is technical metadata explicit without becoming a dashboard?
- Are keyboard focus and shortcut discovery preserved?
- Does the change work for terminal and browser panes?
- Are loading, empty, restored, failure, and attention states covered?
- Is reduced motion usable?
- Does the screen still read as a Windows developer workspace without branding?

## Product kill-test

The design fails if a screenshot could be mistaken for an API analytics dashboard, billing console, model-provider router, or mobile app.

A representative TonyMux workspace should show workspace navigation, repository and branch context, at least one terminal pane, pane-level focus, keyboard-first actions, and browser or second-terminal splitting when relevant.
