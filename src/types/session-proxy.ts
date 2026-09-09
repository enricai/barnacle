/** Single source-of-truth shape for a concrete outbound proxy, shared by session
 * creation and captcha solving so neither call site reshapes an ad-hoc proxy object.
 */
export interface SessionProxyTuple {
  protocol: "http" | "socks5";
  host: string;
  port: number;
  username?: string;
  password?: string;
}
