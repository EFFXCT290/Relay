// Shared markdown renderer for CI job summaries. Deliberately plain text /
// markdown only — no emoji — used by both the api-test (JUnit XML) and
// web-test (Vitest JSON) summary scripts so the two jobs read consistently
// on the workflow run's Summary page.
//
// Expected `data` shape:
// {
//   title:      string,
//   durationMs: number,
//   totals:     { suites, tests, passed, failed, skipped, todo },
//   suites:     Array<{ name, tests, failures, skipped, timeMs }>,
//   failures:   Array<{ suite, test, message }>,
// }

function fmtSeconds(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

function escapeMd(text) {
  return String(text).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function renderSummary(data) {
  const { title, durationMs, totals, suites, failures } = data;
  const lines = [];

  lines.push(`## ${title}`);
  lines.push("");
  lines.push(totals.failed > 0 ? "**Result: FAILED**" : "**Result: PASSED**");
  lines.push("");

  lines.push("| Metric | Count |");
  lines.push("| --- | --- |");
  lines.push(`| Suites | ${totals.suites} |`);
  lines.push(`| Tests | ${totals.tests} |`);
  lines.push(`| Passed | ${totals.passed} |`);
  lines.push(`| Failed | ${totals.failed} |`);
  if (totals.skipped) lines.push(`| Skipped | ${totals.skipped} |`);
  if (totals.todo) lines.push(`| Todo | ${totals.todo} |`);
  if (totals.cancelled) lines.push(`| Cancelled | ${totals.cancelled} |`);
  lines.push(`| Duration | ${fmtSeconds(durationMs)} |`);
  lines.push("");

  if (failures.length > 0) {
    lines.push("### Failed Tests");
    lines.push("");
    for (const f of failures) {
      lines.push(`- **${escapeMd(f.suite)}** &raquo; ${escapeMd(f.test)}`);
      if (f.message) {
        const firstLine = String(f.message).split("\n")[0];
        lines.push(`  - ${escapeMd(firstLine)}`);
      }
    }
    lines.push("");
  }

  if (suites.length > 0) {
    lines.push("<details>");
    lines.push(`<summary>Per-suite breakdown (${suites.length} suites)</summary>`);
    lines.push("");
    lines.push("| Suite | Tests | Failed | Skipped | Duration |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const s of suites) {
      lines.push(`| ${escapeMd(s.name)} | ${s.tests} | ${s.failures} | ${s.skipped} | ${fmtSeconds(s.timeMs)} |`);
    }
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  return lines.join("\n");
}
