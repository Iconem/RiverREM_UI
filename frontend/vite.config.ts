import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  // host:true / --host exposes the dev server on the LAN (for sharing across machines)
  server: { port: 5173, host: true },
});
