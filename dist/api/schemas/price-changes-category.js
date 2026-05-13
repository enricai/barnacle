"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.priceChangesCategoryResponseSchema = exports.priceChangesCategoryRequestSchema = void 0;
const price_changes_common_1 = require("@/api/schemas/price-changes-common");
/**
 * `POST /v1/pricing-snapshot/price-changes/category` — returns the set of
 * sailing keys whose category-level pricing has changed since `fromDateTime`.
 */
exports.priceChangesCategoryRequestSchema = price_changes_common_1.priceChangeRequestSchema;
exports.priceChangesCategoryResponseSchema = price_changes_common_1.priceChangeResponseSchema;
//# sourceMappingURL=price-changes-category.js.map