import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProblemError, problemResponse, type ProblemCode } from "./errors.js";

// A lookup table, not logic — one loop over the table is enough, no need for
// a dedicated it() per code.
const TABLE: Array<{ code: ProblemCode; status: number; title: string }> = [
  { code: "bad_request", status: 400, title: "Bad Request" },
  { code: "unauthorized", status: 401, title: "Unauthorized" },
  { code: "forbidden", status: 403, title: "Forbidden" },
  { code: "not_found", status: 404, title: "Not Found" },
  { code: "conflict", status: 409, title: "Conflict" },
  { code: "gone", status: 410, title: "Gone" },
  { code: "payload_too_large", status: 413, title: "Payload Too Large" },
  { code: "unsupported_media_type", status: 415, title: "Unsupported Media Type" },
  { code: "validation_error", status: 422, title: "Unprocessable Entity" },
  { code: "rate_limited", status: 429, title: "Too Many Requests" },
  { code: "internal_error", status: 500, title: "Internal Server Error" },
];

function makeFakeReply() {
  const calls: { code?: number; type?: string; body?: Record<string, unknown> } = {};
  const reply = {
    code(n: number) { calls.code = n; return reply; },
    type(t: string) { calls.type = t; return reply; },
    send(b: Record<string, unknown>) { calls.body = b; return reply; },
    request: { url: "/test/path" },
  };
  return { reply, calls };
}

describe("errors.ts — ProblemCode status/title lookup table", () => {
  it("ProblemError carries the correct HTTP status for every code", () => {
    for (const { code, status } of TABLE) {
      assert.equal(new ProblemError(code, "detail").status, status, `status mismatch for "${code}"`);
    }
  });

  it("problemResponse writes the correct status, title, and RFC 9457 body shape for every code", () => {
    for (const { code, status, title } of TABLE) {
      const { reply, calls } = makeFakeReply();
      problemResponse(reply as never, code, `${code} detail`);
      assert.equal(calls.code, status, `status mismatch for "${code}"`);
      assert.equal(calls.type, "application/problem+json");
      assert.equal(calls.body?.title, title, `title mismatch for "${code}"`);
      assert.equal(calls.body?.status, status);
      assert.equal(calls.body?.detail, `${code} detail`);
      assert.equal(calls.body?.instance, "/test/path");
      assert.ok(String(calls.body?.type).endsWith(`/errors/${code}`));
    }
  });
});
