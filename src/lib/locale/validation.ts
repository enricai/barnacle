/**
 * Locale validation utilities for type-safe locale handling.
 * Ensures locale values are valid before use throughout the application.
 */

import { defaultLocale, type Locale, locales } from "@/i18n/routing";

/**
 * Type guard to check if a string is a valid application locale.
 *
 * @param locale - The string to check
 * @returns True if the locale is a valid Locale type
 * @example
 * ```typescript
 * const userLocale = request.headers.get("accept-language");
 * if (isValidLocale(userLocale)) {
 *   // userLocale is typed as Locale here
 *   setLocale(userLocale);
 * }
 * ```
 */
export function isValidLocale(locale: string | null | undefined): locale is Locale {
  if (!locale) {
    return false;
  }
  return locales.includes(locale as Locale);
}

/**
 * Returns a safe locale value, falling back to the default if invalid.
 *
 * @param locale - The locale to validate
 * @returns A valid Locale value
 * @example
 * ```typescript
 * const locale = getSafeLocale(params.locale);
 * // locale is guaranteed to be a valid Locale
 * const messages = await loadMessages(locale);
 * ```
 */
export function getSafeLocale(locale: string | null | undefined): Locale {
  if (isValidLocale(locale)) {
    return locale;
  }
  return defaultLocale;
}

/**
 * Parses a locale string and extracts the language code.
 * Handles both ISO 639-1 (en) and BCP 47 (en-US) formats.
 *
 * @param locale - The locale string to parse
 * @returns The language code portion
 * @example
 * ```typescript
 * getLanguageCode("en-US"); // "en"
 * getLanguageCode("pt-BR"); // "pt"
 * getLanguageCode("en"); // "en"
 * ```
 */
export function getLanguageCode(locale: string): string {
  const parts = locale.split("-");
  return parts[0] || locale;
}

/**
 * Gets all supported locales.
 *
 * @returns Array of supported locale codes
 */
export function getSupportedLocales(): readonly Locale[] {
  return locales;
}

/**
 * Gets the default locale.
 *
 * @returns The default locale code
 */
export function getDefaultLocale(): Locale {
  return defaultLocale;
}

/**
 * Normalizes a locale string to match supported formats.
 * Attempts to find the best matching locale for a given input.
 *
 * @param locale - The locale string to normalize
 * @returns The best matching Locale or the default locale
 * @example
 * ```typescript
 * normalizeLocale("EN"); // "en" (case normalized)
 * normalizeLocale("en-US"); // "en" (region stripped if not supported)
 * normalizeLocale("invalid"); // defaultLocale
 * ```
 */
export function normalizeLocale(locale: string | null | undefined): Locale {
  if (!locale) {
    return defaultLocale;
  }

  const normalized = locale.toLowerCase();

  if (isValidLocale(normalized)) {
    return normalized;
  }

  const languageCode = getLanguageCode(normalized);
  if (isValidLocale(languageCode)) {
    return languageCode;
  }

  return defaultLocale;
}
