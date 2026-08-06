import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    // Windows CI runners are slow and run the whole suite in parallel;
    // the default 5s per-test budget is too tight for render tests there.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    environment: "node",
  },
});
