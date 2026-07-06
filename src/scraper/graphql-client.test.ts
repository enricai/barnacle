import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import {
  HttpBotChallengeError,
  HttpRateLimitError,
  HttpSchemaError,
  HttpServerError,
} from "@/scraper/errors";
import { createGraphqlClient } from "@/scraper/graphql-client";

const passThruLimiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });

const BASE_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  Origin: "https://example.com",
  Referer: "https://example.com/",
  "User-Agent": "TestAgent/1.0",
};

const ENDPOINT = "https://example.com/graphql";

const ResponseSchema = z.object({
  data: z.object({ items: z.array(z.object({ id: z.string() })) }),
});

type Response = z.infer<typeof ResponseSchema>;

function makeClient() {
  return createGraphqlClient<Response>({
    schema: ResponseSchema,
    bottleneck: passThruLimiter,
    baseHeaders: BASE_HEADERS,
    endpoint: ENDPOINT,
  });
}

function mockFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      status,
      ok: status >= 200 && status < 300,
      text: vi.fn().mockResolvedValue(JSON.stringify(body)),
      headers: new Headers(),
    })
  );
}

const VALID_BODY = { data: { items: [{ id: "1" }] } };

describe("scraper/graphql-client createGraphqlClient", () => {
  it("returns parsed data on a 200 with a valid schema", async () => {
    mockFetch(200, VALID_BODY);
    const gql = makeClient();
    const result = await gql("TestOp", "query TestOp { items { id } }", {});
    expect(result).toEqual(VALID_BODY);
  });

  it("sends POST with correct JSON envelope to the configured endpoint", async () => {
    mockFetch(200, VALID_BODY);
    const gql = makeClient();
    await gql("MyOp", "query MyOp($q: String!) { items { id } }", { q: "hello" });

    const call = vi.mocked(fetch).mock.calls[0];
    expect(call?.[0]).toBe(ENDPOINT);
    const init = call?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      operationName: "MyOp",
      query: "query MyOp($q: String!) { items { id } }",
      variables: { q: "hello" },
    });
  });

  it("throws HttpBotChallengeError on 401", async () => {
    mockFetch(401, {});
    const gql = makeClient();
    await expect(gql("Op", "query Op { items { id } }", {})).rejects.toBeInstanceOf(
      HttpBotChallengeError
    );
  });

  it("throws HttpBotChallengeError on 403", async () => {
    mockFetch(403, {});
    const gql = makeClient();
    await expect(gql("Op", "query Op { items { id } }", {})).rejects.toBeInstanceOf(
      HttpBotChallengeError
    );
  });

  it("throws HttpRateLimitError on 429", async () => {
    mockFetch(429, {});
    const gql = makeClient();
    await expect(gql("Op", "query Op { items { id } }", {})).rejects.toBeInstanceOf(
      HttpRateLimitError
    );
  });

  it("throws HttpServerError on 500", async () => {
    mockFetch(500, {});
    const gql = makeClient();
    await expect(gql("Op", "query Op { items { id } }", {})).rejects.toBeInstanceOf(
      HttpServerError
    );
  });

  it("throws HttpSchemaError when response does not match Zod schema", async () => {
    mockFetch(200, { wrong: "shape" });
    const gql = makeClient();
    await expect(gql("Op", "query Op { items { id } }", {})).rejects.toBeInstanceOf(
      HttpSchemaError
    );
  });
});
