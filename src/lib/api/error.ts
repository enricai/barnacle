/**
 * API error codes and error handling utilities.
 * Provides consistent error handling across all API routes.
 */

import type { Logger } from "@/types/logging";

/**
 * Standardized error codes for API responses.
 * Use these codes to categorize errors for client handling.
 */
export const ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  BOT_BLOCKED: "BOT_BLOCKED",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  BAD_REQUEST: "BAD_REQUEST",
  CONFLICT: "CONFLICT",
  UNPROCESSABLE_ENTITY: "UNPROCESSABLE_ENTITY",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * Structured API error response format.
 */
export interface ApiErrorResponse {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

/**
 * Custom API error class for consistent error handling.
 */
export class ApiError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode: number,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }

  /**
   * Converts the error to a JSON response format.
   */
  toJson(): ApiErrorResponse {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details && { details: this.details }),
      },
    };
  }
}

/**
 * Safely extracts an error message from an unknown error.
 *
 * @param error - The error to extract a message from
 * @returns The error message string
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "An unknown error occurred";
}

/**
 * Checks if an error is a JSON parse error.
 *
 * @param error - The error to check
 * @returns True if the error is a JSON parse error
 */
export function isJsonParseError(error: unknown): boolean {
  if (error instanceof SyntaxError) {
    return error.message.includes("JSON");
  }
  return false;
}

/**
 * Checks if an error is an ApiError.
 *
 * @param error - The error to check
 * @returns True if the error is an ApiError
 */
export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/**
 * Context for error handling, typically request information.
 */
export interface ErrorContext {
  path?: string;
  method?: string;
  requestId?: string;
  [key: string]: unknown;
}

/**
 * Handles API errors consistently, logging and returning appropriate responses.
 *
 * @param error - The error that occurred
 * @param logger - Logger instance for error logging
 * @param context - Optional context information
 * @returns Response object with appropriate status and body
 */
export function handleApiError(error: unknown, logger: Logger, context?: ErrorContext): Response {
  const contextStr = context ? ` (${JSON.stringify(context)})` : "";

  if (isApiError(error)) {
    logger.warn(`api error: ${error.code} - ${error.message}${contextStr}`);
    return Response.json(error.toJson(), { status: error.statusCode });
  }

  if (isJsonParseError(error)) {
    logger.warn(`json parse error: ${getErrorMessage(error)}${contextStr}`);
    return Response.json(
      {
        error: {
          code: ERROR_CODES.BAD_REQUEST,
          message: "Invalid JSON in request body",
        },
      },
      { status: 400 }
    );
  }

  logger.errorWithStack(error, `unhandled api error${contextStr}`);
  return Response.json(
    {
      error: {
        code: ERROR_CODES.INTERNAL_ERROR,
        message: "An internal error occurred",
      },
    },
    { status: 500 }
  );
}
