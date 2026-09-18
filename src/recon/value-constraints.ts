/**
 * Consumer-supplied value constraints that name real domain limits the
 * generator's own captured responses never expose a shape for.
 *
 * A sibling to {@link @/recon/vocabulary} and {@link @/recon/form-schema}: a
 * vocabulary matches instruction prose and a form-schema matches response
 * wire keys, this names a domain fact — a field's true enum or numeric
 * ceiling — that no same-run response leaf carries a max/capacity/limit-shaped
 * signal for. Published at `@enricai/barnacle/recon/value-constraints`; all
 * imports are type-only so there are zero runtime side effects.
 *
 * Why this exists: the generator infers request facet values and
 * quantity/capacity limits by shape alone, from whatever a captured response
 * happens to carry. That works when a response leaf actually exposes the
 * ceiling (e.g. a listing's `availableUnits`), but plenty of real constraints
 * — a venue's true seating capacity, a fixed set of valid tier codes — exist
 * only as domain knowledge the site never echoes back in any observed
 * response. Absent this escape hatch the generator has no way to learn them
 * and either guesses unboundedly or not at all. A consumer that knows the
 * real constraint declares it here; the generator prefers a declared
 * constraint over its own shape-only inference wherever one is present.
 */

/**
 * Per-field value constraints, keyed by payload field name.
 *
 * Each entry is optional in isolation: a field may declare only an enum, only
 * a range, or both. Absence of a key means the generator falls back to its
 * existing shape-only inference for that field — this type only ever
 * narrows, never replaces, the engine's default behavior.
 */
export interface ReconValueConstraints {
  [payloadFieldName: string]: {
    /** The closed set of legal values for this field, if one exists. */
    enumValues?: readonly string[];
    /** The field's true lower bound, if the domain fixes one. */
    min?: number;
    /** The field's true upper bound (e.g. a resource's real capacity), if the domain fixes one. */
    max?: number;
  };
}

/**
 * The empty constraint set, for consumers whose fields carry no domain
 * ceiling the generator's own shape-only inference cannot already recover.
 */
export const EMPTY_VALUE_CONSTRAINTS: ReconValueConstraints = {};
