import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { paraglideVitePlugin } from "@inlang/paraglide-js";

export default defineConfig({
  plugins: [
    paraglideVitePlugin({
      project: "./project.inlang",
      outdir: "./src/paraglide",
      // Locale resolution order (first hit wins): a stored choice from the
      // language picker, then the browser's preferred language, then English.
      // A ?lang= URL override is applied imperatively in src/lib/i18n.ts.
      strategy: ["localStorage", "preferredLanguage", "baseLocale"],
    }),
    react(),
    tailwindcss(),
  ],
  server: {
    port: 5173,
    proxy: {
      "/socket.io": {
        target: "http://localhost:3100",
        ws: true,
      },
      // Recording download endpoint lives on the backend.
      "/api": {
        target: "http://localhost:3100",
      },
    },
  },
});
