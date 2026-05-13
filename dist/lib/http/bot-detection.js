"use strict";
/**
 * Bot detection utilities for protecting API routes and pages.
 * Identifies malicious bots while allowing legitimate crawlers.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectBot = detectBot;
exports.shouldBlockRequest = shouldBlockRequest;
exports.getBlockReason = getBlockReason;
/**
 * Known legitimate bot patterns (search engines, social media, monitoring).
 * These bots are allowed through bot detection.
 */
const ALLOWED_BOT_PATTERNS = [
    // Search engines
    /googlebot/i,
    /google-inspectiontool/i,
    /bingbot/i,
    /slurp/i, // Yahoo
    /duckduckbot/i,
    /baiduspider/i,
    /yandexbot/i,
    // Social media
    /facebookexternalhit/i,
    /facebot/i,
    /twitterbot/i,
    /linkedinbot/i,
    /pinterest/i,
    /whatsapp/i,
    /telegrambot/i,
    /discordbot/i,
    /slackbot/i,
    // Monitoring and uptime services
    /uptimerobot/i,
    /pingdom/i,
    /statuscake/i,
    /site24x7/i,
    /newrelic/i,
    /datadog/i,
    // Development tools
    /postman/i,
    /insomnia/i,
    // Preview generators
    /embedly/i,
    /outbrain/i,
    /quora link preview/i,
];
/**
 * Known malicious bot patterns.
 * Requests matching these patterns are blocked.
 */
const BLOCKED_BOT_PATTERNS = [
    // Common scraping tools
    /scrapy/i,
    /mechanize/i,
    /wget/i,
    /curl/i,
    /python-requests/i,
    /go-http-client/i,
    /java\//i,
    /libwww-perl/i,
    // Known bad bots
    /ahrefsbot/i,
    /semrushbot/i,
    /mj12bot/i,
    /dotbot/i,
    /blexbot/i,
    /sogou/i,
    // Empty or suspicious user agents
    /^$/,
    /^\s*$/,
];
/**
 * Detects if a request is from a bot based on the User-Agent header.
 *
 * @param userAgent - The User-Agent header value
 * @returns Bot detection result
 * @example
 * ```typescript
 * const result = detectBot(request.headers.get("user-agent"));
 * if (result.isBlockedBot) {
 *   return new Response("Forbidden", { status: 403 });
 * }
 * ```
 */
function detectBot(userAgent) {
    if (!userAgent || userAgent.trim().length === 0) {
        return {
            isBot: true,
            isAllowedBot: false,
            isBlockedBot: true,
            blockReason: "missing user agent",
        };
    }
    const normalizedUa = userAgent.toLowerCase();
    for (const pattern of ALLOWED_BOT_PATTERNS) {
        if (pattern.test(normalizedUa)) {
            const match = normalizedUa.match(pattern);
            return {
                isBot: true,
                isAllowedBot: true,
                isBlockedBot: false,
                botName: match ? match[0] : undefined,
            };
        }
    }
    for (const pattern of BLOCKED_BOT_PATTERNS) {
        if (pattern.test(normalizedUa)) {
            const match = normalizedUa.match(pattern);
            return {
                isBot: true,
                isAllowedBot: false,
                isBlockedBot: true,
                botName: match ? match[0] : undefined,
                blockReason: "blocked bot pattern",
            };
        }
    }
    const genericBotIndicators = [/bot/i, /crawler/i, /spider/i, /scraper/i, /fetch/i];
    for (const pattern of genericBotIndicators) {
        if (pattern.test(normalizedUa)) {
            return {
                isBot: true,
                isAllowedBot: false,
                isBlockedBot: false,
            };
        }
    }
    return {
        isBot: false,
        isAllowedBot: false,
        isBlockedBot: false,
    };
}
/**
 * Checks if a request should be blocked based on bot detection.
 * Returns true if the request should be blocked.
 *
 * @param userAgent - The User-Agent header value
 * @returns Whether to block the request
 */
function shouldBlockRequest(userAgent) {
    const result = detectBot(userAgent);
    return result.isBlockedBot;
}
/**
 * Gets a human-readable reason for blocking a request.
 *
 * @param userAgent - The User-Agent header value
 * @returns Block reason or null if not blocked
 */
function getBlockReason(userAgent) {
    const result = detectBot(userAgent);
    if (!result.isBlockedBot) {
        return null;
    }
    return result.blockReason || "suspicious bot activity";
}
//# sourceMappingURL=bot-detection.js.map