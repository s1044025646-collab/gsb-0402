export type ErrorCode =
  | "INVALID_INPUT"
  | "NON_FINITE"
  | "VALUE_OUT_OF_RANGE"
  | "BATCH_TOO_LARGE"
  | "COUNT_OUT_OF_RANGE"
  | "NOT_FOUND"
  | "ILLEGAL_STATE"
  | "VERSION_MISMATCH"
  | "CONFLICT";

export class ApiError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly httpStatus: number = 400
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const err = {
  invalidInput: (msg: string) => new ApiError("INVALID_INPUT", msg, 400),
  nonFinite: (msg: string) => new ApiError("NON_FINITE", msg, 400),
  valueOutOfRange: (msg: string) => new ApiError("VALUE_OUT_OF_RANGE", msg, 400),
  batchTooLarge: (msg: string) => new ApiError("BATCH_TOO_LARGE", msg, 400),
  countOutOfRange: (msg: string) => new ApiError("COUNT_OUT_OF_RANGE", msg, 400),
  notFound: (msg: string) => new ApiError("NOT_FOUND", msg, 404),
  illegalState: (msg: string) => new ApiError("ILLEGAL_STATE", msg, 500),
  versionMismatch: (msg: string) => new ApiError("VERSION_MISMATCH", msg, 409),
  conflict: (msg: string) => new ApiError("CONFLICT", msg, 409),
};
