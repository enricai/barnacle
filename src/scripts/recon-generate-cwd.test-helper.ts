import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Working directory for recon-generate CLI runs in tests. The CLI writes
 * `src/sites/<siteId>` relative to its cwd, so running it from the repo root
 * drops half-written plugins into the real source tree where a concurrent
 * `tsc`/biome run picks them up. This gitignored scratch tree keeps them out
 * while staying inside the repo, so emitted imports still resolve
 * `node_modules` and the tsconfig path aliases.
 */
export const RECON_GENERATE_CWD = join(__dirname, "..", "..", "tmp", "recon-generate");

/**
 * {@link RECON_GENERATE_CWD} relative to the repo root, for tsconfig `include`
 * globs written next to the root tsconfig.
 */
export const RECON_GENERATE_CWD_FROM_REPO_ROOT = "tmp/recon-generate";

mkdirSync(RECON_GENERATE_CWD, { recursive: true });
