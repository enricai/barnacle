import { z } from "zod/v4";

import type { SitePlugin } from "./types";

const HelloPayloadSchema = z.object({ name: z.string().min(1) });
const HelloResponseSchema = z.object({ greeting: z.string() });

type HelloPayload = z.infer<typeof HelloPayloadSchema>;

/**
 * A minimal, runnable out-of-tree plugin template. It exists so an operator can
 * copy this directory, run `pnpm build`, point `BARNACLE_PLUGINS` at
 * `dist/index.js`, and immediately see `POST /v1/hello-site/run` served by the
 * stock Barnacle server — no core edits.
 *
 * It implements only the direct-HTTP hot path (`executeHttp`); the browser
 * fallback throws, since this example has no site to automate.
 *
 * To ship binary assets (e.g. a resume fixture), resolve them relative to the
 * module with `path.join(__dirname, "fixtures", "…")` — never cwd-relative,
 * which breaks depending on where the server is launched.
 */
const helloSitePlugin: SitePlugin = {
  meta: {
    siteId: "hello-site",
    displayName: "Hello Site (example)",
    bodySchema: HelloPayloadSchema,
    responseSchema: HelloResponseSchema,
    apiVersion: "1.0.0",
  },
  async executeHttp(payload): Promise<{ data: { greeting: string } }> {
    const { name } = payload as HelloPayload;
    return { data: { greeting: `hello, ${name}` } };
  },
  async execute(): Promise<{ data: { greeting: string } }> {
    throw new Error("hello-site: browser fallback not implemented — this is an HTTP-only example");
  },
};

export { helloSitePlugin as plugin };
export default helloSitePlugin;
