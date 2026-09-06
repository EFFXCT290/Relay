import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// @testing-library/react's own auto-cleanup only self-registers when it finds
// a GLOBAL `afterEach` (true in Jest by default) — vitest.config.ts doesn't
// set test.globals, so without this, every render() from a previous test
// would linger in document.body into the next one.
afterEach(() => {
  cleanup();
});
