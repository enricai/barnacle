"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.priceChangesSuperCategoryResponseSchema = exports.priceChangesSuperCategoryRequestSchema = void 0;
const price_changes_common_1 = require("@/api/schemas/price-changes-common");
/**
 * `POST /v1/pricing-snapshot/price-changes/super-category` — returns the
 * set of sailing keys whose super-category-level pricing has changed since
 * `fromDateTime`.
 */
exports.priceChangesSuperCategoryRequestSchema = price_changes_common_1.priceChangeRequestSchema;
exports.priceChangesSuperCategoryResponseSchema = price_changes_common_1.priceChangeResponseSchema;
//# sourceMappingURL=price-changes-super-category.js.map