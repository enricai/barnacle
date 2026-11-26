/**
 * Deterministic order-data verification: runs a flow-declared `verifyRequest`
 * against the site's own origin with the browser session's cookies and checks
 * a JSON field. Discriminates only on HTTP status and the parsed field — no
 * model call, never message text.
 */

import { fetch as undiciFetch } from "undici";

import { type FetchImpl } from "@/scraper/raw-fetch";

export interface VerifyRequestSpec {
  urlTemplate: string;
  method: "GET" | "POST";
  jsonPath: string;
  expect: string | number | boolean;
}

export type OrderVerificationResult =
  | { verified: true }
  | {
      verified: false;
      reason: "cross-origin" | "bad-url" | "missing-payload-field" | "network" | "http-status" | "bad-json" | "mismatch";
    };

export interface VerifyOrderOptions {
  /** The site's own origin, e.g. `https://shop.example`. */
  origin: string;
  /** Browser session cookies as a `Cookie` header value. */
  cookieHeader?: string;
  payload: Record<string, unknown>;
  fetchImpl?: FetchImpl;
}

function resolvePath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.split(/\.|\[(\d+)\]/).filter((s) => s !== undefined && s !== "")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export async function verifyOrderData(
  spec: VerifyRequestSpec,
  options: VerifyOrderOptions
): Promise<OrderVerificationResult> {
  const { origin, cookieHeader, payload, fetchImpl = undiciFetch as unknown as FetchImpl } = options;

  let missing = false;
  const filled = spec.urlTemplate.replace(/\$\{([^}]+)\}/g, (_m, key: string) => {
    const v = payload[key.trim()];
    if (v === undefined || v === null) {
      missing = true;
      return "";
    }
    return encodeURIComponent(String(v));
  });
  if (missing) return { verified: false, reason: "missing-payload-field" };

  let url: URL;
  let siteOrigin: string;
  try {
    siteOrigin = new URL(origin).origin;
    url = new URL(filled, siteOrigin);
  } catch {
    return { verified: false, reason: "bad-url" };
  }
  if (url.origin !== siteOrigin) return { verified: false, reason: "cross-origin" };

  const headers: Record<string, string> = { Accept: "application/json" };
  if (cookieHeader) headers.Cookie = cookieHeader;

  let status: number;
  let text: string;
  try {
    const res = await fetchImpl(url.toString(), { method: spec.method, headers, redirect: "manual" });
    status = res.status;
    text = await res.text();
  } catch {
    return { verified: false, reason: "network" };
  }
  if (status < 200 || status > 299) return { verified: false, reason: "http-status" };

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { verified: false, reason: "bad-json" };
  }
  return resolvePath(json, spec.jsonPath) === spec.expect
    ? { verified: true }
    : { verified: false, reason: "mismatch" };
}
