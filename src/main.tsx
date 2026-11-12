import React from "react";
import { createRoot } from "react-dom/client";
import SessionGate from "./SessionGate";
import "./styles.css";
import "./mstar.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SessionGate />
  </React.StrictMode>,
);
