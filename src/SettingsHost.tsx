import { useCallback, useEffect, useState } from "react";
import App from "./App";
import { SettingsDialog } from "./components/SettingsDialog";
import { loadSettings, saveSettings, type AppSettings } from "./settings";
import { clearWorkspaceState } from "./workspacePersistence";

export const OPEN_SETTINGS_EVENT = "tonymux-open-settings";

export default function SettingsHost() {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const openSettings = () => setOpen(true);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && !event.altKey && !event.shiftKey && event.key === ",") {
        event.preventDefault();
        setOpen(true);
      }
    };

    window.addEventListener(OPEN_SETTINGS_EVENT, openSettings);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener(OPEN_SETTINGS_EVENT, openSettings);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const handleSave = useCallback((nextSettings: AppSettings) => {
    saveSettings(nextSettings);
    setSettings(nextSettings);
  }, []);

  const handleClearWorkspaceState = useCallback(() => {
    clearWorkspaceState();
  }, []);

  return (
    <>
      <App settings={settings} />
      <SettingsDialog
        open={open}
        settings={settings}
        onSave={handleSave}
        onClearWorkspaceState={handleClearWorkspaceState}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
