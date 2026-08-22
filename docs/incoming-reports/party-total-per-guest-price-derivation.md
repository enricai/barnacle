# Incoming report: party-total / per-guest price derivation

**Date:** 2026-08-22

Some captured responses carry an aggregate total field alongside a nested
per-unit breakdown that sums to it — for example, an order's `total` field
next to a `lineItems` map where each entry carries its own `price`, with
`total` observably equal to the sum of the `price` values across entries.

Open question for the barnacle team: should `recon-generate` surface or
annotate that the aggregate field's basis is derivable from the nested
per-unit breakdown, rather than emitting the aggregate as an independent,
unrelated numeric field in the generated schema?

## Resolution

This is already handled. `recon-generate` annotates this exact shape
automatically via its aggregate/per-unit basis detector — when a numeric
aggregate field's value observably equals the sum of a same-named field
carried by a nested per-unit breakdown, the generated schema's `.describe()`
on that field names the breakdown path it was derived from, rather than
leaving the aggregate as an unrelated free-floating number.

See:

- docs/architecture.md, "Why the generator annotates aggregate/per-unit basis
  instead of deriving it" — the rationale for annotating rather than
  collapsing or deriving the aggregate field.
- docs/plugin-authoring.md, "Reading an aggregate/per-unit basis annotation"
  — how to read and use the annotation when authoring or consuming a
  generated contract.

No further action is needed against this report.
