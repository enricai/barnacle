"use strict";
/**
 * Contract every site plugin implements and that core's dispatch layer consumes.
 * Lives at the top of `src/` alongside `config.ts` and `server.ts` because it
 * is engine-level infrastructure, not site-specific logic — any new site drops
 * a plugin into `src/sites/<id>/` and satisfies this interface without touching
 * core.
 *
 * All imports are type-only: this file has zero runtime side effects and is safe
 * to import from any layer without pulling in browser or config initialization.
 */
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=site-plugin.js.map