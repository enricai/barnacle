import type { Page } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import {
  capturesAfterIndex,
  extractGaEventEvidence,
  extractSubmitFailureEvidence,
  windowHasAdvanceTransition,
  windowHasTransitionBody,
  wireSignalCapture,
} from "@/scraper/flow-runner";
import {
  defaultCapturesDir,
  listCaptureFiles,
  readCaptureFile,
  recordRuntimeCapture,
  withRuntimeCaptureStore,
} from "@/scraper/runtime-capture-store";

const ORIGIN = "https://app.example.com";
const PATTERN = "ExampleTransition";

/**
 * Fake CDP session: records the handlers `wireSignalCapture` registers so the
 * test can fire Network events through the real capture path with no browser.
 */
function fakeCapturePage(): {
  page: Page;
  emit: (event: string, params: unknown) => void | Promise<void>;
} {
  const handlers = new Map<string, (params: unknown) => void | Promise<void>>();
  const session = {
    on: (event: string, handler: (params: unknown) => void | Promise<void>) => {
      handlers.set(event, handler);
    },
    off: () => {},
  };
  const page = {
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: vi.fn().mockResolvedValue({ body: "{}", base64Encoded: false }),
  } as unknown as Page;
  return { page, emit: (event, params) => handlers.get(event)?.(params) };
}

function wireRuntime(): {
  emitRequest: (opts: {
    method: string;
    url: string;
    postData?: string;
    status?: number;
    body?: string;
  }) => Promise<void>;
  teardown: () => void;
} {
  const { page, emit } = fakeCapturePage();
  const sendCDP = page.sendCDP as unknown as ReturnType<typeof vi.fn>;
  const teardown = wireSignalCapture(page, {
    counter: { n: 0 },
    signalCounter: { n: 0 },
    recentCaptures: [],
    recentCaptureMeta: [],
    getCurrentPhase: () => "flow",
    getCurrentPageOrigin: () => ORIGIN,
    onCapture: (capture, filename) => recordRuntimeCapture(filename, capture),
  });
  let n = 0;
  const emitRequest = async (opts: {
    method: string;
    url: string;
    postData?: string;
    status?: number;
    body?: string;
  }): Promise<void> => {
    const requestId = `req-${n++}`;
    sendCDP.mockResolvedValue({ body: opts.body ?? "{}", base64Encoded: false });
    emit("Network.requestWillBeSent", {
      requestId,
      request: { url: opts.url, method: opts.method, headers: {}, postData: opts.postData },
    });
    emit("Network.responseReceived", {
      requestId,
      response: { status: opts.status ?? 200, headers: {} },
    });
    await emit("Network.loadingFinished", { requestId });
  };
  return { emitRequest, teardown };
}

const graphqlBody = (type: string): string =>
  JSON.stringify({
    operationName: PATTERN,
    query: `mutation ${PATTERN}($input: Input) { run(input: $input) }`,
    variables: { input: { type } },
  });

describe("flow-runner window detectors over runtime captures (no disk)", () => {
  it("uses the in-memory store marker as the default captures dir inside a scope", async () => {
    await withRuntimeCaptureStore(async () => {
      expect(defaultCapturesDir().startsWith("memory:")).toBe(true);
    });
  });

  it("detects a next transition and ignores back through the default source", async () => {
    await withRuntimeCaptureStore(async () => {
      const { emitRequest, teardown } = wireRuntime();
      await emitRequest({
        method: "POST",
        url: `${ORIGIN}/api/graphql`,
        postData: graphqlBody("back"),
      });
      expect(
        windowHasAdvanceTransition({ preIdx: -1, advanceTransitionBodyPattern: PATTERN })
      ).toBe(false);
      expect(windowHasTransitionBody({ preIdx: -1, advanceTransitionBodyPattern: PATTERN })).toBe(
        true
      );
      const preIdx = capturesAfterIndex(-1, defaultCapturesDir()).length - 1;
      await emitRequest({
        method: "POST",
        url: `${ORIGIN}/api/graphql`,
        postData: graphqlBody("next"),
      });
      teardown();
      expect(windowHasAdvanceTransition({ preIdx, advanceTransitionBodyPattern: PATTERN })).toBe(
        true
      );
      expect(windowHasAdvanceTransition({ preIdx: 1, advanceTransitionBodyPattern: PATTERN })).toBe(
        false
      );
      expect(
        windowHasTransitionBody({ preIdx, advanceTransitionBodyPattern: "NoSuchOperation" })
      ).toBe(false);
    });
  });

  it("surfaces a 4xx submit failure in any-4xx mode with the default dir", async () => {
    await withRuntimeCaptureStore(async () => {
      const { emitRequest, teardown } = wireRuntime();
      await emitRequest({
        method: "POST",
        url: `${ORIGIN}/api/submit`,
        postData: JSON.stringify({ a: 1 }),
        status: 422,
        body: JSON.stringify({ errors: [{ field: "email", message: "is invalid" }] }),
      });
      teardown();
      const files = listCaptureFiles(defaultCapturesDir());
      const evidence = extractSubmitFailureEvidence(files, [], undefined, "any-4xx");
      expect(evidence).toContain("422");
      expect(evidence).toContain("is invalid");
    });
  });

  it("surfaces GA collect events from runtime captures", async () => {
    await withRuntimeCaptureStore(async () => {
      const { emitRequest, teardown } = wireRuntime();
      await emitRequest({
        method: "POST",
        url: "https://www.google-analytics.com/g/collect?en=view_secondPage&dl=https%3A%2F%2Fapp.example.com%2Fstep2&epn.errors=0",
      });
      teardown();
      const evidence = extractGaEventEvidence(listCaptureFiles(defaultCapturesDir()));
      expect(evidence).toContain("view_secondPage");
      expect(evidence).toContain("errors=0");
    });
  });

  it("stores a GET with a body but nulls its responseBody", async () => {
    await withRuntimeCaptureStore(async () => {
      const { emitRequest, teardown } = wireRuntime();
      await emitRequest({
        method: "GET",
        url: `${ORIGIN}/api/graphql`,
        postData: graphqlBody("next"),
        body: JSON.stringify({ secret: "payload" }),
      });
      teardown();
      const dir = defaultCapturesDir();
      const [file] = listCaptureFiles(dir);
      expect(file).toBeDefined();
      expect(readCaptureFile(dir, file as string)?.responseBody).toBeNull();
    });
  });

  it("isolates concurrent scopes from each other", async () => {
    const first = withRuntimeCaptureStore(async () => {
      const { emitRequest, teardown } = wireRuntime();
      await emitRequest({
        method: "POST",
        url: `${ORIGIN}/api/graphql`,
        postData: graphqlBody("next"),
      });
      await new Promise((r) => setTimeout(r, 10));
      teardown();
      return windowHasAdvanceTransition({ preIdx: -1, advanceTransitionBodyPattern: PATTERN });
    });
    const second = withRuntimeCaptureStore(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return {
        advance: windowHasAdvanceTransition({ preIdx: -1, advanceTransitionBodyPattern: PATTERN }),
        files: listCaptureFiles(defaultCapturesDir()),
      };
    });
    expect(await first).toBe(true);
    expect(await second).toEqual({ advance: false, files: [] });
  });
});
