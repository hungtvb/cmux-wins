import React from "react";
import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import SettingsHost from "./SettingsHost";
import "./styles.css";
import "./workspace-surfaces.css";
import "./workspace-controls.css";
import "./browser-pane.css";
import "./workspace-metadata.css";
import "./command-palette.css";
import "./settings-dialog.css";

ReactDOM.createRoot(document.getElementById("root")!).render(<SettingsHost />);
