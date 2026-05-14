import { afterEach, describe, expect, it, vi } from "vitest";

import { buildServer } from "@/server";

// Stub the service so tests don't touch the browser or DB.
vi.mock("@/services/fema-submission", () => ({
  submitApplication: vi.fn().mockResolvedValue({
    status: { httpStatus: "OK", dateTime: "2024-08-15T12:00:00Z", details: [] },
    submissionId: "cltestid",
    confirmationNumber: "FEMA-2024-99999",
    pagesCompleted: 42,
    submittedAt: "2024-08-15T12:00:00Z",
  }),
}));

// Stub Prisma so buildServer() doesn't need a live DB.
vi.mock("@/lib/db/client", () => ({
  prisma: { $disconnect: vi.fn() },
}));

const VALID_BODY = {
  preApplication: {
    zipCode: "70001",
    disasterNumber: "DR-4567",
    countyFips: "22071",
  },
  needs: {
    homeDamage: true,
    vehicleDamage: false,
    funeralExpenses: false,
    medicalExpenses: false,
    childcare: false,
    homeSafetyItems: false,
    dateOfLoss: "2024-08-15",
    damageTypes: ["flooding"],
    citizenshipStatus: "US_CITIZEN",
  },
  identity: {
    email: "survivor@example.com",
    password: "SecurePass1",
    verificationMethod: "email",
    verificationCode: "123456",
  },
  applicant: {
    firstName: "Jane",
    lastName: "Doe",
    ssn: "123456789",
    dateOfBirth: "1980-05-20",
    phone: "5041234567",
    coApplicant: false,
    address: { line1: "123 Main St", city: "New Orleans", state: "LA", zip: "70001" },
    mailingAddressSame: true,
    ownershipStatus: "own",
    homeType: "single-family",
    canAccessHome: false,
    occupants: { adults: 2, children: 0, seniors: 0, disabledPersons: 0 },
    income: {
      employmentStatus: "employed",
      annualIncome: 45000,
      disasterImpact: "Lost wages",
    },
    bankAccount: {
      routingNumber: "021000021",
      accountNumber: "987654321",
      accountType: "checking",
    },
    notifications: { method: "email", language: "en" },
  },
};

describe("POST /v1/fema/submit", () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  async function buildWithBypass(): Promise<Awaited<ReturnType<typeof buildServer>>> {
    process.env.DEV_BYPASS_AUTH = "true";
    return buildServer();
  }

  async function buildWithAuth(): Promise<Awaited<ReturnType<typeof buildServer>>> {
    delete process.env.DEV_BYPASS_AUTH;
    return buildServer();
  }

  it("returns 200 with submissionId on a valid request", async () => {
    const app = await buildWithBypass();
    const response = await app.inject({
      method: "POST",
      url: "/v1/fema/submit",
      headers: { authorization: "Bearer dev" },
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.submissionId).toBe("cltestid");
    expect(body.confirmationNumber).toBe("FEMA-2024-99999");
    expect(body.pagesCompleted).toBe(42);
    expect(body.status.httpStatus).toBe("OK");
  });

  it("returns 401 without an auth header", async () => {
    const app = await buildWithAuth();
    const response = await app.inject({
      method: "POST",
      url: "/v1/fema/submit",
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(401);
  });

  it("returns 400 on a malformed body", async () => {
    const app = await buildWithBypass();
    const response = await app.inject({
      method: "POST",
      url: "/v1/fema/submit",
      headers: { authorization: "Bearer dev" },
      payload: { preApplication: { zipCode: "BAD" } },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.status.details[0].code).toBe(1002);
  });

  it("returns 404 for unknown routes", async () => {
    const app = await buildWithBypass();
    const response = await app.inject({
      method: "GET",
      url: "/v1/unknown",
    });
    expect(response.statusCode).toBe(404);
  });
});
