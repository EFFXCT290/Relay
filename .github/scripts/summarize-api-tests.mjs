// Reads the JUnit XML produced by apps/api's `node --test` run
// (--test-reporter=junit) and renders it through the shared markdown
// summary so the api-test job gets a Summary page entry like web-test's.
//
// No XML-parsing dependency is added: Node's own JUnit output has a fixed,
// well-known shape (confirmed by generating it locally), so this walks the
// tags with a small regex-based tokenizer instead, tracking a stack of
// enclosing <testsuite> names to attribute nested describe() blocks and
// failures correctly.

import { readFileSync, appendFileSync } from "node:fs";
import { renderSummary } from "./lib/markdown-summary.mjs";

const xmlPath = process.argv[2] ?? "test-results.xml";
const summaryPath = process.env.GITHUB_STEP_SUMMARY;

function unescapeXml(text) {
  return String(text)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function getAttr(attrs, name) {
  const m = attrs.match(new RegExp(`${name}="([^"]*)"`));
  return m ? unescapeXml(m[1]) : undefined;
}

// Attribute text can legally contain an unescaped literal '>' (XML only
// requires escaping it inside element content, not attribute values) — e.g.
// a test named "m[1] >= 16 && <= 31" produced by this very repo's suite.
// A plain `[^>]*` stops at that inner '>' and desyncs the whole tokenizer,
// so attributes are matched as an alternation of quoted spans (which may
// contain '>') or single unquoted characters.
const ATTRS = `(?:"[^"]*"|[^">])*`;

function parseJUnit(xml) {
  const totals = { suites: 0, tests: 0, passed: 0, failed: 0, skipped: 0, todo: 0, cancelled: 0 };
  for (const m of xml.matchAll(/<!--\s*(\w+)\s+([\d.]+)\s*-->/g)) {
    const [, key, value] = m;
    if (key === "suites") totals.suites = Number(value);
    else if (key === "tests") totals.tests = Number(value);
    else if (key === "pass") totals.passed = Number(value);
    else if (key === "fail") totals.failed = Number(value);
    else if (key === "skipped") totals.skipped = Number(value);
    else if (key === "todo") totals.todo = Number(value);
    else if (key === "cancelled") totals.cancelled = Number(value);
  }
  const durationMsMatch = xml.match(/<!--\s*duration_ms\s+([\d.]+)\s*-->/);
  const durationMs = durationMsMatch ? Number(durationMsMatch[1]) : 0;

  const suites = [];
  const failures = [];
  const stack = [];
  let currentTestcaseName = null;
  // Node's own junit reporter has a confirmed bug (reproduced by generating
  // real output from this repo's Socket.IO-backed suites): a few suites are
  // written as <undefined name="..."> instead of <testsuite ...>, with no
  // tests/failures/time attributes, and are never closed inline — all their
  // </undefined> tags land in a batch at the very end of the file instead of
  // after their own content. Treating that like a normal stack push (as if
  // it behaved like <testsuite>) would keep it "open" for everything parsed
  // afterwards and mis-nest every sibling suite for the rest of the file.
  // Since real output shows these tags are immediately followed by their
  // own direct <testcase> children before the next real <testsuite> sibling
  // starts, they're tracked as a one-shot label instead: it names only
  // those leading testcases, and is cleared the moment a real <testsuite>
  // tag is seen.
  let looseLabel = null;

  const tagRe = new RegExp(
    `<testsuite\\s+(${ATTRS})>` +
      `|<\\/testsuite>` +
      `|<undefined\\s+(${ATTRS})>` +
      `|<\\/undefined>` +
      `|<testcase\\s+(${ATTRS})\\/>` +
      `|<testcase\\s+(${ATTRS})>` +
      `|<\\/testcase>` +
      `|<failure\\s+(${ATTRS})>([\\s\\S]*?)<\\/failure>`,
    "g",
  );

  let m;
  while ((m = tagRe.exec(xml)) !== null) {
    if (m[1] !== undefined) {
      looseLabel = null;
      const attrs = m[1];
      stack.push(getAttr(attrs, "name") ?? "(unnamed)");
      suites.push({
        name: stack.join(" > "),
        tests: Number(getAttr(attrs, "tests") ?? 0),
        failures: Number(getAttr(attrs, "failures") ?? 0),
        skipped: Number(getAttr(attrs, "skipped") ?? 0),
        timeMs: Number(getAttr(attrs, "time") ?? 0) * 1000,
      });
    } else if (m[0] === "</testsuite>") {
      looseLabel = null;
      stack.pop();
    } else if (m[2] !== undefined) {
      looseLabel = getAttr(m[2], "name") ?? "(unnamed)";
    } else if (m[0] === "</undefined>") {
      looseLabel = null;
    } else if (m[3] !== undefined) {
      currentTestcaseName = null;
    } else if (m[4] !== undefined) {
      currentTestcaseName = getAttr(m[4], "name") ?? "(unnamed test)";
    } else if (m[0] === "</testcase>") {
      currentTestcaseName = null;
    } else if (m[5] !== undefined) {
      failures.push({
        suite: looseLabel ?? (stack.length > 0 ? stack.join(" > ") : "(root)"),
        test: currentTestcaseName ?? "(unknown test)",
        message: getAttr(m[5], "message") ?? "",
      });
    }
  }

  return { totals, durationMs, suites, failures };
}

let xml;
try {
  xml = readFileSync(xmlPath, "utf8");
} catch (err) {
  const fallback = renderSummary({
    title: "API Test Report",
    durationMs: 0,
    totals: { suites: 0, tests: 0, passed: 0, failed: 0, skipped: 0, todo: 0 },
    suites: [],
    failures: [{ suite: "summarize-api-tests", test: "reading results file", message: `Could not read ${xmlPath}: ${err.message}` }],
  });
  if (summaryPath) appendFileSync(summaryPath, `\n${fallback}\n`);
  else process.stdout.write(fallback);
  process.exit(0);
}

const { totals, durationMs, suites, failures } = parseJUnit(xml);
const markdown = renderSummary({ title: "API Test Report", durationMs, totals, suites, failures });

if (summaryPath) appendFileSync(summaryPath, `\n${markdown}\n`);
else process.stdout.write(markdown);
