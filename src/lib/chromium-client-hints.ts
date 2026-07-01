/**
 * Builds the Chromium client-hint header quartet from explicit inputs.
 * Single source of truth for the four-header idiom so plugins never
 * hand-roll User-Agent / sec-ch-ua / sec-ch-ua-mobile / sec-ch-ua-platform.
 */
export function chromiumClientHints(opts: {
  userAgent: string;
  secChUa: string;
  platform: string;
}): Record<string, string> {
  return {
    "User-Agent": opts.userAgent,
    "sec-ch-ua": opts.secChUa,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": `"${opts.platform}"`,
  };
}
