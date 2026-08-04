import { createRoot } from "react-dom/client";

import App from "./App";
import "./styles.css";

const host = document.getElementById("root");
if (host === null) throw new Error("index.html is missing #root");

// Intentionally not wrapped in StrictMode: its double-mount would build and
// tear down an AudioContext and restart playback on every hot reload.
createRoot(host).render(<App />);
