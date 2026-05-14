import { type AnyZodObject, z } from "zod";
import type {
  FemaApplicant,
  FemaIdentity,
  FemaNeeds,
  FemaPreApplication,
  FemaSubmissionRequest,
} from "@/api/schemas/fema-submission";
import { config } from "@/config";
import { getLogger } from "@/lib/logging";
import { SelectorFailureError } from "@/scraper/errors";
import type { BrowserSession } from "@/scraper/session";

const logger = getLogger({ name: "scraper/flows/fema-submission" });

export interface FemaSubmissionResult {
  confirmationNumber: string | undefined;
  pagesCompleted: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function act(session: BrowserSession, instruction: string): Promise<void> {
  await session.limiter.schedule(() => session.stagehand.page.act({ action: instruction }));
}

async function extract<T extends AnyZodObject>(
  session: BrowserSession,
  instruction: string,
  schema: T
): Promise<z.infer<T>> {
  return session.limiter.schedule(() => session.stagehand.page.extract({ instruction, schema }));
}

// ---------------------------------------------------------------------------
// Phase 1: Pre-Application (pages 1–6)
// ---------------------------------------------------------------------------

async function phase1PreApplication(
  session: BrowserSession,
  input: FemaPreApplication,
  sessionFixture: string | undefined
): Promise<void> {
  logger.info("fema phase 1: pre-application");

  const url = sessionFixture
    ? `${config.scraper.femaBaseUrl}?sessionFixture=${encodeURIComponent(sessionFixture)}`
    : config.scraper.femaBaseUrl;

  await session.stagehand.page.goto(url);

  // Page 1: Landing — click through to begin
  await act(session, "click the button to start a new application");

  // Page 2: reCAPTCHA — Steel's solveCaptcha handles this automatically
  // when the session was created with solveCaptcha=true; we just wait for
  // the form to advance past the challenge.
  await act(session, "complete or skip the CAPTCHA challenge and proceed");

  // Page 3: Location
  await act(session, `enter "${input.zipCode}" in the ZIP code field`);
  await act(session, "click the Next or Continue button");

  // Page 4: Disaster Selection
  await act(session, `select the disaster with number "${input.disasterNumber}" from the list`);
  await act(session, "click the Next or Continue button");

  // Page 5: County
  await act(session, `select the county with FIPS code "${input.countyFips}"`);
  await act(session, "click the Next or Continue button");

  // Page 6: Assistance Info — acknowledge and proceed
  await act(session, "acknowledge the assistance information and click Continue");
}

// ---------------------------------------------------------------------------
// Phase 2: Needs Assessment (pages 7–16)
// ---------------------------------------------------------------------------

async function phase2Needs(session: BrowserSession, input: FemaNeeds): Promise<void> {
  logger.info("fema phase 2: needs assessment");

  // Page 7: Needs Selection
  if (input.homeDamage) await act(session, "check the home damage checkbox");
  if (input.vehicleDamage) await act(session, "check the vehicle damage checkbox");
  if (input.funeralExpenses) await act(session, "check the funeral expenses checkbox");
  if (input.medicalExpenses) await act(session, "check the medical expenses checkbox");
  if (input.childcare) await act(session, "check the childcare checkbox");
  if (input.homeSafetyItems) await act(session, "check the home safety items checkbox");
  await act(session, "click the Next or Continue button");

  // Pages 8–12: Conditional detail pages
  if (input.funeralExpenses && input.funeralDetail) {
    const d = input.funeralDetail;
    await act(session, `enter "${d.deceasedName}" in the deceased name field`);
    await act(session, `enter "${d.dateOfDeath}" in the date of death field`);
    await act(session, `enter "${d.relationship}" in the relationship field`);
    await act(session, `enter "${d.estimatedCost}" in the estimated funeral cost field`);
    await act(session, "click the Next or Continue button");
  }

  if (input.medicalExpenses && input.medicalDetail) {
    await act(session, `enter "${input.medicalDetail.details}" in the medical details field`);
    await act(session, "click the Next or Continue button");
  }

  if (input.homeDamage && input.homeDamageDetail) {
    await act(
      session,
      `enter "${input.homeDamageDetail.details}" in the home damage details field`
    );
    await act(session, "click the Next or Continue button");
  }

  if (input.childcare) {
    await act(session, "fill in the childcare details and click Continue");
  }

  if (input.homeSafetyItems) {
    await act(session, "fill in the home safety items details and click Continue");
  }

  // Page 13: Needs Review — confirm and move on
  await act(session, "confirm the needs summary and click Continue");

  // Page 14: Date of Loss
  await act(session, `enter "${input.dateOfLoss}" in the date of loss field`);
  await act(session, "click the Next or Continue button");

  // Page 15: Damage Types
  for (const damageType of input.damageTypes) {
    await act(session, `check the "${damageType}" damage type checkbox`);
  }
  await act(session, "click the Next or Continue button");

  // Page 16: Privacy — acknowledge and declare citizenship
  await act(session, "acknowledge the privacy act statement");
  await act(session, `select citizenship status "${input.citizenshipStatus}"`);
  await act(session, "click the Next or Continue button");
}

// ---------------------------------------------------------------------------
// Phase 3: Login / Identity (pages 17–22)
// ---------------------------------------------------------------------------

async function phase3Identity(session: BrowserSession, input: FemaIdentity): Promise<void> {
  logger.info("fema phase 3: identity");

  // Page 17: Sign In
  await act(session, `enter "${input.email}" in the email address field`);
  await act(session, "click the Next or Sign In button");

  // Page 18: Check Email — the form instructs the user to check their email;
  // the mock site auto-advances after a short delay, so we just wait.
  await act(session, "click Continue or wait for the email confirmation page to advance");

  // Page 19: Auth Setup — set password
  await act(session, `enter "${input.password}" in the password field`);
  await act(session, `enter "${input.password}" in the confirm password field`);
  await act(session, "click the Next or Continue button");

  // Page 20: Verify — choose verification method
  await act(session, `select "${input.verificationMethod}" as the verification method`);
  await act(session, "click the Next or Send Code button");

  // Page 21: Enter Code
  await act(session, `enter "${input.verificationCode}" in the verification code field`);
  await act(session, "click the Next or Verify button");

  // Page 22: Login Success — proceed
  await act(session, "click Continue to enter the application center");
}

// ---------------------------------------------------------------------------
// Phase 4: Application Center (pages 23–40)
// ---------------------------------------------------------------------------

async function phase4ApplicationCenter(
  session: BrowserSession,
  input: FemaApplicant
): Promise<void> {
  logger.info("fema phase 4: application center");

  // Page 23: App Center Intro
  await act(session, "click Continue on the application center introduction page");

  // Page 24: Help Page
  await act(session, "click Continue on the help information page");

  // Page 25: Personal Information
  await act(session, `enter "${input.firstName}" in the first name field`);
  await act(session, `enter "${input.lastName}" in the last name field`);
  await act(session, `enter "${input.ssn}" in the Social Security Number field`);
  await act(session, `enter "${input.dateOfBirth}" in the date of birth field`);
  await act(session, `enter "${input.phone}" in the primary phone number field`);
  if (input.alternatePhone) {
    await act(session, `enter "${input.alternatePhone}" in the alternate phone field`);
  }
  await act(
    session,
    input.coApplicant ? "select yes for co-applicant" : "select no for co-applicant"
  );
  await act(session, "click the Next or Continue button");

  // Page 26: Address
  await act(session, `enter "${input.address.line1}" in the address line 1 field`);
  if (input.address.line2) {
    await act(session, `enter "${input.address.line2}" in the address line 2 field`);
  }
  await act(session, `enter "${input.address.city}" in the city field`);
  await act(session, `select "${input.address.state}" as the state`);
  await act(session, `enter "${input.address.zip}" in the ZIP code field`);
  await act(
    session,
    input.mailingAddressSame
      ? "check that the mailing address is the same as the disaster address"
      : "uncheck the same mailing address option"
  );
  if (!input.mailingAddressSame && input.mailingAddress) {
    const m = input.mailingAddress;
    await act(session, `enter "${m.line1}" in the mailing address line 1 field`);
    if (m.line2) await act(session, `enter "${m.line2}" in the mailing address line 2 field`);
    await act(session, `enter "${m.city}" in the mailing city field`);
    await act(session, `select "${m.state}" as the mailing state`);
    await act(session, `enter "${m.zip}" in the mailing ZIP code field`);
  }
  await act(session, `select "${input.ownershipStatus}" for ownership status`);
  await act(session, `select "${input.homeType}" for home type`);
  await act(session, "click the Next or Continue button");

  // Page 27: Address Verification
  await act(session, "confirm the address is correct and click Continue");

  // Page 28: Home Access
  await act(
    session,
    input.canAccessHome ? "select yes for home access" : "select no for home access"
  );
  if (!input.canAccessHome && input.accessBarriers?.length) {
    for (const barrier of input.accessBarriers) {
      await act(session, `check "${barrier}" as an access barrier`);
    }
  }
  if (input.safetyHazards?.length) {
    for (const hazard of input.safetyHazards) {
      await act(session, `check "${hazard}" as a safety hazard`);
    }
  }
  await act(session, "click the Next or Continue button");

  // Page 29: Occupants
  const o = input.occupants;
  await act(session, `enter "${o.adults}" for number of adults`);
  await act(session, `enter "${o.children}" for number of children`);
  await act(session, `enter "${o.seniors}" for number of seniors`);
  await act(session, `enter "${o.disabledPersons}" for number of people with disabilities`);
  await act(session, "click the Next or Continue button");

  // Page 30: Income Information
  const inc = input.income;
  await act(session, `select "${inc.employmentStatus}" as employment status`);
  if (inc.employer) await act(session, `enter "${inc.employer}" in the employer field`);
  if (inc.occupation) await act(session, `enter "${inc.occupation}" in the occupation field`);
  await act(session, `enter "${inc.annualIncome}" in the annual income field`);
  await act(session, `enter "${inc.disasterImpact}" in the disaster income impact field`);
  await act(session, "click the Next or Continue button");

  // Page 31: Payment Information
  const bank = input.bankAccount;
  await act(session, `enter "${bank.routingNumber}" in the routing number field`);
  await act(session, `enter "${bank.accountNumber}" in the account number field`);
  await act(session, `select "${bank.accountType}" as the account type`);
  await act(session, "click the Next or Continue button");

  // Page 32: Notifications
  const notif = input.notifications;
  await act(session, `select "${notif.method}" as the preferred contact method`);
  if (notif.bestTimeToCall) {
    await act(session, `select "${notif.bestTimeToCall}" as the best time to call`);
  }
  await act(session, `select "${notif.language}" as the language preference`);
  if (notif.accessibilityNeeds) {
    await act(session, `enter "${notif.accessibilityNeeds}" in the accessibility needs field`);
  }
  await act(session, "click the Next or Continue button");

  // Page 33: Extent of Damage (conditional)
  if (input.extentOfDamage) {
    const dmg = input.extentOfDamage;
    await act(session, `select "${dmg.severity}" as the damage severity`);
    await act(
      session,
      dmg.habitable ? "select yes for home habitability" : "select no for home habitability"
    );
    await act(session, `enter "${dmg.estimatedRepairCost}" in the estimated repair cost field`);
    for (const room of dmg.affectedRooms) {
      await act(session, `check "${room}" as an affected room`);
    }
    await act(
      session,
      dmg.waterIntrusion ? "select yes for water intrusion" : "select no for water intrusion"
    );
    await act(session, "click the Next or Continue button");
  }

  // Page 34: Serious Needs (conditional)
  if (input.seriousNeeds) {
    const sn = input.seriousNeeds;
    if (sn.food) await act(session, "check food as an immediate need");
    if (sn.shelter) await act(session, "check shelter as an immediate need");
    if (sn.medical) await act(session, "check medical care as an immediate need");
    if (sn.infantSupplies) await act(session, "check infant supplies as an immediate need");
    if (sn.clothing) await act(session, "check clothing as an immediate need");
    if (sn.fuel) await act(session, "check fuel as an immediate need");
    await act(session, "click the Next or Continue button");
  }

  // Page 35: Essential Utilities (conditional)
  if (input.essentialUtilities) {
    const eu = input.essentialUtilities;
    await act(session, `select "${eu.electricity}" for electricity status`);
    await act(session, `select "${eu.gas}" for gas status`);
    await act(session, `select "${eu.water}" for water status`);
    await act(session, `select "${eu.sewage}" for sewage status`);
    await act(session, `select "${eu.hvac}" for heating and cooling status`);
    await act(session, "click the Next or Continue button");
  }

  // Page 36: Home Insurance (conditional)
  if (input.homeInsurance) {
    const ins = input.homeInsurance;
    await act(session, `enter "${ins.company}" in the insurance company field`);
    await act(session, `enter "${ins.policyNumber}" in the policy number field`);
    await act(
      session,
      ins.claimFiled
        ? "select yes for insurance claim filed"
        : "select no for insurance claim filed"
    );
    if (ins.settlementAmount !== undefined) {
      await act(session, `enter "${ins.settlementAmount}" in the settlement amount field`);
    }
    await act(session, "click the Next or Continue button");
  }

  // Page 37: Funeral Expenses (conditional)
  if (input.funeralExpenses) {
    const fe = input.funeralExpenses;
    await act(session, `enter "${fe.deceasedName}" in the deceased name field`);
    await act(session, `enter "${fe.dateOfDeath}" in the date of death field`);
    await act(session, `enter "${fe.relationship}" in the relationship field`);
    await act(session, `enter "${fe.estimatedCost}" in the estimated funeral cost field`);
    await act(session, "click the Next or Continue button");
  }

  // Page 38: Vehicle Damage (conditional)
  if (input.vehicleDamage) {
    const vd = input.vehicleDamage;
    await act(session, `enter "${vd.make}" in the vehicle make field`);
    await act(session, `enter "${vd.model}" in the vehicle model field`);
    await act(session, `enter "${vd.year}" in the vehicle year field`);
    await act(session, `select "${vd.severity}" as the vehicle damage severity`);
    await act(
      session,
      vd.drivable ? "select yes for vehicle drivable" : "select no for vehicle drivable"
    );
    await act(
      session,
      vd.insured ? "select yes for vehicle insurance" : "select no for vehicle insurance"
    );
    await act(session, "click the Next or Continue button");
  }

  // Page 39: Disability Needs
  if (input.disabilityNeeds) {
    const dn = input.disabilityNeeds;
    await act(
      session,
      dn.accessibleHousing ? "check accessible housing need" : "uncheck accessible housing need"
    );
    await act(
      session,
      dn.electricalMedicalEquipment
        ? "check electrical medical equipment need"
        : "uncheck electrical medical equipment need"
    );
    if (dn.other) await act(session, `enter "${dn.other}" in the other disability needs field`);
    await act(session, "click the Next or Continue button");
  } else {
    await act(session, "select no disability needs and click Continue");
  }

  // Page 40: Other Needs
  if (input.otherNeeds) {
    await act(session, `enter "${input.otherNeeds}" in the other needs field`);
  }
  await act(session, "click the Next or Continue button");
}

// ---------------------------------------------------------------------------
// Phase 5: Review and Submit (pages 41–42)
// ---------------------------------------------------------------------------

async function phase5Submit(session: BrowserSession): Promise<string | undefined> {
  logger.info("fema phase 5: review and submit");

  // Page 41: Review Application
  await act(session, "review the application summary and click Submit");

  // Page 42: Submit — extract confirmation number from success screen
  const resultSchema = z.object({ confirmationNumber: z.string().optional() });

  try {
    const result = await extract(
      session,
      "extract the FEMA application confirmation number from the success page",
      resultSchema
    );
    return result.confirmationNumber;
  } catch {
    // If extraction fails the submission may still have succeeded; log and
    // return undefined so callers treat it as "submitted but no number seen".
    logger.warn("could not extract confirmation number from success page");
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Drives a Stagehand browser session through all 42 pages of the FEMA
 * disaster assistance form. Returns the confirmation number from the success
 * screen and a count of pages completed.
 *
 * Throws `ScraperError` subclasses on failure so `retry.ts` can classify
 * and retry appropriately.
 */
export async function submitFemaApplication(
  session: BrowserSession,
  input: FemaSubmissionRequest
): Promise<FemaSubmissionResult> {
  let pagesCompleted = 0;

  try {
    await phase1PreApplication(session, input.preApplication, input.sessionFixture);
    pagesCompleted = 6;

    await phase2Needs(session, input.needs);
    pagesCompleted = 16;

    await phase3Identity(session, input.identity);
    pagesCompleted = 22;

    await phase4ApplicationCenter(session, input.applicant);
    pagesCompleted = 40;

    const confirmationNumber = await phase5Submit(session);
    pagesCompleted = 42;

    logger.info(`fema submission complete, confirmation=${confirmationNumber ?? "unknown"}`);
    return { confirmationNumber, pagesCompleted };
  } catch (err) {
    logger.warn(`fema submission failed at page ~${pagesCompleted}: ${String(err)}`);
    // Re-throw so pool.ts / retry.ts can classify and decide whether to retry.
    throw err instanceof SelectorFailureError
      ? err
      : new SelectorFailureError(`submission failed at page ~${pagesCompleted}: ${String(err)}`);
  }
}
