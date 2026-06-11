/**
 * Shared types and utilities for the recon pipeline scripts.
 * Extracted so recon-summarize.ts and recon-generate.ts stay consistent
 * without duplicating the core data model or header-tally logic.
 */
export declare const CAPTURES_DIR = "/tmp/recon/graphql";
export declare const REPLAYS_DIR = "/tmp/recon/replays";
export declare const AUX_DIR = "/tmp/recon/aux";
export declare const STEP_FAILURES_DIR = "/tmp/recon/step-failures";
export interface Capture {
    timestamp: string;
    phase: string;
    method: string;
    url: string;
    status: number;
    requestHeaders: Record<string, string>;
    requestPostData: string | null;
    responseHeaders: Record<string, string>;
    responseBody: unknown;
    operationName: string | null;
    query: string | null;
    variables: unknown;
    decodedParams: unknown;
}
export interface ReplayResult {
    sourceCapture: string;
    url: string;
    method: string;
    operationName: string | null;
    requestBody: string | null;
    replayStatus: number | null;
    replayHeaders: Record<string, string>;
    replayBody: unknown;
    success: boolean;
    error: string | null;
}
export interface RateLimitFinding {
    endpoint: string;
    safeRps: number | null;
    triggerStatus: number | null;
    triggerRps: number | null;
    retryAfter: string | null;
    xRateLimitHeaders: Record<string, string>;
}
export declare function readJsonDir<T>(dir: string, exclude?: string[]): T[];
/**
 * Counts how often each response header appears across successful replays.
 * Infrastructure headers that are never load-bearing on the request side are
 * excluded so the caller sees only candidates worth committing as BASE_HEADERS.
 */
export declare function tallyResponseHeaders(replays: ReplayResult[]): Map<string, number>;
