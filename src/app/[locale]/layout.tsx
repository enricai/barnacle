import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";

import type { Locale } from "@/i18n/routing";
import { routing } from "@/i18n/routing";
import { getLocaleDirection } from "@/lib/locale/direction";

import "../globals.css";

type Props = {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
};

/**
 * Generates static params for all supported locales.
 * Required for static rendering with dynamic [locale] segment.
 *
 * @returns Array of locale params for static generation
 */
export function generateStaticParams(): Array<{ locale: string }> {
  return routing.locales.map((locale) => ({ locale }));
}

export const metadata: Metadata = {
  title: "App",
  description: "A modern Next.js 16 application",
};

/**
 * Root layout component with internationalization support.
 * Validates locale and provides i18n context to all child components.
 *
 * @param children - Child components to render within the layout
 * @param params - Route parameters containing the locale
 * @returns The root HTML structure with i18n provider
 */
export default async function LocaleLayout({
  children,
  params,
}: Props): Promise<React.ReactElement> {
  const { locale } = await params;

  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  setRequestLocale(locale as Locale);
  const messages = await getMessages();
  const direction = getLocaleDirection(locale);

  return (
    <html lang={locale} dir={direction}>
      <body className="antialiased">
        <NextIntlClientProvider messages={messages}>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
