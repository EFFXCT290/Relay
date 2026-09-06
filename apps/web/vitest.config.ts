import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // In CI, replace Vitest's built-in "github-actions" reporter (which
    // auto-enables from GITHUB_ACTIONS and hardcodes emoji in its job
    // summary) with our own plain-text summary, fed by the json reporter's
    // output. Locally, just the default console reporter.
    reporters: process.env.GITHUB_ACTIONS
      ? ["default", "json", ["github-actions", { jobSummary: { enabled: false } }]]
      : ["default"],
    outputFile: process.env.GITHUB_ACTIONS ? { json: "./vitest-results.json" } : undefined,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
