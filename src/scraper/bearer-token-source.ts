import type Bottleneck from "bottleneck";
import { LRUCache } from "lru-cache";

import { extractHtmlBearerTokens } from "@/recon/html-state-producers";
import { HttpBotChallengeError, HttpSchemaError, HttpTransportError } from "@/scraper/errors";
import { fetchFollowingRedirectsPreservingMethod } from "@/scraper/redirect-follow";

/** Where a bearer is served and how to tell it from the document's other tokens. */
export interface BearerDocument {
  /** Document URL as recorded. */
  documentUrl: string;
  /** Base URL of the recording; a document on its host follows the runtime tenant. */
  recordedBaseUrl: string;
  /** Claims that name the token's kind; all must match. */
  claims: Record<string, unknown>;
  /** Sorted claim names, used only when `claims` is empty. */
  claimNames: string[];
  bottleneck: Bottleneck;
}

interface MintContext {
  doc: BearerDocument;
  url: string;
}

const EXPIRY_MARGIN_MS = 30_000;
const DEFAULT_TTL_MS = 10 * 60_000;
const MINT_TIMEOUT_MS = 30_000;

const caches = new WeakMap<Bottleneck, LRUCache<string, string, MintContext>>();

function hostOf(url: string): string {
  return new URL(url).host;
}

function tokenUrl(doc: BearerDocument, baseUrl: string): string {
  const recorded = new URL(doc.documentUrl, doc.recordedBaseUrl);
  const origin =
    recorded.host === hostOf(doc.recordedBaseUrl) ? new URL(baseUrl).origin : recorded.origin;
  return `${origin}${recorded.pathname}${recorded.search}`;
}

// lru-cache reads a ttl of 0 as "never expires", so an already expired token gets 1 ms.
function ttlMs(claims: Record<string, unknown>): number {
  if (typeof claims.exp !== "number") return DEFAULT_TTL_MS;
  return Math.max(1, Math.min(DEFAULT_TTL_MS, claims.exp * 1000 - Date.now() - EXPIRY_MARGIN_MS));
}

async function fetchDocument(url: string): Promise<string> {
  try {
    const res = await fetchFollowingRedirectsPreservingMethod(url, {
      method: "GET",
      headers: { accept: "text/html" },
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    return await res.text();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new HttpTransportError(`bearer document ${url} could not be fetched: ${detail}`);
  }
}

async function mint({ doc, url }: MintContext): Promise<{ token: string; ttl: number }> {
  const html = await doc.bottleneck.schedule(() => fetchDocument(url));
  const wanted = Object.entries(doc.claims);
  const found = extractHtmlBearerTokens(html).find((t) =>
    wanted.length > 0
      ? wanted.every(([k, v]) => t.claims[k] === v)
      : Object.keys(t.claims).sort().join() === doc.claimNames.join()
  );
  if (!found) throw new HttpSchemaError(`no bearer token with the expected claims in ${url}`);
  return { token: found.token, ttl: ttlMs(found.claims) };
}

function cacheFor(bottleneck: Bottleneck): LRUCache<string, string, MintContext> {
  const existing = caches.get(bottleneck);
  if (existing) return existing;
  const created = new LRUCache<string, string, MintContext>({
    max: 64,
    ttl: DEFAULT_TTL_MS,
    fetchMethod: async (_key, _stale, { options, context }) => {
      const { token, ttl } = await mint(context);
      options.ttl = ttl;
      return token;
    },
  });
  caches.set(bottleneck, created);
  return created;
}

/**
 * Mints the bearer a site serves inside one of its pages, so a generated plugin
 * never carries a recorded credential. The fetch runs through the plugin's own
 * limiter; callers must not already hold one of that limiter's slots.
 */
export async function mintBearerFromDocument(
  doc: BearerDocument,
  baseUrl: string
): Promise<string> {
  const url = tokenUrl(doc, baseUrl);
  const key = JSON.stringify([url, doc.claims, doc.claimNames]);
  return cacheFor(doc.bottleneck).forceFetch(key, { context: { doc, url } });
}

/**
 * Per-request `Authorization` for `createHttpClient`'s `resolveHeaders`. A
 * bearer goes only to the hosts recorded with it, or to a host that serves the
 * token itself (a runtime tenant), never to a third party.
 */
export function createBearerHeaderResolver(
  doc: Omit<BearerDocument, "documentUrl"> & {
    /** Null when no captured page served the bearer. */
    documentUrl: string | null;
    headerName: string;
    prefix: string;
    /** Recorded hosts that carried the bearer. */
    bearerHosts: string[];
    /** Recorded hosts that did not. */
    otherHosts: string[];
  }
): (requestUrl: string) => Promise<Record<string, string>> {
  const { documentUrl } = doc;
  return async (requestUrl) => {
    const host = hostOf(requestUrl);
    if (doc.otherHosts.includes(host)) return {};
    if (documentUrl === null) {
      throw new HttpBotChallengeError(
        `${doc.headerName} requires a runtime credential; none is wired (captured value intentionally not emitted)`
      );
    }
    const recordedHost = doc.bearerHosts.includes(host);
    const followsTenant =
      hostOf(new URL(documentUrl, doc.recordedBaseUrl).href) === hostOf(doc.recordedBaseUrl);
    if (!recordedHost && !followsTenant) return {};
    const baseUrl = recordedHost ? doc.recordedBaseUrl : requestUrl;
    const token = await mintBearerFromDocument({ ...doc, documentUrl }, baseUrl);
    return { [doc.headerName]: `${doc.prefix}${token}` };
  };
}
