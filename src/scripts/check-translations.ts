import * as fs from "node:fs";
import * as path from "node:path";

import { getLoggerFromFilename } from "@/lib/logging";

/**
 * Validates translation files for consistency and structure.
 * Checks that all locales have matching keys with the default locale.
 */

const logger = getLoggerFromFilename({ filename: __filename });
const MESSAGES_DIR = path.join(process.cwd(), "messages");
const DEFAULT_LOCALE = "en";

interface TranslationObject {
  [key: string]: string | TranslationObject;
}

interface LocaleValidationResult {
  locale: string;
  missingKeys: string[];
  extraKeys: string[];
}

/**
 * Recursively extracts all keys from a nested translation object.
 *
 * @param obj - The translation object to extract keys from
 * @param prefix - The current key prefix for nested objects
 * @returns Array of dot-notation keys
 */
function getKeys(obj: TranslationObject, prefix = ""): string[] {
  const keys: string[] = [];

  for (const key of Object.keys(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const value = obj[key];

    if (typeof value === "object" && value !== null) {
      keys.push(...getKeys(value as TranslationObject, fullKey));
    } else {
      keys.push(fullKey);
    }
  }

  return keys;
}

/**
 * Loads and parses a JSON translation file.
 *
 * @param locale - The locale code (e.g., "en-US", "es-ES")
 * @returns The parsed translation object
 * @throws Error if file cannot be read or parsed
 */
function loadTranslations(locale: string): TranslationObject {
  const filePath = path.join(MESSAGES_DIR, `${locale}.json`);

  if (!fs.existsSync(filePath)) {
    throw new Error(`translation file not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, "utf-8");

  try {
    return JSON.parse(content) as TranslationObject;
  } catch {
    throw new Error(`invalid JSON in translation file: ${filePath}`);
  }
}

/**
 * Gets all available locales from the messages directory.
 *
 * @returns Array of locale codes
 */
function getAvailableLocales(): string[] {
  const files = fs.readdirSync(MESSAGES_DIR);
  return files.filter((file) => file.endsWith(".json")).map((file) => file.replace(".json", ""));
}

/**
 * Validates a single locale against the default locale keys.
 *
 * @param locale - The locale to validate
 * @param defaultKeys - Keys from the default locale
 * @returns Validation result with missing and extra keys
 */
function validateLocale(locale: string, defaultKeys: string[]): LocaleValidationResult {
  const translations = loadTranslations(locale);
  const localeKeys = getKeys(translations).sort();

  const missingKeys = defaultKeys.filter((key) => !localeKeys.includes(key));
  const extraKeys = localeKeys.filter((key) => !defaultKeys.includes(key));

  return { locale, missingKeys, extraKeys };
}

/**
 * Logs the validation results for a locale.
 *
 * @param result - The validation result to log
 * @returns true if there are missing keys (error), false otherwise
 */
function logValidationResult(result: LocaleValidationResult): boolean {
  const { locale, missingKeys, extraKeys } = result;

  if (missingKeys.length > 0) {
    logger.error(`${locale}: missing ${missingKeys.length} keys:`);
    for (const key of missingKeys) {
      logger.error(`  - ${key}`);
    }
  }

  if (extraKeys.length > 0) {
    logger.warn(`${locale}: has ${extraKeys.length} extra keys:`);
    for (const key of extraKeys) {
      logger.warn(`  - ${key}`);
    }
  }

  if (missingKeys.length === 0 && extraKeys.length === 0) {
    logger.info(`${locale}: all keys match`);
  }

  return missingKeys.length > 0;
}

/**
 * Main validation function.
 *
 * @returns Exit code (0 for success, 1 for failure)
 */
function validateTranslations(): number {
  const locales = getAvailableLocales();

  if (locales.length === 0) {
    logger.error("no translation files found in messages/");
    return 1;
  }

  logger.info(`found ${locales.length} locale(s): ${locales.join(", ")}`);

  if (!locales.includes(DEFAULT_LOCALE)) {
    logger.error(`default locale "${DEFAULT_LOCALE}" not found`);
    return 1;
  }

  const defaultTranslations = loadTranslations(DEFAULT_LOCALE);
  const defaultKeys = getKeys(defaultTranslations).sort();

  logger.info(`default locale has ${defaultKeys.length} keys`);

  const otherLocales = locales.filter((locale) => locale !== DEFAULT_LOCALE);
  const validationResults = otherLocales.map((locale) => validateLocale(locale, defaultKeys));
  const hasErrors = validationResults.some((result) => logValidationResult(result));

  if (hasErrors) {
    logger.error("translation validation failed");
    return 1;
  }

  logger.info("translation validation passed");
  return 0;
}

process.exit(validateTranslations());
