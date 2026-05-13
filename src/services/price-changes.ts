import { formatISO, parseISO } from "date-fns";

import { successEnvelope } from "@/api/helpers/envelope";
import type { PriceChangeResponse } from "@/api/schemas/price-changes-common";
import { sailDateToNumeric } from "@/lib/sail-date";
import { findPricingKeysChangedSince } from "@/snapshots/store";

/**
 * Computes the delta response for `POST /v1/pricing-snapshot/price-
 * changes/{super-category|category}`. The `granularity` argument picks
 * which snapshot stream to compare against.
 */
export async function getPriceChanges(
  fromDateTime: string,
  granularity: "super-category" | "category"
): Promise<PriceChangeResponse> {
  const since = parseISO(fromDateTime);
  const rows = await findPricingKeysChangedSince(since, granularity);

  const keys = rows.map((r) => ({
    shipCode: r.shipCode,
    sailDate: sailDateToNumeric(r.sailDate),
    packageCode: r.packageCode,
    currencyCode: r.currencyCode,
    occupancy: r.occupancy,
    bookingType: r.bookingTypeCode,
  }));

  return successEnvelope({
    keys,
    dateTimeRange: {
      fromDateTime,
      toDateTime: formatISO(new Date()),
    },
  }) as PriceChangeResponse;
}
