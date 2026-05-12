import { createNavigation } from "next-intl/navigation";

import { routing } from "./routing";

/**
 * Navigation utilities for locale-aware routing.
 * Use these instead of Next.js native navigation components.
 */
export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);
