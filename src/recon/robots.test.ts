import { describe, expect, it } from "vitest";
import { isDisallowed, matchingDisallow, parseRobots } from "./robots";

describe("robots", () => {
  const rules = parseRobots("User-agent: *\nDisallow: /order\n");
  it("blocks prefix paths including query", () => {
    expect(isDisallowed(rules, "/order")).toBe(true);
    expect(isDisallowed(rules, "/order.json?x")).toBe(true);
    expect(matchingDisallow(rules, "/order/1")).toBe("/order");
  });
  it("is plain prefix matching: /orders-info is also blocked, /other is not", () => {
    expect(isDisallowed(rules, "/orders-info")).toBe(true);
    expect(isDisallowed(rules, "/other")).toBe(false);
    expect(isDisallowed(parseRobots("User-agent: *\nDisallow: /order/"), "/orders-info")).toBe(false);
  });
  it("Allow overrides by longest match", () => {
    const r = parseRobots("User-agent: *\nDisallow: /a\nAllow: /a/public");
    expect(isDisallowed(r, "/a/x")).toBe(true);
    expect(isDisallowed(r, "/a/public/x")).toBe(false);
  });
  it("empty Disallow allows all", () => {
    expect(isDisallowed(parseRobots("User-agent: *\nDisallow:"), "/x")).toBe(false);
  });
  it("ignores non-* groups", () => {
    const r = parseRobots("User-agent: Bot\nDisallow: /\n\nUser-agent: *\nDisallow: /p");
    expect(isDisallowed(r, "/q")).toBe(false);
    expect(isDisallowed(r, "/p")).toBe(true);
  });
});
