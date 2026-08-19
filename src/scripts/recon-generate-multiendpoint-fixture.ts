import type { Capture } from "@/scripts/recon-shared";
import type { MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

function buildCapture(overrides: {
  method: string;
  url: string;
  requestPostData: string | null;
  responseBody: unknown;
  timestamp: string;
}): Capture {
  return {
    timestamp: overrides.timestamp,
    phase: "action",
    method: overrides.method,
    url: overrides.url,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: overrides.requestPostData,
    responseHeaders: { "content-type": "application/json" },
    responseBody: overrides.responseBody,
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function buildStep(
  varName: string,
  overrides: {
    method: string;
    url: string;
    requestPostData: string | null;
    responseBody: unknown;
    timestamp: string;
  }
): MulticallFixtureStep {
  return {
    capture: buildCapture(overrides),
    varName,
    produces: [],
    isMultipart: false,
    isCrossDomain: false,
  };
}

const HOST = "https://api.example.com";
const APPLICATIONS_URL = `${HOST}/applications`;
const APPLICANT_URL = `${HOST}/applicant`;
const ADDRESS_URL = `${HOST}/address`;
const CONTACT_URL = `${HOST}/contact`;
const EMPLOYMENT_URL = `${HOST}/employment`;
const ATTACHMENTS_URL = `${HOST}/attachments`;
const VALIDATE_URL = `${HOST}/validate`;

const CREATED_APPLICATION_ID = "app-7f3c2e";

/**
 * Reproduces the report's create -> per-section POST -> PUT validate shape
 * (docs/recon-generate-emits-bogus-http-stub-for-workday-multicall-flow.md
 * lines 30-46) with a generic permit/benefits application domain instead of
 * any real site or ATS vendor: a resource is created via one POST, its id is
 * threaded verbatim into five further section POSTs at distinct paths, and
 * two terminal PUT calls validate the submission. Each response body shape
 * is disjoint across endpoints so tests can assert the generator
 * distinguishes per-call shapes instead of collapsing them to one.
 */
export function buildMultiEndpointSubmissionActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      method: "POST",
      url: APPLICATIONS_URL,
      requestPostData: '{"programId":"prog-1"}',
      responseBody: { applicationId: CREATED_APPLICATION_ID, status: "draft" },
      timestamp: "2024-01-01T00:00:00Z",
    }),
    buildStep("r1", {
      method: "POST",
      url: APPLICANT_URL,
      requestPostData: `{"applicationId":"${CREATED_APPLICATION_ID}","firstName":"Jo","lastName":"Doe"}`,
      responseBody: { section: "applicant", complete: true },
      timestamp: "2024-01-01T00:00:01Z",
    }),
    buildStep("r2", {
      method: "POST",
      url: ADDRESS_URL,
      requestPostData: `{"applicationId":"${CREATED_APPLICATION_ID}","line1":"1 Main St"}`,
      responseBody: { addressId: "addr-1", verified: true },
      timestamp: "2024-01-01T00:00:02Z",
    }),
    buildStep("r3", {
      method: "POST",
      url: CONTACT_URL,
      requestPostData: `{"applicationId":"${CREATED_APPLICATION_ID}","email":"jo@example.com"}`,
      responseBody: { contactMethods: ["email"], preferredIndex: 0 },
      timestamp: "2024-01-01T00:00:03Z",
    }),
    buildStep("r4", {
      method: "POST",
      url: EMPLOYMENT_URL,
      requestPostData: `{"applicationId":"${CREATED_APPLICATION_ID}","employer":"Acme"}`,
      responseBody: { years: [2019, 2020, 2021], totalMonths: 30 },
      timestamp: "2024-01-01T00:00:04Z",
    }),
    buildStep("r5", {
      method: "POST",
      url: ATTACHMENTS_URL,
      requestPostData: `{"applicationId":"${CREATED_APPLICATION_ID}","fileName":"proof.pdf"}`,
      responseBody: { uploaded: [{ fileName: "proof.pdf", bytes: 4096 }] },
      timestamp: "2024-01-01T00:00:05Z",
    }),
    buildStep("r6", {
      method: "PUT",
      url: VALIDATE_URL,
      requestPostData: `{"applicationId":"${CREATED_APPLICATION_ID}","section":"address"}`,
      responseBody: { valid: true, errors: [] },
      timestamp: "2024-01-01T00:00:06Z",
    }),
    buildStep("r7", {
      method: "PUT",
      url: VALIDATE_URL,
      requestPostData: `{"applicationId":"${CREATED_APPLICATION_ID}","section":"employment"}`,
      responseBody: { valid: false, errors: [{ field: "employer", code: "required" }] },
      timestamp: "2024-01-01T00:00:07Z",
    }),
  ];
}
