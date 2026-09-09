import type { SessionProxyTuple } from "@/types/session-proxy";

/** Raw session-proxy inputs as parsed from config, kept separate from
 * `SessionProxyTuple` so callers can pass partially-defaulted env values
 * without first constructing the final tuple shape.
 */
export interface SessionProxyFields {
  host: string | undefined;
  port: number;
  protocol: string;
  username: string | undefined;
  password: string | undefined;
}

/** Single source of truth for turning configured session-proxy fields into
 * the concrete tuple used by both session creation and captcha solving, so
 * neither call site has to re-derive "is a proxy configured" on its own.
 */
export function resolveSessionProxy(fields: SessionProxyFields): SessionProxyTuple | undefined {
  if (!fields.host) return undefined;
  return {
    protocol: fields.protocol === "socks5" ? "socks5" : "http",
    host: fields.host,
    port: fields.port,
    username: fields.username,
    password: fields.password,
  };
}
