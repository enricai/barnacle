import { formatISO } from "date-fns";

/**
 * Builds the VPS success envelope — `{ status: { httpStatus: "OK", ... } }`
 * merged with the domain payload. Service methods return the complete
 * VPS-shaped object so route handlers just pass them through.
 */
export function successEnvelope<T extends object>(
  payload: T
): {
  status: {
    httpStatus: string;
    dateTime: string;
    details: unknown[];
  };
} & T {
  return {
    status: {
      httpStatus: "OK",
      dateTime: formatISO(new Date()),
      details: [],
    },
    ...payload,
  };
}
