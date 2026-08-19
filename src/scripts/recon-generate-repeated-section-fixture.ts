import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

const HOST = "https://api.example.com";
const CREATED_RECORD_ID = "rec-9d21a4";

/**
 * Reproduces a recon capture set where the created record's id is threaded
 * into every later URL's PATH (not just the request body), and one section
 * leaf is re-hit many times with a fresh id/body each time — the
 * `/jobapplication/<id>/name` and 12x `/package/<id>/validate` shape from the
 * reported multicall-flow defect, generalized to a permit/benefits
 * application domain instead of any real site or ATS vendor. Downstream
 * tests use this to pin the generator's required behavior against
 * real-shaped input rather than the already-covered static-leaf
 * multiendpoint fixture.
 */
export function buildRepeatedSectionSubmissionCaptures(): Capture[] {
  const section = (name: string, index: number, body: Record<string, unknown>): Capture =>
    buildCapture({
      url: `${HOST}/applications/${CREATED_RECORD_ID}/${name}`,
      requestPostData: JSON.stringify(body),
      responseBody: { section: name, applicationId: CREATED_RECORD_ID, saved: true },
      timestamp: `2024-03-01T00:00:${String(index).padStart(2, "0")}Z`,
    });

  const validate = (index: number, revision: number): Capture => ({
    ...buildCapture({
      url: `${HOST}/applications/${CREATED_RECORD_ID}/validate`,
      requestPostData: JSON.stringify({ revision, checksum: `chk-${revision}` }),
      responseBody: { valid: revision % 3 !== 0, revision },
      timestamp: `2024-03-01T00:00:${String(index).padStart(2, "0")}Z`,
    }),
    method: "PUT",
  });

  return [
    buildCapture({
      url: `${HOST}/applications`,
      requestPostData: JSON.stringify({ programId: "prog-42" }),
      responseBody: { applicationId: CREATED_RECORD_ID, status: "draft" },
      timestamp: "2024-03-01T00:00:00Z",
    }),
    section("applicant", 1, { firstName: "Jo", lastName: "Doe" }),
    section("address", 2, { line1: "1 Main St" }),
    section("contact", 3, { email: "jo@example.com" }),
    section("employment", 4, { employer: "Acme" }),
    section("attachments", 5, { fileName: "proof.pdf" }),
    validate(6, 1),
    validate(7, 2),
    validate(8, 3),
    validate(9, 4),
  ];
}
