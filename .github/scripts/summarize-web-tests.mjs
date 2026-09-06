// Reads the Jest-compatible JSON that Vitest's built-in `json` reporter
// writes and renders it through the shared markdown summary, replacing
// Vitest's own emoji-laden "github-actions" job summary (disabled in
// vitest.config.ts when GITHUB_ACTIONS is set) with one that matches the
// api-test job's format.

import { readFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { renderSummary } from "./lib/markdown-summary.mjs";

const jsonPath = process.argv[2] ?? "vitest-results.json";
const summaryPath = process.env.GITHUB_STEP_SUMMARY;

function suiteName(testResult) {
  return path.relative(process.cwd(), testResult.name);
}

let data;
try {
  data = JSON.parse(readFileSync(jsonPath, "utf8"));
} catch (err) {
  const fallback = renderSummary({
    title: "Web Test Report",
    durationMs: 0,
    totals: { suites: 0, tests: 0, passed: 0, failed: 0, skipped: 0, todo: 0 },
    suites: [],
    failures: [{ suite: "summarize-web-tests", test: "reading results file", message: `Could not read ${jsonPath}: ${err.message}` }],
  });
  if (summaryPath) appendFileSync(summaryPath, `\n${fallback}\n`);
  else process.stdout.write(fallback);
  process.exit(0);
}

const totals = {
  // Not data.numTotalTestSuites: Vitest's JSON reporter counts every
  // describe() block under that key (53 here), not test files, which would
  // read as a suites count wildly out of step with the per-file breakdown
  // table below it. File count matches that table and Vitest's own console
  // reporter ("Test Files N passed").
  suites: (data.testResults ?? []).length,
  tests: data.numTotalTests ?? 0,
  passed: data.numPassedTests ?? 0,
  failed: data.numFailedTests ?? 0,
  skipped: data.numPendingTests ?? 0,
  todo: data.numTodoTests ?? 0,
};

let latestEndTime = data.startTime ?? 0;
const suites = [];
const failures = [];

for (const testResult of data.testResults ?? []) {
  const name = suiteName(testResult);
  const assertions = testResult.assertionResults ?? [];
  const timeMs = (testResult.endTime ?? testResult.startTime ?? 0) - (testResult.startTime ?? 0);
  if (testResult.endTime) latestEndTime = Math.max(latestEndTime, testResult.endTime);

  suites.push({
    name,
    tests: assertions.length,
    failures: assertions.filter((a) => a.status === "failed").length,
    skipped: assertions.filter((a) => a.status === "skipped" || a.status === "todo").length,
    timeMs,
  });

  for (const a of assertions) {
    if (a.status !== "failed") continue;
    failures.push({
      suite: a.ancestorTitles?.length ? a.ancestorTitles.join(" > ") : name,
      test: a.title,
      message: a.failureMessages?.[0] ?? testResult.message ?? "",
    });
  }
}

const durationMs = latestEndTime - (data.startTime ?? latestEndTime);
const markdown = renderSummary({ title: "Web Test Report", durationMs, totals, suites, failures });

if (summaryPath) appendFileSync(summaryPath, `\n${markdown}\n`);
else process.stdout.write(markdown);
