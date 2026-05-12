/**
 * Security headers and Content Security Policy (CSP) utilities.
 * Provides production-ready security header configurations.
 */

/**
 * CSP directive values for different environments.
 */
interface CspDirectives {
  defaultSrc: string[];
  scriptSrc: string[];
  styleSrc: string[];
  imgSrc: string[];
  fontSrc: string[];
  connectSrc: string[];
  frameSrc: string[];
  objectSrc: string[];
  baseUri: string[];
  formAction: string[];
  frameAncestors: string[];
  upgradeInsecureRequests?: boolean;
}

/**
 * Default CSP directives for a secure Next.js application.
 * Allows inline styles for Next.js compatibility.
 */
const DEFAULT_CSP_DIRECTIVES: CspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", "'unsafe-eval'", "'unsafe-inline'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", "data:", "blob:"],
  fontSrc: ["'self'", "data:"],
  connectSrc: ["'self'"],
  frameSrc: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'self'"],
  upgradeInsecureRequests: true,
};

/**
 * Generates a Content Security Policy header value from directives.
 *
 * @param directives - CSP directives configuration
 * @returns CSP header value string
 */
export function generateCsp(directives: Partial<CspDirectives> = {}): string {
  const merged = { ...DEFAULT_CSP_DIRECTIVES, ...directives };

  const parts: string[] = [
    `default-src ${merged.defaultSrc.join(" ")}`,
    `script-src ${merged.scriptSrc.join(" ")}`,
    `style-src ${merged.styleSrc.join(" ")}`,
    `img-src ${merged.imgSrc.join(" ")}`,
    `font-src ${merged.fontSrc.join(" ")}`,
    `connect-src ${merged.connectSrc.join(" ")}`,
    `frame-src ${merged.frameSrc.join(" ")}`,
    `object-src ${merged.objectSrc.join(" ")}`,
    `base-uri ${merged.baseUri.join(" ")}`,
    `form-action ${merged.formAction.join(" ")}`,
    `frame-ancestors ${merged.frameAncestors.join(" ")}`,
  ];

  if (merged.upgradeInsecureRequests) {
    parts.push("upgrade-insecure-requests");
  }

  return parts.join("; ");
}

/**
 * Security header configuration for Next.js.
 * Returns headers array suitable for next.config.mjs.
 */
export interface SecurityHeader {
  key: string;
  value: string;
}

/**
 * Gets all recommended security headers for production.
 *
 * @param cspDirectives - Optional custom CSP directives
 * @returns Array of security headers
 */
export function getSecurityHeaders(cspDirectives?: Partial<CspDirectives>): SecurityHeader[] {
  return [
    {
      key: "X-Content-Type-Options",
      value: "nosniff",
    },
    {
      key: "X-Frame-Options",
      value: "DENY",
    },
    {
      key: "X-XSS-Protection",
      value: "1; mode=block",
    },
    {
      key: "Referrer-Policy",
      value: "strict-origin-when-cross-origin",
    },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=()",
    },
    {
      key: "Strict-Transport-Security",
      value: "max-age=31536000; includeSubDomains",
    },
    {
      key: "Content-Security-Policy",
      value: generateCsp(cspDirectives),
    },
  ];
}

/**
 * Gets security headers optimized for development.
 * Less restrictive CSP to allow hot reloading and dev tools.
 *
 * @returns Array of security headers for development
 */
export function getDevSecurityHeaders(): SecurityHeader[] {
  return getSecurityHeaders({
    scriptSrc: ["'self'", "'unsafe-eval'", "'unsafe-inline'"],
    connectSrc: ["'self'", "ws:", "wss:"],
  });
}
