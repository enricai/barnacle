import { describe, expect, it } from "vitest";
import { parseRobots } from "@/recon/robots";
import { applyRobots } from "./recon-http";

describe("applyRobots", () => {
  it("blocks disallowed paths per origin and keeps others", () => {
    const robots = new Map([["https://a.com", parseRobots("User-agent: *\nDisallow: /order")]]);
    const mk = (url: string) => ({ capture: { url } as never });
    const { allowed, blocked } = applyRobots(
      [mk("https://a.com/order?x=1"), mk("https://a.com/ok"), mk("https://b.com/order")],
      robots
    );
    expect(blocked).toEqual([{ url: "https://a.com/order?x=1", rule: "/order" }]);
    expect(allowed).toHaveLength(2);
  });
});
