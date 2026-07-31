import React from "react";
import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import App from "./App";
import "./styles.css";
import "./workspace-surfaces.css";
import "./workspace-controls.css";
import "./browser-pane.css";
import "./workspace-metadata.css";

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
