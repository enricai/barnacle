import { afterEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/db/client";
import { buildServer } from "@/server";

// vi.hoisted ensures the mock function is available when vi.mock factories run (which are hoisted).
const mockExecute = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    data: {
      confirmationNumber: "FEMA-2024-99999",
      pagesCompleted: 42,
    },
    auditPayload: {},
  })
);

// Stub the service so tests don't touch the browser or DB.
vi.mock("@/sites/fema/service", () => ({
  execute: mockExecute,
}));

// Bypass the session pool so tests don't need a real Steel session.
// The server's plugin loop calls runWithSession(task) — we invoke task directly
// with a null session since execute is already mocked above.
vi.mock("@/scraper/pool", () => ({
  runWithSession: vi.fn().mockImplementation((task: (s: null) => Promise<unknown>) => task(null)),
  drainPool: vi.fn().mockResolvedValue(undefined),
  poolStats: vi.fn().mockReturnValue({ size: 0, pending: 0, concurrency: 3 }),
}));

// Stub Prisma so buildServer() doesn't need a live DB.
vi.mock("@/lib/db/client", () => ({
  prisma: {
    $disconnect: vi.fn(),
    siteSubmission: { create: vi.fn().mockResolvedValue({ id: "stub-id" }) },
  },
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

  it("returns 200 with the success envelope on a valid request", async () => {
    const app = await buildWithBypass();
    const response = await app.inject({
      method: "POST",
      url: "/v1/fema/submit",
      headers: { authorization: "Bearer dev" },
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.confirmationNumber).toBe("FEMA-2024-99999");
    expect(body.pagesCompleted).toBe(42);
    expect(body.status.httpStatus).toBe("OK");

    expect(prisma.siteSubmission.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ siteId: "fema", status: "submitted" }),
      })
    );
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
