import type { fetch as undiciFetch } from "undici";

/**
 * Centralises the undici-compatible Response stub so every flow test stops
 * hand-rolling its own makeResponse with an inconsistent method surface.
 */
export function makeMockFetchResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {}
): Awaited<ReturnType<typeof undiciFetch>> {
  return {
    status,
    headers: new Headers(headers),
    text: (): Promise<string> => Promise.resolve(body),
    json: (): Promise<unknown> => Promise.resolve(JSON.parse(body)),
  } as unknown as Awaited<ReturnType<typeof undiciFetch>>;
}
