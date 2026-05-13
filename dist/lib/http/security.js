"use strict";
/**
 * Security headers and Content Security Policy (CSP) utilities.
 * Provides production-ready security header configurations.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateCsp = generateCsp;
exports.getSecurityHeaders = getSecurityHeaders;
exports.getDevSecurityHeaders = getDevSecurityHeaders;
/**
 * Default CSP directives for a secure Next.js application.
 * Allows inline styles for Next.js compatibility.
 */
const DEFAULT_CSP_DIRECTIVES = {
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
function generateCsp(directives = {}) {
    const merged = { ...DEFAULT_CSP_DIRECTIVES, ...directives };
    const parts = [
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
 * Gets all recommended security headers for production.
 *
 * @param cspDirectives - Optional custom CSP directives
 * @returns Array of security headers
 */
function getSecurityHeaders(cspDirectives) {
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
function getDevSecurityHeaders() {
    return getSecurityHeaders({
        scriptSrc: ["'self'", "'unsafe-eval'", "'unsafe-inline'"],
        connectSrc: ["'self'", "ws:", "wss:"],
    });
}
//# sourceMappingURL=security.js.map