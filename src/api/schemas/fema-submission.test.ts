import { describe, expect, it } from "vitest";

import {
  femaApplicantSchema,
  femaIdentitySchema,
  femaNeedsSchema,
  femaPreApplicationSchema,
  femaSubmissionRequestSchema,
  femaSubmissionResponseSchema,
} from "@/api/schemas/fema-submission";

const validPreApplication = {
  zipCode: "70001",
  disasterNumber: "DR-4567",
  countyFips: "22071",
};

const validNeeds = {
  homeDamage: true,
  vehicleDamage: false,
  funeralExpenses: false,
  medicalExpenses: false,
  childcare: false,
  homeSafetyItems: false,
  dateOfLoss: "2024-08-15",
  damageTypes: ["roof", "flooding"],
  citizenshipStatus: "US_CITIZEN",
};

const validIdentity = {
  email: "survivor@example.com",
  password: "SecurePass1",
  verificationMethod: "email" as const,
  verificationCode: "123456",
};

const validApplicant = {
  firstName: "Jane",
  lastName: "Doe",
  ssn: "123456789",
  dateOfBirth: "1980-05-20",
  phone: "5041234567",
  coApplicant: false,
  address: { line1: "123 Main St", city: "New Orleans", state: "LA", zip: "70001" },
  mailingAddressSame: true,
  ownershipStatus: "own" as const,
  homeType: "single-family",
  canAccessHome: false,
  accessBarriers: ["debris"],
  occupants: { adults: 2, children: 1, seniors: 0, disabledPersons: 0 },
  income: {
    employmentStatus: "employed",
    annualIncome: 45000,
    disasterImpact: "Lost wages due to evacuation",
  },
  bankAccount: {
    routingNumber: "021000021",
    accountNumber: "987654321",
    accountType: "checking" as const,
  },
  notifications: { method: "email" as const, language: "en" },
};

describe("femaPreApplicationSchema", () => {
  it("accepts a valid pre-application", () => {
    expect(() => femaPreApplicationSchema.parse(validPreApplication)).not.toThrow();
  });

  it("rejects a non-5-digit ZIP", () => {
    expect(() =>
      femaPreApplicationSchema.parse({ ...validPreApplication, zipCode: "700" })
    ).toThrow();
  });

  it("rejects missing disasterNumber", () => {
    const { disasterNumber: _, ...rest } = validPreApplication;
    expect(() => femaPreApplicationSchema.parse(rest)).toThrow();
  });
});

describe("femaNeedsSchema", () => {
  it("accepts valid needs without conditional fields", () => {
    expect(() => femaNeedsSchema.parse(validNeeds)).not.toThrow();
  });

  it("accepts needs with funeral detail when funeralExpenses is true", () => {
    const withFuneral = {
      ...validNeeds,
      funeralExpenses: true,
      funeralDetail: {
        deceasedName: "John Doe",
        dateOfDeath: "2024-08-10",
        relationship: "spouse",
        estimatedCost: 5000,
      },
    };
    expect(() => femaNeedsSchema.parse(withFuneral)).not.toThrow();
  });

  it("rejects empty damageTypes array", () => {
    expect(() => femaNeedsSchema.parse({ ...validNeeds, damageTypes: [] })).toThrow();
  });

  it("rejects invalid dateOfLoss format", () => {
    expect(() => femaNeedsSchema.parse({ ...validNeeds, dateOfLoss: "08/15/2024" })).toThrow();
  });
});

describe("femaIdentitySchema", () => {
  it("accepts valid identity", () => {
    expect(() => femaIdentitySchema.parse(validIdentity)).not.toThrow();
  });

  it("rejects invalid email", () => {
    expect(() => femaIdentitySchema.parse({ ...validIdentity, email: "not-an-email" })).toThrow();
  });

  it("rejects password shorter than 8 chars", () => {
    expect(() => femaIdentitySchema.parse({ ...validIdentity, password: "short" })).toThrow();
  });

  it("rejects unknown verificationMethod", () => {
    expect(() =>
      femaIdentitySchema.parse({ ...validIdentity, verificationMethod: "carrier_pigeon" })
    ).toThrow();
  });
});

describe("femaApplicantSchema", () => {
  it("accepts a valid applicant", () => {
    expect(() => femaApplicantSchema.parse(validApplicant)).not.toThrow();
  });

  it("rejects SSN that is not 9 digits", () => {
    expect(() => femaApplicantSchema.parse({ ...validApplicant, ssn: "12345" })).toThrow();
  });

  it("rejects routing number that is not 9 digits", () => {
    expect(() =>
      femaApplicantSchema.parse({
        ...validApplicant,
        bankAccount: { ...validApplicant.bankAccount, routingNumber: "1234" },
      })
    ).toThrow();
  });

  it("accepts optional conditional fields when present", () => {
    const withExtras = {
      ...validApplicant,
      extentOfDamage: {
        severity: "major",
        habitable: false,
        estimatedRepairCost: 30000,
        affectedRooms: ["living room", "bedroom"],
        waterIntrusion: true,
      },
      vehicleDamage: {
        make: "Toyota",
        model: "Camry",
        year: 2019,
        severity: "destroyed",
        drivable: false,
        insured: true,
      },
    };
    expect(() => femaApplicantSchema.parse(withExtras)).not.toThrow();
  });
});

describe("femaSubmissionRequestSchema", () => {
  const validRequest = {
    preApplication: validPreApplication,
    needs: validNeeds,
    identity: validIdentity,
    applicant: validApplicant,
  };

  it("accepts a complete valid request", () => {
    expect(() => femaSubmissionRequestSchema.parse(validRequest)).not.toThrow();
  });

  it("accepts an optional sessionFixture", () => {
    expect(() =>
      femaSubmissionRequestSchema.parse({ ...validRequest, sessionFixture: "demo" })
    ).not.toThrow();
  });

  it("rejects request missing identity", () => {
    const { identity: _, ...rest } = validRequest;
    expect(() => femaSubmissionRequestSchema.parse(rest)).toThrow();
  });
});

describe("femaSubmissionResponseSchema", () => {
  it("accepts a valid success response", () => {
    const response = {
      status: { httpStatus: "OK", dateTime: "2024-08-15T12:00:00Z", details: [] },
      submissionId: "clxxx",
      confirmationNumber: "FEMA-2024-12345",
      pagesCompleted: 42,
      submittedAt: "2024-08-15T12:00:00Z",
    };
    expect(() => femaSubmissionResponseSchema.parse(response)).not.toThrow();
  });

  it("accepts response without confirmationNumber", () => {
    const response = {
      status: { httpStatus: "OK", dateTime: "2024-08-15T12:00:00Z", details: [] },
      submissionId: "clxxx",
      pagesCompleted: 42,
      submittedAt: "2024-08-15T12:00:00Z",
    };
    expect(() => femaSubmissionResponseSchema.parse(response)).not.toThrow();
  });
});
