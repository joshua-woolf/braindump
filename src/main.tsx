import React from "react";
import ReactDOM from "react-dom/client";
import { AppearanceProvider } from "@/components/Appearance";
import { Toaster } from "@/components/ui/sonner";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppearanceProvider>
      <App />
      <Toaster richColors closeButton position="bottom-right" />
    </AppearanceProvider>
  </React.StrictMode>,
);
