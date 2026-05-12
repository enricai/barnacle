import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

/**
 * Vitest setup file for test environment configuration.
 * Provides browser API mocks and cleanup utilities.
 */

// Automatically cleanup after each test to prevent memory leaks
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
});

// Suppress act warnings in test environment for async operations that can't be wrapped
const originalError = console.error;
console.error = (...args: unknown[]): void => {
  if (
    typeof args[0] === "string" &&
    (args[0].includes(
      "Warning: An update to TestComponent inside a test was not wrapped in act"
    ) ||
      args[0].includes(
        "Warning: The current testing environment is not configured to support act"
      ) ||
      args[0].includes("not wrapped in act(...)"))
  ) {
    return;
  }
  originalError.call(console, ...args);
};

// Mock IntersectionObserver for JSDOM
class MockIntersectionObserver {
  disconnect(): void {}
  observe(): void {}
  unobserve(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}
global.IntersectionObserver =
  MockIntersectionObserver as unknown as typeof IntersectionObserver;

// Mock ResizeObserver
class MockResizeObserver {
  disconnect(): void {}
  observe(): void {}
  unobserve(): void {}
}
global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

// Mock matchMedia only in jsdom environment
if (typeof window !== "undefined") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

// Mock scrollTo only in jsdom environment
if (typeof window !== "undefined") {
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
}

// Mock Next.js navigation functions globally
vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
  usePathname: vi.fn(() => "/"),
  useParams: vi.fn(() => ({})),
  notFound: vi.fn(() => {
    throw new Error("notFound() called");
  }),
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect(${url}) called`);
  }),
}));

// Mock crypto API
Object.defineProperty(global, "crypto", {
  value: {
    getRandomValues: vi.fn().mockImplementation((arr: Uint8Array) => {
      for (let i = 0; i < arr.length; i++) {
        arr[i] = Math.floor(Math.random() * 256);
      }
      return arr;
    }),
    subtle: {
      digest: vi.fn().mockResolvedValue(new ArrayBuffer(32)),
      importKey: vi.fn().mockResolvedValue({}),
      sign: vi.fn().mockResolvedValue(new ArrayBuffer(32)),
      encrypt: vi.fn().mockResolvedValue(new ArrayBuffer(32)),
      decrypt: vi.fn().mockResolvedValue(new ArrayBuffer(32)),
    },
    randomUUID: vi
      .fn()
      .mockReturnValue("mock-uuid-v4-test-" + Math.floor(Math.random() * 1000)),
  },
});
