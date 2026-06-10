import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
// nuqs adapter import path depends on your nuqs version:
//   v2 + react-router v6:  "nuqs/adapters/react-router/v6"
//   plain SPA:             "nuqs/adapters/react"
import { NuqsAdapter } from "nuqs/adapters/react-router/v6";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <NuqsAdapter>
        <App />
      </NuqsAdapter>
    </BrowserRouter>
  </React.StrictMode>
);
