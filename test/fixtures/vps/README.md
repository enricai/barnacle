# VPS sample fixtures

Copies of the `Sample *.json` files from `RC_API_Docs/`. Each one mixes curl
request snippets (with `//` comments) and one or more response JSON blobs in
a single file, so the raw files are not valid JSON.

Tests load these via the helper in `test/helpers/vps-fixtures.ts`, which:
1. Strips `//` line comments.
2. Extracts each `// Sample ... Response` block as a parseable JSON object.
3. Returns `{ requests: [...], responses: [...] }`.

Round-trip tests assert that the VPS-parity Zod schemas in
`src/api/schemas/**` can `.parse()` every real-world response without
crashing — this is the contract that proves feature parity.
