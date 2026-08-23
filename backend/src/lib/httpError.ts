import type { Response } from "express";

export const INTERNAL_ERROR_CODE = "internal_error";
export const INTERNAL_ERROR_MESSAGE =
  "Something went wrong. Please try again.";

export function sendInternalError(
  res: Response,
  error: unknown,
  status = 500,
): Response {
  const requestId =
    typeof res.locals.requestId === "string" ? res.locals.requestId : null;

  console.error("[http/internal-error]", {
    requestId,
    method: res.req?.method,
    path: res.req?.originalUrl,
    error: error,
  });

  return res.status(status).json({
    code: INTERNAL_ERROR_CODE,
    detail: INTERNAL_ERROR_MESSAGE,
    ...(requestId ? { request_id: requestId } : {}),
  });
}
