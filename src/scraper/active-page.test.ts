import { describe, expect, it, type Mock, vi } from "vitest";
import { type FollowablePage, followNewPage } from "@/scraper/active-page";

interface FakePage extends FollowablePage {
  url: string;
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
    const first: FakePage = { url: "https://example.com/" };
    const second: FakePage = {
      url: "https://example.com/next",
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
    const first: FakePage = { url: "https://example.com/" };
    const { context } = makeContext([first]);
    const result = await followNewPage(context, first, [first], 200);
    expect(result).toBe(first);
    expect(context.setActivePage).not.toHaveBeenCalled();
  });

  it("is idempotent across repeated calls", async () => {
    const first: FakePage = { url: "https://example.com/" };
    const second: FakePage = { url: "https://example.com/next" };
    const { context, open } = makeContext([first]);
    const before = [...context.pages()];
    open(second);
    const a = await followNewPage(context, first, before);
    const b = await followNewPage(context, a, context.pages(), 200);
    expect(b).toBe(second);
    expect(context.setActivePage).toHaveBeenCalledTimes(1);
  });

  it("follows a target=_blank anchor page that is already open when polled", async () => {
    const first: FakePage = { url: "https://example.com/" };
    const blank: FakePage = {
      url: "https://example.com/blank",
      waitForLoadState: vi.fn(async () => {}),
    };
    const { context, open } = makeContext([first]);
    const before = [...context.pages()];
    open(blank);
    expect(await followNewPage(context, first, before)).toBe(blank);
    expect(context.setActivePage).toHaveBeenCalledWith(blank);
  });

  it("follows a window.open page that appears after a delay, preferring the newest", async () => {
    const first: FakePage = { url: "https://example.com/" };
    const popup: FakePage = { url: "https://example.com/popup" };
    const newest: FakePage = { url: "https://example.com/popup2" };
    const { context, open } = makeContext([first]);
    const before = [...context.pages()];
    setTimeout(() => {
      open(popup);
      open(newest);
    }, 250);
    expect(await followNewPage(context, first, before)).toBe(newest);
    expect(context.setActivePage).toHaveBeenCalledTimes(1);
  });
});
