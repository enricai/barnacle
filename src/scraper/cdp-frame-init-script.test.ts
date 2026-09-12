import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { installInitScriptOnAllFrames } from "@/scraper/cdp-frame-init-script";

interface FakeSession {
  send: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  emit(event: string, params: unknown): void;
}

function createFakeSession(
  sendImpl?: (method: string, params?: object) => Promise<unknown>
): FakeSession {
  const handlers = new Map<string, (params: unknown) => void>();
  return {
    send: vi.fn(sendImpl ?? ((): Promise<unknown> => Promise.resolve(undefined))),
    on: vi.fn((event: string, handler: (params: unknown) => void) => {
      handlers.set(event, handler);
    }),
    emit(event: string, params: unknown): void {
      handlers.get(event)?.(params);
    },
  };
}

function createFakePage(sessionsById: Map<string, FakeSession>, mainFrameId = "main-frame") {
  return {
    getSessionForFrame: vi.fn(() => sessionsById.get("main")),
    getSessionById: vi.fn((id: string) => sessionsById.get(id)),
    mainFrameId: vi.fn(() => mainFrameId),
  };
}

describe("installInitScriptOnAllFrames", () => {
  it("sends addScriptToEvaluateOnNewDocument on the main session before any resume happens", async () => {
    const main = createFakeSession();
    const sessions = new Map([["main", main]]);
    const page = createFakePage(sessions);

    await installInitScriptOnAllFrames(page as never, "window.__x = 1;");

    expect(main.send).toHaveBeenCalledWith("Page.addScriptToEvaluateOnNewDocument", {
      source: "window.__x = 1;",
    });
    expect(main.send).not.toHaveBeenCalledWith("Runtime.runIfWaitingForDebugger");
  });

  it("arms Target.setAutoAttach with autoAttach and waitForDebuggerOnStart on the main session", async () => {
    const main = createFakeSession();
    const sessions = new Map([["main", main]]);
    const page = createFakePage(sessions);

    await installInitScriptOnAllFrames(page as never, "window.__x = 1;");

    expect(main.send).toHaveBeenCalledWith("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
  });

  it("installs into a child session before resuming it, in call order, on attachedToTarget", async () => {
    const callOrder: string[] = [];
    const main = createFakeSession(async (method: string): Promise<unknown> => {
      callOrder.push(`main:${method}`);
      return undefined;
    });
    const child = createFakeSession(async (method: string): Promise<unknown> => {
      callOrder.push(`child:${method}`);
      return undefined;
    });
    const sessions = new Map([
      ["main", main],
      ["child-session", child],
    ]);
    const page = createFakePage(sessions);

    await installInitScriptOnAllFrames(page as never, "window.__x = 1;");
    main.emit("Target.attachedToTarget", { sessionId: "child-session" });
    await vi.waitFor(() => {
      expect(callOrder).toContain("child:Runtime.runIfWaitingForDebugger");
    });

    const installIndex = callOrder.indexOf("child:Page.addScriptToEvaluateOnNewDocument");
    const resumeIndex = callOrder.indexOf("child:Runtime.runIfWaitingForDebugger");
    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(resumeIndex).toBeGreaterThan(installIndex);
  });

  it("arms a grandchild target attached under a child session", async () => {
    const main = createFakeSession();
    const child = createFakeSession();
    const grandchild = createFakeSession();
    const sessions = new Map([
      ["main", main],
      ["child-session", child],
      ["grandchild-session", grandchild],
    ]);
    const page = createFakePage(sessions);

    await installInitScriptOnAllFrames(page as never, "window.__x = 1;");
    main.emit("Target.attachedToTarget", { sessionId: "child-session" });
    await vi.waitFor(() => {
      expect(child.send).toHaveBeenCalledWith("Runtime.runIfWaitingForDebugger");
    });

    expect(child.send).toHaveBeenCalledWith("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });

    child.emit("Target.attachedToTarget", { sessionId: "grandchild-session" });
    await vi.waitFor(() => {
      expect(grandchild.send).toHaveBeenCalledWith("Runtime.runIfWaitingForDebugger");
    });

    expect(grandchild.send).toHaveBeenCalledWith("Page.addScriptToEvaluateOnNewDocument", {
      source: "window.__x = 1;",
    });
    const grandchildInstallIndex = grandchild.send.mock.calls.findIndex(
      ([method]) => method === "Page.addScriptToEvaluateOnNewDocument"
    );
    const grandchildResumeIndex = grandchild.send.mock.calls.findIndex(
      ([method]) => method === "Runtime.runIfWaitingForDebugger"
    );
    expect(grandchildResumeIndex).toBeGreaterThan(grandchildInstallIndex);
  });

  it("never resumes a target without first applying the script, even under rapid-fire concurrent attach events", async () => {
    const callOrder: Array<{ sessionId: string; method: string }> = [];
    const makeChild = (sessionId: string): FakeSession =>
      createFakeSession(async (method: string): Promise<unknown> => {
        callOrder.push({ sessionId, method });
        return undefined;
      });
    const main = createFakeSession();
    const childA = makeChild("child-a");
    const childB = makeChild("child-b");
    const childC = makeChild("child-c");
    const sessions = new Map([
      ["main", main],
      ["child-a", childA],
      ["child-b", childB],
      ["child-c", childC],
    ]);
    const page = createFakePage(sessions);

    await installInitScriptOnAllFrames(page as never, "window.__x = 1;");
    main.emit("Target.attachedToTarget", { sessionId: "child-a" });
    main.emit("Target.attachedToTarget", { sessionId: "child-b" });
    main.emit("Target.attachedToTarget", { sessionId: "child-c" });

    await vi.waitFor(() => {
      expect(callOrder.filter((c) => c.method === "Runtime.runIfWaitingForDebugger")).toHaveLength(
        3
      );
    });

    for (const sessionId of ["child-a", "child-b", "child-c"]) {
      const installIndex = callOrder.findIndex(
        (c) => c.sessionId === sessionId && c.method === "Page.addScriptToEvaluateOnNewDocument"
      );
      const resumeIndex = callOrder.findIndex(
        (c) => c.sessionId === sessionId && c.method === "Runtime.runIfWaitingForDebugger"
      );
      expect(installIndex).toBeGreaterThanOrEqual(0);
      expect(resumeIndex).toBeGreaterThan(installIndex);
    }
  });

  it("surfaces a send() rejection on one target's install without preventing other targets from being installed", async () => {
    const main = createFakeSession();
    const failing = createFakeSession((method: string): Promise<unknown> => {
      if (method === "Page.addScriptToEvaluateOnNewDocument") {
        return Promise.reject(new Error("install failed"));
      }
      return Promise.resolve(undefined);
    });
    const healthy = createFakeSession();
    const sessions = new Map([
      ["main", main],
      ["failing-session", failing],
      ["healthy-session", healthy],
    ]);
    const page = createFakePage(sessions);

    await installInitScriptOnAllFrames(page as never, "window.__x = 1;");
    main.emit("Target.attachedToTarget", { sessionId: "failing-session" });
    main.emit("Target.attachedToTarget", { sessionId: "healthy-session" });

    await vi.waitFor(() => {
      expect(healthy.send).toHaveBeenCalledWith("Runtime.runIfWaitingForDebugger");
    });

    expect(failing.send).toHaveBeenCalledWith("Page.addScriptToEvaluateOnNewDocument", {
      source: "window.__x = 1;",
    });
  });

  it("never branches on siteId/plugin identity — the module is frame-agnostic", () => {
    const source = fs.readFileSync(path.join(__dirname, "cdp-frame-init-script.ts"), "utf8");
    expect(source).not.toMatch(/siteId|pluginName|plugin\.meta/i);
  });
});
