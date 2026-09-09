import { describe, expect, it } from "vitest";
import { resolveSessionProxy } from "@/scraper/session-proxy";

describe("resolveSessionProxy", () => {
  it("returns undefined when host is unset", () => {
    expect(
      resolveSessionProxy({
        host: undefined,
        port: 8080,
        protocol: "http",
        username: undefined,
        password: undefined,
      })
    ).toBeUndefined();
  });

  it("builds a tuple when host and port are set", () => {
    expect(
      resolveSessionProxy({
        host: "proxy.example.com",
        port: 1080,
        protocol: "socks5",
        username: "user",
        password: "pass",
      })
    ).toEqual({
      protocol: "socks5",
      host: "proxy.example.com",
      port: 1080,
      username: "user",
      password: "pass",
    });
  });

  it("defaults protocol to http when not socks5", () => {
    expect(
      resolveSessionProxy({
        host: "proxy.example.com",
        port: 8080,
        protocol: "",
        username: undefined,
        password: undefined,
      })
    ).toEqual({
      protocol: "http",
      host: "proxy.example.com",
      port: 8080,
      username: undefined,
      password: undefined,
    });
  });
});
