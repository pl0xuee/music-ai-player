import { createRoot } from "react-dom/client";

import App from "./App";
import "./styles.css";
// Last import wins the cascade: the metal theme overrides styles.css and the
// component stylesheets it pulls in.
import "./theme-metal.css";

const host = document.getElementById("root");
if (host === null) throw new Error("index.html is missing #root");

// Intentionally not wrapped in StrictMode: its double-mount would build and
// tear down an AudioContext and restart playback on every hot reload.
createRoot(host).render(<App />);
