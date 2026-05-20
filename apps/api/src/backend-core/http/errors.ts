// RFC 9457 Problem Details helpers.

import type { FastifyReply } from "fastify";
import { env } from "../runtime/env.js";

export type ProblemCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "gone"
  | "payload_too_large"
  | "unsupported_media_type"
  | "validation_error"
  | "rate_limited"
  | "internal_error";

const STATUS: Record<ProblemCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  gone: 410,
  payload_too_large: 413,
  unsupported_media_type: 415,
  validation_error: 422,
  rate_limited: 429,
  internal_error: 500,
};

const TITLES: Record<ProblemCode, string> = {
  bad_request: "Bad Request",
  unauthorized: "Unauthorized",
  forbidden: "Forbidden",
  not_found: "Not Found",
  conflict: "Conflict",
  gone: "Gone",
  payload_too_large: "Payload Too Large",
  unsupported_media_type: "Unsupported Media Type",
  validation_error: "Unprocessable Entity",
  rate_limited: "Too Many Requests",
  internal_error: "Internal Server Error",
};

export class ProblemError extends Error {
  status: number;
  code: ProblemCode;
  detail: string;

  constructor(code: ProblemCode, detail: string) {
    super(detail);
    this.code = code;
    this.status = STATUS[code];
    this.detail = detail;
  }
}

export function problemResponse(
  reply: FastifyReply,
  code: ProblemCode,
  detail: string,
): FastifyReply {
  return reply.code(STATUS[code]).type("application/problem+json").send({
    type: `${env.BASE_URL}/errors/${code}`,
    title: TITLES[code],
    status: STATUS[code],
    detail,
    instance: reply.request.url,
  });
}
