import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { loadSettings, saveSettings, type AppSettings } from "./settings";
import { watchSystemTheme } from "./theme";
import { OPEN_SETTINGS_EVENT } from "./settingsEvents";
import { isEditableShortcutTarget, shortcutMatchesEvent } from "./shortcuts";
import { clearWorkspaceState } from "./workspacePersistence";

export { OPEN_SETTINGS_EVENT } from "./settingsEvents";

// SettingsDialog is the largest component (~1.9k lines). Lazy-load it so the
// initial bundle stays small; it only matters once the user opens Settings.
const SettingsDialog = lazy(() =>
  import("./components/SettingsDialog").then((m) => ({ default: m.SettingsDialog })),
);

export default function SettingsHost() {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [open, setOpen] = useState(false);

  useEffect(() => watchSystemTheme(), []);

  useEffect(() => {
    const openSettings = () => setOpen(true);
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        open ||
        isEditableShortcutTarget(event.target) ||
        !shortcutMatchesEvent(settings.shortcuts["settings.open"], event)
      ) {
        return;
      }
      event.preventDefault();
      setOpen(true);
    };

    window.addEventListener(OPEN_SETTINGS_EVENT, openSettings);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener(OPEN_SETTINGS_EVENT, openSettings);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, settings.shortcuts]);

  const handleSave = useCallback((nextSettings: AppSettings) => {
    saveSettings(nextSettings);
    setSettings(nextSettings);
  }, []);

  const handleClearWorkspaceState = useCallback(() => {
    clearWorkspaceState();
  }, []);

  return (
    <>
      <ErrorBoundary label="app">
        <App settings={settings} keyboardShortcutsEnabled={!open} />
      </ErrorBoundary>
      <ErrorBoundary label="settings">
        <Suspense fallback={null}>
          <SettingsDialog
            open={open}
            settings={settings}
            onSave={handleSave}
            onClearWorkspaceState={handleClearWorkspaceState}
            onClose={() => setOpen(false)}
          />
        </Suspense>
      </ErrorBoundary>
    </>
  );
}
