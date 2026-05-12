import type { Locale } from "@/i18n/routing";

/**
 * RTL (Right-to-Left) locale codes.
 * These locales require right-to-left text direction.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/HTML/Global_attributes/dir
 */
const RTL_LOCALES = new Set([
  "ar", // Arabic
  "ar-AE", // Arabic (UAE)
  "ar-BH", // Arabic (Bahrain)
  "ar-DZ", // Arabic (Algeria)
  "ar-EG", // Arabic (Egypt)
  "ar-IQ", // Arabic (Iraq)
  "ar-JO", // Arabic (Jordan)
  "ar-KW", // Arabic (Kuwait)
  "ar-LB", // Arabic (Lebanon)
  "ar-LY", // Arabic (Libya)
  "ar-MA", // Arabic (Morocco)
  "ar-OM", // Arabic (Oman)
  "ar-QA", // Arabic (Qatar)
  "ar-SA", // Arabic (Saudi Arabia)
  "ar-SD", // Arabic (Sudan)
  "ar-SY", // Arabic (Syria)
  "ar-TN", // Arabic (Tunisia)
  "ar-YE", // Arabic (Yemen)
  "fa", // Persian/Farsi
  "fa-IR", // Persian (Iran)
  "he", // Hebrew
  "he-IL", // Hebrew (Israel)
  "ur", // Urdu
  "ur-PK", // Urdu (Pakistan)
  "yi", // Yiddish
]);

/**
 * Text direction type.
 */
export type TextDirection = "ltr" | "rtl";

/**
 * Determines the text direction for a given locale.
 * Returns "rtl" for right-to-left languages (Arabic, Hebrew, Persian, Urdu, etc.)
 * and "ltr" for all other languages.
 *
 * @param locale - The locale code (e.g., "en-US", "ar-SA")
 * @returns The text direction ("ltr" or "rtl")
 * @example
 * ```typescript
 * getLocaleDirection("en-US"); // "ltr"
 * getLocaleDirection("ar-SA"); // "rtl"
 * getLocaleDirection("he"); // "rtl"
 * ```
 */
export function getLocaleDirection(locale: string): TextDirection {
  if (RTL_LOCALES.has(locale)) {
    return "rtl";
  }

  const baseLocale = locale.split("-")[0];
  if (baseLocale && RTL_LOCALES.has(baseLocale)) {
    return "rtl";
  }

  return "ltr";
}

/**
 * Type-safe version of getLocaleDirection for app locales.
 * Use this when you have a validated Locale type.
 *
 * @param locale - A valid application locale
 * @returns The text direction for the locale
 */
export function getAppLocaleDirection(locale: Locale): TextDirection {
  return getLocaleDirection(locale);
}

/**
 * Checks if a locale uses right-to-left text direction.
 *
 * @param locale - The locale code to check
 * @returns True if the locale is RTL, false otherwise
 */
export function isRtlLocale(locale: string): boolean {
  return getLocaleDirection(locale) === "rtl";
}
