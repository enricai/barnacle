import { defineRouting } from "next-intl/routing";

/**
 * Supported locales for the application.
 * Uses ISO 639-1 language codes (e.g., "en", "es", "fr").
 * Add new locales here to enable additional languages.
 */
export const locales = ["en"] as const;

/**
 * Type representing a valid locale.
 * Use this for type-safe locale handling throughout the app.
 */
export type Locale = (typeof locales)[number];

/**
 * Default locale for the application.
 * Used when no locale is specified or detected.
 */
export const defaultLocale: Locale = "en";

/**
 * Routing configuration for next-intl internationalization.
 *
 * Features:
 * - Locale prefix in URLs (e.g., /en/about)
 * - Default locale handling
 * - Type-safe locale validation
 *
 * @see https://next-intl.dev/docs/routing
 */
export const routing = defineRouting({
  locales,
  defaultLocale,
  localePrefix: "always",
});
