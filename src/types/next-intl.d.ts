import type messages from "../../messages/en.json";

/**
 * Type augmentation for next-intl 4.x
 * This provides type-safe message keys and format options.
 *
 * @see https://next-intl.dev/blog/next-intl-4-0
 */
declare module "next-intl" {
  interface AppConfig {
    Messages: typeof messages;
    Locale: "en";
  }
}

/**
 * Re-export the messages type for use elsewhere in the app.
 * This allows importing the message structure without the JSON file directly.
 */
export type Messages = typeof messages;
