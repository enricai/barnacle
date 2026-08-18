import { describe, expect, it } from "vitest";
import {
  compileActionSteps,
  emitContractTs,
  emitMultiStepExecuteHttp,
  extractGraphQLActionSequence,
  indexStateValues,
} from "@/scripts/recon-generate";

const BASE = "https://aidfinder.example.com";

const gqlCapture = (
  operationName: string,
  kind: "query" | "mutation",
  responseBody: unknown,
  requestPostData: string
) => ({
  timestamp: "2024-01-01T00:00:00Z",
  phase: "action" as const,
  method: "POST",
  url: `${BASE}/graphql`,
  status: 200,
  requestHeaders: { "Content-Type": "application/json" },
  requestPostData,
  responseHeaders: {},
  responseBody,
  operationName,
  query: `${kind} ${operationName}($input: Input) {\n  ${operationName}(input: $input) { id }\n}`,
  variables: null,
  decodedParams: null,
});

describe("read-only primary-operation selection does not affect mutation-bearing flows", () => {
  it("still drops the bootstrap query and keeps only the mutation sequence, threading to a multi-step executeHttp covering every mutation", () => {
    const captures = [
      gqlCapture("ListForms", "query", { forms: [] }, '{"op":"ListForms"}'),
      gqlCapture("Form", "mutation", { formId: "f-1" }, '{"op":"Form"}'),
      gqlCapture(
        "UpsertSavedApplication",
        "mutation",
        { applicationId: "app-1" },
        '{"op":"UpsertSavedApplication"}'
      ),
      gqlCapture("SubmitForm", "mutation", { submissionId: "sub-1" }, '{"op":"SubmitForm"}'),
      gqlCapture(
        "FinalizeFormSubmission",
        "mutation",
        { finalized: true },
        '{"op":"FinalizeFormSubmission"}'
      ),
    ];

    const actionCaptures = extractGraphQLActionSequence(captures, BASE);
    expect(actionCaptures.map((a) => a.capture.operationName)).toEqual([
      "Form",
      "UpsertSavedApplication",
      "SubmitForm",
      "FinalizeFormSubmission",
    ]);

    const stateIndex = indexStateValues(
      captures,
      new Set(),
      new Set(actionCaptures.map((a) => a.index))
    );
    const actionSteps = compileActionSteps(actionCaptures, stateIndex);
    const isSubmissionFlow = actionSteps.length > 1;
    expect(isSubmissionFlow).toBe(true);

    const body = emitMultiStepExecuteHttp(
      actionSteps,
      null,
      { stringMessageKey: null, nestedErrorPaths: [] },
      new Map(),
      new Set(),
      new Map(),
      new Set(),
      new Map(),
      new Map(),
      BASE,
      new Map(),
      new Map()
    );

    expect(actionSteps).toHaveLength(4);
    expect(actionSteps.map((s) => s.capture.operationName)).toEqual([
      "Form",
      "UpsertSavedApplication",
      "SubmitForm",
      "FinalizeFormSubmission",
    ]);
    expect(body).not.toContain("ListForms");
  });

  it("a single mutation capture (isSubmissionFlow false) never enters the read-only selection branch, so the emitted call site is unaffected", () => {
    const captures = [gqlCapture("Form", "mutation", { formId: "f-1" }, '{"op":"Form"}')];

    // extractGraphQLActionSequence is non-empty here — the structural gate
    // that guards selectPrimaryGraphQLOperation (graphqlActionSequence.length
    // === 0) never fires, so the real pipeline computes gqlOperationName /
    // gqlVariables as null for this capture set, exactly as pre-fix.
    const actionCaptures = extractGraphQLActionSequence(captures, BASE);
    expect(actionCaptures).toHaveLength(1);

    const stateIndex = indexStateValues(
      captures,
      new Set(),
      new Set(actionCaptures.map((a) => a.index))
    );
    const actionSteps = compileActionSteps(actionCaptures, stateIndex);
    const isSubmissionFlow = actionSteps.length > 1;
    expect(isSubmissionFlow).toBe(false);

    const source = emitContractTs({
      siteId: "test-site",
      pascal: "TestSite",
      baseUrl: BASE,
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: { formId: "f-1" },
      gql: true,
      gqlQuery: captures[0]!.query,
      endpointPath: "/graphql",
      auxFiles: [],
      gqlOperationName: null,
      gqlVariables: null,
    });

    expect(source).toContain(
      'getGql(context.baseUrl)("TestSiteSearch", TESTSITE_QUERY, { q: payload.query })'
    );
    expect(source).not.toContain('getGql(context.baseUrl)("Form"');
  });
});
