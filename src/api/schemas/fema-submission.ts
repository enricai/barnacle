import { z } from "zod";

import { vpsStatusSchema } from "@/api/schemas/common";

// ---------------------------------------------------------------------------
// Phase 1: Pre-Application
// ---------------------------------------------------------------------------

export const femaPreApplicationSchema = z.object({
  zipCode: z.string().regex(/^\d{5}$/, "must be a 5-digit ZIP code"),
  disasterNumber: z.string().min(1),
  countyFips: z.string().min(1),
});

export type FemaPreApplication = z.infer<typeof femaPreApplicationSchema>;

// ---------------------------------------------------------------------------
// Phase 2: Needs Assessment
// ---------------------------------------------------------------------------

const funeralDetailSchema = z.object({
  deceasedName: z.string().min(1),
  dateOfDeath: z.string().min(1),
  relationship: z.string().min(1),
  estimatedCost: z.number().nonnegative(),
});

const medicalDetailSchema = z.object({
  details: z.string().min(1),
});

const homeDamageDetailSchema = z.object({
  details: z.string().min(1),
});

export const femaNeedsSchema = z.object({
  // Property Damage
  homeDamage: z.boolean(),
  vehicleDamage: z.boolean(),
  personalPropertyDamage: z.boolean().default(false),
  // Emergency Needs
  foodShelter: z.boolean().default(false),
  homeAccess: z.boolean().default(false),
  lossOfUtilities: z.boolean().default(false),
  // Other Expenses
  funeralExpenses: z.boolean(),
  medicalExpenses: z.boolean(),
  childcare: z.boolean(),
  homeSafetyItems: z.boolean(),
  lodging: z.boolean().default(false),
  // Conditional detail pages — required when the matching flag is true.
  // Callers must populate these if the corresponding flag is set.
  funeralDetail: funeralDetailSchema.optional(),
  medicalDetail: medicalDetailSchema.optional(),
  homeDamageDetail: homeDamageDetailSchema.optional(),
  dateOfLoss: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD"),
  damageTypes: z.array(z.string()).min(1),
  citizenshipStatus: z.string().min(1),
});

export type FemaNeeds = z.infer<typeof femaNeedsSchema>;

// ---------------------------------------------------------------------------
// Phase 3: Identity
// ---------------------------------------------------------------------------

export const femaIdentitySchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  verificationMethod: z.enum(["text", "email"]),
  verificationCode: z.string().min(4),
});

export type FemaIdentity = z.infer<typeof femaIdentitySchema>;

// ---------------------------------------------------------------------------
// Phase 4: Application Center
// ---------------------------------------------------------------------------

const addressSchema = z.object({
  line1: z.string().min(1),
  line2: z.string().optional(),
  city: z.string().min(1),
  state: z.string().length(2),
  zip: z.string().regex(/^\d{5}$/, "must be a 5-digit ZIP code"),
});

const occupantsSchema = z.object({
  adults: z.number().int().nonnegative(),
  children: z.number().int().nonnegative(),
  seniors: z.number().int().nonnegative(),
  disabledPersons: z.number().int().nonnegative(),
});

const incomeSchema = z.object({
  employmentStatus: z.string().min(1),
  employer: z.string().optional(),
  occupation: z.string().optional(),
  annualIncome: z.number().nonnegative(),
  disasterImpact: z.string().min(1),
  dependentsCount: z.number().int().min(1).max(50).default(1),
});

const bankAccountSchema = z.object({
  bankName: z.string().min(1).default("My Bank"),
  routingNumber: z.string().regex(/^\d{9}$/, "must be a 9-digit routing number"),
  accountNumber: z.string().min(1),
  accountType: z.enum(["checking", "savings"]),
});

const notificationsSchema = z.object({
  method: z.enum(["email", "text", "phone", "mail"]),
  bestTimeToCall: z.string().optional(),
  language: z.string().min(1),
  accessibilityNeeds: z.string().optional(),
});

const extentOfDamageSchema = z.object({
  severity: z.enum(["minor", "moderate", "major", "complete-loss", "unsure"]),
  habitable: z.boolean(),
  estimatedRepairCost: z.number().nonnegative(),
  affectedRooms: z.array(z.string()).min(1),
  waterIntrusion: z.boolean(),
});

const seriousNeedsSchema = z.object({
  food: z.boolean(),
  shelter: z.boolean(),
  medical: z.boolean(),
  infantSupplies: z.boolean(),
  clothing: z.boolean(),
  fuel: z.boolean(),
});

const essentialUtilitiesSchema = z.object({
  electricity: z.string().min(1),
  gas: z.string().min(1),
  water: z.string().min(1),
  sewage: z.string().min(1),
  hvac: z.string().min(1),
});

const homeInsuranceSchema = z.object({
  company: z.string().min(1),
  policyNumber: z.string().min(1),
  claimFiled: z.boolean(),
  settlementAmount: z.number().nonnegative().optional(),
});

const vehicleDamageSchema = z.object({
  make: z.string().min(1),
  model: z.string().min(1),
  year: z.number().int().min(1900).max(2100),
  severity: z.string().min(1),
  drivable: z.boolean(),
  insured: z.boolean(),
});

const disabilityNeedsSchema = z.object({
  accessibleHousing: z.boolean(),
  electricalMedicalEquipment: z.boolean(),
  other: z.string().optional(),
});

export const femaApplicantSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  ssn: z.string().regex(/^\d{9}$/, "must be a 9-digit SSN without dashes"),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD"),
  phone: z.string().min(10),
  alternatePhone: z.string().optional(),
  coApplicant: z.boolean(),
  address: addressSchema,
  mailingAddressSame: z.boolean(),
  mailingAddress: addressSchema.optional(),
  ownershipStatus: z.enum(["own", "rent"]),
  homeType: z.string().min(1),
  canAccessHome: z.boolean(),
  accessBarriers: z.array(z.string()).optional(),
  safetyHazards: z.array(z.string()).optional(),
  occupants: occupantsSchema,
  income: incomeSchema,
  bankAccount: bankAccountSchema,
  notifications: notificationsSchema,
  // Conditional pages — only needed when matching needs flags are set.
  extentOfDamage: extentOfDamageSchema.optional(),
  seriousNeeds: seriousNeedsSchema.optional(),
  essentialUtilities: essentialUtilitiesSchema.optional(),
  homeInsurance: homeInsuranceSchema.optional(),
  funeralExpenses: funeralDetailSchema.optional(),
  vehicleDamage: vehicleDamageSchema.optional(),
  disabilityNeeds: disabilityNeedsSchema.optional(),
  otherNeeds: z.string().optional(),
});

export type FemaApplicant = z.infer<typeof femaApplicantSchema>;

// ---------------------------------------------------------------------------
// Full submission request
// ---------------------------------------------------------------------------

export const femaSubmissionRequestSchema = z.object({
  preApplication: femaPreApplicationSchema,
  needs: femaNeedsSchema,
  identity: femaIdentitySchema,
  applicant: femaApplicantSchema,
  /** Session fixture name for development — appended as ?sessionFixture=<name> */
  sessionFixture: z.string().optional(),
});

export type FemaSubmissionRequest = z.infer<typeof femaSubmissionRequestSchema>;

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export const femaSubmissionResponseSchema = z.object({
  status: vpsStatusSchema,
  submissionId: z.string(),
  confirmationNumber: z.string().optional(),
  pagesCompleted: z.number().int().nonnegative(),
  submittedAt: z.string(),
});

export type FemaSubmissionResponse = z.infer<typeof femaSubmissionResponseSchema>;
