import type { Page } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { windowHasAdvanceTransition, wireSignalCapture } from "@/scraper/flow-runner";
import {
  defaultCapturesDir,
  listCaptureFiles,
  type RuntimeCaptureStore,
  readCaptureFile,
  recordRuntimeCapture,
  withRuntimeCaptureStore,
} from "@/scraper/runtime-capture-store";

const ORIGIN = "https://api.example.com";
const PATTERN = "AdvanceStep";

/**
 * Fake CDP session recording the handlers `wireSignalCapture` registers so a
 * test can fire Network events without a real browser.
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
  const emit = (event: string, params: unknown): void | Promise<void> =>
    handlers.get(event)?.(params);
  return { page, emit };
}

async function fireRequest(
  store: RuntimeCaptureStore,
  params: {
    method: string;
    postData?: string;
    requestId: string;
  }
): Promise<void> {
  const { page, emit } = fakeCapturePage();
  const teardown = wireSignalCapture(page, {
    counter: { n: 0 },
    signalCounter: { n: 0 },
    recentCaptures: [],
    recentCaptureMeta: [],
    getCurrentPhase: () => "action",
    getCurrentPageOrigin: () => ORIGIN,
    onCapture: (capture, filename) => recordRuntimeCapture(store, filename, capture),
  });
  emit("Network.requestWillBeSent", {
    requestId: params.requestId,
    request: {
      url: `${ORIGIN}/graphql`,
      method: params.method,
      headers: {},
      postData: params.postData,
    },
  });
  await emit("Network.loadingFinished", { requestId: params.requestId });
  teardown();
}

const mutation = (type: string): string =>
  JSON.stringify({
    operationName: "AdvanceStep",
    query: "mutation AdvanceStep($input: StepInput!) { advanceStep(input: $input) { ok } }",
    variables: { input: { type } },
  });

const advanced = (): boolean =>
  windowHasAdvanceTransition({
    preIdx: -1,
    advanceTransitionBodyPattern: PATTERN,
    capturesDir: defaultCapturesDir(),
  });

describe("flow-runner/runtime capture store — wireSignalCapture feeds window detectors", () => {
  it("counts a POST mutation with input.type 'next' as an advance", async () => {
    const result = await withRuntimeCaptureStore(async (store) => {
      await fireRequest(store, { method: "POST", postData: mutation("next"), requestId: "r1" });
      return advanced();
    });
    expect(result).toBe(true);
  });

  it("does not count a 'back' mutation as an advance", async () => {
    const result = await withRuntimeCaptureStore(async (store) => {
      await fireRequest(store, { method: "POST", postData: mutation("back"), requestId: "r2" });
      return advanced();
    });
    expect(result).toBe(false);
  });

  it("drops GET response bodies", async () => {
    const body = await withRuntimeCaptureStore(async (store) => {
      await fireRequest(store, { method: "GET", requestId: "r3" });
      const [file] = listCaptureFiles(defaultCapturesDir());
      return file ? readCaptureFile(defaultCapturesDir(), file)?.responseBody : undefined;
    });
    expect(body).toBeNull();
  });

  it("isolates concurrent scopes from each other", async () => {
    const [withAdvance, withoutCaptures] = await Promise.all([
      withRuntimeCaptureStore(async (store) => {
        await fireRequest(store, { method: "POST", postData: mutation("next"), requestId: "r4" });
        return advanced();
      }),
      withRuntimeCaptureStore(async () => {
        await Promise.resolve();
        return { advanced: advanced(), files: listCaptureFiles(defaultCapturesDir()) };
      }),
    ]);
    expect(withAdvance).toBe(true);
    expect(withoutCaptures.advanced).toBe(false);
    expect(withoutCaptures.files).toEqual([]);
  });
});
