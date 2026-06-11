import * as Prisma from './internal/prismaNamespaceBrowser.js';
export { Prisma };
export * as $Enums from './enums.js';
export * from './enums.js';
/**
 * Model SiteSubmission
 * Site-agnostic audit row written by Phase 3 dispatch for every plugin
 * execution. Using one table across all sites lets audit and replay logic live
 * in core rather than being duplicated per-plugin, and makes cross-site queries
 * trivial — the siteId column scopes rows back to the originating plugin.
 */
export type SiteSubmission = Prisma.SiteSubmissionModel;
