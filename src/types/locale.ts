/**
 * Supported locales for the application.
 * Using region-specific locale codes for proper number/date formatting.
 */
export const SUPPORTED_LOCALES = ["en-US"] as const;

/**
 * Type representing a supported locale.
 */
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * Default locale for the application.
 */
export const DEFAULT_LOCALE: SupportedLocale = "en-US";

/**
 * Type guard to check if a value is a supported locale.
 *
 * @param value - The value to check
 * @returns True if the value is a supported locale
 */
export function isSupportedLocale(value: string): value is SupportedLocale {
  return SUPPORTED_LOCALES.includes(value as SupportedLocale);
}
