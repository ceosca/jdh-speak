import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default defineConfig(
  globalIgnores([
    "client/dist/",
    // Stale tsc output — the server runs TS directly via tsx.
    "server/dist/",
    // Generated Paraglide output — regenerated on every dev/build.
    "client/src/paraglide/",
    "node_modules/",
  ]),

  js.configs.recommended,
  tseslint.configs.recommended,

  // Client: browser code + React hooks rules.
  {
    files: ["client/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: { globals: globals.browser },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The v7 compiler-readiness rules flag patterns this codebase uses
      // deliberately (async fetch-then-setState effects, the mount-time join
      // kick-off, the unread-badge ref). Keep the correctness rules
      // (rules-of-hooks, exhaustive-deps) and skip the stylistic ones.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
      // Mutable property writes on ref-derived DOM elements (currentTime,
      // playbackRate) are deliberate imperatives, not mutations of shared state.
      "react-hooks/immutability": "off",
    },
  },

  // Server: Node code.
  {
    files: ["server/src/**/*.ts"],
    languageOptions: { globals: globals.node },
  },

  {
    rules: {
      // `catch {}` with a comment is an established pattern here (best-effort
      // localStorage/AudioContext calls); don't force a binding.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
);
