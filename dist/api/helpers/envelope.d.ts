/**
 * Builds the success envelope — `{ status: { httpStatus: "OK", ... } }`
 * merged with the domain payload. Service methods return the complete
 * envelope-shaped object so route handlers just pass them through.
 */
export declare function successEnvelope<T extends object>(payload: T): {
    status: {
        httpStatus: string;
        dateTime: string;
        details: unknown[];
    };
} & T;
