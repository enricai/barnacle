import type { SitePlugin } from "@/site-plugin";
import type { FemaSubmissionResult } from "@/sites/fema/flow";
import type { FemaSubmissionRequest } from "@/sites/fema/schema";
import { femaPluginResponseSchema, femaSubmissionRequestSchema } from "@/sites/fema/schema";
import { execute } from "@/sites/fema/service";

/**
 * FEMA disaster assistance plugin — registered in server.ts's SITE_PLUGINS
 * array. Uses routeOverride to preserve the existing /v1/fema/submit path
 * so existing clients need no URL changes.
 */
export const femaPlugin: SitePlugin<FemaSubmissionRequest, FemaSubmissionResult> = {
  meta: {
    siteId: "fema",
    displayName: "FEMA Disaster Assistance",
    bodySchema: femaSubmissionRequestSchema,
    responseSchema: femaPluginResponseSchema,
    routeOverride: "/v1/fema/submit",
  },
  execute,
};
