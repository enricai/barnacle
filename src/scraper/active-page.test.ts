import { describe, expect, it, type Mock, vi } from "vitest";
import { type FollowablePage, followNewPage } from "@/scraper/active-page";

interface FakePage extends FollowablePage {
  href: string;
}

function makeContext(initial: FakePage[]): {
  context: { pages: () => FakePage[]; setActivePage: Mock<(page: FakePage) => void> };
  open: (p: FakePage) => void;
} {
  const list = [...initial];
  return {
    context: { pages: () => list, setActivePage: vi.fn<(page: FakePage) => void>() },
    open: (p) => {
      list.push(p);
    },
  };
}

describe("followNewPage", () => {
  it("adopts a newly opened page and calls setActivePage", async () => {
    const first: FakePage = { href: "https://example.com/" };
    const second: FakePage = {
      href: "https://example.com/next",
      waitForLoadState: vi.fn(async () => {}),
    };
    const { context, open } = makeContext([first]);
    const before = [...context.pages()];
    open(second);
    const result = await followNewPage(context, first, before);
    expect(result).toBe(second);
    expect(context.setActivePage).toHaveBeenCalledWith(second);
    expect(second.waitForLoadState).toHaveBeenCalled();
  });

  it("returns the same page when no page appeared", async () => {
    const first: FakePage = { href: "https://example.com/" };
    const { context } = makeContext([first]);
    const result = await followNewPage(context, first, [first], 200);
    expect(result).toBe(first);
    expect(context.setActivePage).not.toHaveBeenCalled();
  });

  it("is idempotent across repeated calls", async () => {
    const first: FakePage = { href: "https://example.com/" };
    const second: FakePage = { href: "https://example.com/next" };
    const { context, open } = makeContext([first]);
    const before = [...context.pages()];
    open(second);
    const a = await followNewPage(context, first, before);
    const b = await followNewPage(context, a, context.pages(), 200);
    expect(b).toBe(second);
    expect(context.setActivePage).toHaveBeenCalledTimes(1);
  });

  it("follows a target=_blank anchor page that is already open when polled", async () => {
    const first: FakePage = { href: "https://example.com/" };
    const blank: FakePage = {
      href: "https://example.com/blank",
      waitForLoadState: vi.fn(async () => {}),
    };
    const { context, open } = makeContext([first]);
    const before = [...context.pages()];
    open(blank);
    expect(await followNewPage(context, first, before)).toBe(blank);
    expect(context.setActivePage).toHaveBeenCalledWith(blank);
  });

  it("follows a window.open page that appears after a delay, preferring the newest", async () => {
    const first: FakePage = { href: "https://example.com/" };
    const popup: FakePage = { href: "https://example.com/popup" };
    const newest: FakePage = { href: "https://example.com/popup2" };
    const { context, open } = makeContext([first]);
    const before = [...context.pages()];
    setTimeout(() => {
      open(popup);
      open(newest);
    }, 250);
    expect(await followNewPage(context, first, before)).toBe(newest);
    expect(context.setActivePage).toHaveBeenCalledTimes(1);
  });

  it("closes the stale tab so the context keeps a single driven tab", async () => {
    const first: FakePage = { href: "https://example.com/", close: vi.fn(async () => {}) };
    const second: FakePage = { href: "https://example.com/b" };
    const { context, open } = makeContext([first]);
    const before = [...context.pages()];
    open(second);
    expect(await followNewPage(context, first, before)).toBe(second);
    expect(first.close).toHaveBeenCalledTimes(1);
  });

  it("adopts the page even when the stale tab cannot be closed or the context lacks setActivePage", async () => {
    const first: FakePage = {
      href: "https://example.com/",
      close: vi.fn(async () => {
        throw new Error("already closed");
      }),
    };
    const second: FakePage = { href: "https://example.com/b" };
    const list = [first, second];
    expect(await followNewPage({ pages: () => list }, first, [first])).toBe(second);
  });

  it("waits for a new tab to leave about:blank before adopting it", async () => {
    const first: FakePage = { href: "https://example.com/" };
    let reads = 0;
    const popup: FakePage = {
      href: "",
      url: () => {
        reads += 1;
        return reads < 3 ? "about:blank" : "https://example.com/popup";
      },
    };
    const { context, open } = makeContext([first]);
    const before = [...context.pages()];
    open(popup);
    expect(await followNewPage(context, first, before)).toBe(popup);
    expect(reads).toBeGreaterThanOrEqual(3);
  });
});
