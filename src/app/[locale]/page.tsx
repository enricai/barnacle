import { useTranslations } from "next-intl";
import { setRequestLocale } from "next-intl/server";

import type { Locale } from "@/i18n/routing";

type Props = {
  params: Promise<{ locale: string }>;
};

/**
 * Home page component with internationalization support.
 * Sets the request locale for static rendering.
 *
 * @param params - Route parameters containing the locale
 * @returns The home page content
 */
export default async function HomePage({ params }: Props): Promise<React.ReactElement> {
  const { locale } = await params;
  setRequestLocale(locale as Locale);

  return <HomePageContent />;
}

/**
 * Home page content component.
 * Uses translations for displaying localized text.
 *
 * @returns The home page content with translated text
 */
function HomePageContent(): React.ReactElement {
  const t = useTranslations("HomePage");

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24">
      <h1 className="text-4xl font-bold text-gray-900">{t("title")}</h1>
      <p className="mt-4 text-gray-600">{t("description")}</p>
    </main>
  );
}
