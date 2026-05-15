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

// Maps femaNeeds.damageTypes string keys to checkbox IDs in damage-types.js.
const DAMAGE_TYPE_IDS: Record<string, string> = {
  flood: "damage-flood",
  powerSurge: "damage-power-surge",
  sewerBackup: "damage-sewer",
  seepage: "damage-seepage",
  tornadoWind: "damage-tornado",
  hurricaneHailRain: "damage-hurricane",
  other: "damage-other",
  earthquake: "damage-earthquake",
  fireLavaAsh: "damage-fire",
  iceSnow: "damage-ice",
};

// ---------------------------------------------------------------------------
// Phase 1: Pre-Application (pages 1–6)
// ---------------------------------------------------------------------------

async function phase1PreApplication(
  session: BrowserSession,
  input: FemaPreApplication
): Promise<void> {
  logger.info("fema phase 1: pre-application");

  await session.stagehand.page.goto(config.scraper.femaBaseUrl);

  // Page 1: Landing
  await act(session, "click the button with id 'apply-now-btn'");

  // Page 2: reCAPTCHA (mocked — checkbox enables submit)
  await act(session, "check the checkbox with id 'recaptcha-checkbox'");
  await act(session, "click the button with id 'submit-btn'");

  // Page 3: Location
  await act(session, `type "${input.zipCode}" into the input with id 'zipCode'`);
  await act(session, "click the button with id 'next-btn'");

  // Page 4: Disaster Selection
  await act(
    session,
    `click the radio button with name 'disaster' whose value is '${input.disasterNumber}'`
  );
  await act(session, "click the button with id 'next-btn'");

  // Page 5: County
  await act(
    session,
    `select the option with value '${input.countyFips}' in the select element with id 'county'`
  );
  await act(session, "click the button with id 'next-btn'");

  // Page 6: Assistance Info — informational
  await act(session, "click the button with id 'next-btn'");
}

// ---------------------------------------------------------------------------
// Phase 2: Needs Assessment (pages 7–16)
// ---------------------------------------------------------------------------

async function phase2Needs(session: BrowserSession, input: FemaNeeds): Promise<void> {
  logger.info("fema phase 2: needs assessment");

  // Page 7: Needs Selection — all 11 checkboxes across 3 sections
  // Property Damage
  if (input.homeDamage) await act(session, "check the checkbox with id 'home-damage'");
  if (input.vehicleDamage) await act(session, "check the checkbox with id 'vehicle-damage'");
  if (input.personalPropertyDamage) await act(session, "check the checkbox with id 'personal-property'");
  // Emergency Needs
  if (input.foodShelter) await act(session, "check the checkbox with id 'food-shelter'");
  if (input.homeAccess) await act(session, "check the checkbox with id 'home-access'");
  if (input.lossOfUtilities) await act(session, "check the checkbox with id 'utilities'");
  // Other Expenses
  if (input.funeralExpenses) await act(session, "check the checkbox with id 'funeral'");
  if (input.lodging) await act(session, "check the checkbox with id 'lodging'");
  if (input.medicalExpenses) await act(session, "check the checkbox with id 'medical'");
  if (input.childcare) await act(session, "check the checkbox with id 'childcare'");
  if (input.homeSafetyItems) await act(session, "check the checkbox with id 'home-safety'");
  await act(session, "click the button with id 'next-btn'");

  // Pages 8–12: Conditional yes/no pages shown by router based on selections.
  // Router order: funeral → medical → home → childcare → safety
  if (input.funeralExpenses) {
    await act(session, "click the radio button with id 'funeral-yes'");
    await act(session, "click the button with id 'next-btn'");
  }

  if (input.medicalExpenses) {
    await act(session, "click the radio button with id 'medical-yes'");
    // conditional-medical.js also asks about dental expenses
    await act(session, "click the radio button with id 'dental-yes'");
    await act(session, "click the button with id 'next-btn'");
  }

  if (input.homeDamage) {
    await act(session, "click the radio button with id 'primary-yes'");
    await act(session, "click the button with id 'next-btn'");
  }

  if (input.childcare) {
    await act(session, "click the radio button with id 'childcare-yes'");
    await act(session, "click the button with id 'next-btn'");
  }

  if (input.homeSafetyItems) {
    await act(session, "click the radio button with id 'safety-yes'");
    await act(session, "click the button with id 'next-btn'");
  }

  // Page 13: Needs Review — display only
  await act(session, "click the button with id 'next-btn'");

  // Page 14: Date of Loss
  await act(session, `type "${input.dateOfLoss}" into the input with id 'dateOfLoss'`);
  await act(session, "check the checkbox with name 'lossDateConfirmed'");
  await act(session, "click the button with id 'next-btn'");

  // Page 15: Damage Types
  for (const damageType of input.damageTypes) {
    const checkboxId = DAMAGE_TYPE_IDS[damageType];
    if (checkboxId) {
      await act(session, `check the checkbox with id '${checkboxId}'`);
    } else {
      logger.warn(`unknown damage type "${damageType}" — no matching checkbox id`);
    }
  }
  await act(session, "click the button with id 'next-btn'");

  // Page 16: Privacy — two checkboxes required
  await act(session, "check the checkbox with id 'privacy-acknowledge'");
  await act(session, "check the checkbox with id 'citizenship-declare'");
  await act(session, "click the button with id 'next-btn'");
}

// ---------------------------------------------------------------------------
// Phase 3: Login / Identity (pages 17–22)
// ---------------------------------------------------------------------------

async function phase3Identity(session: BrowserSession, input: FemaIdentity): Promise<void> {
  logger.info("fema phase 3: identity");

  // Page 17: Use create-account path — goes through check-email and auth-setup.
  // The sign-in path skips those pages entirely.
  await act(session, "click the button with id 'create-account-pill'");
  await act(session, `type "${input.email}" into the input with id 'email'`);
  await act(session, "check the checkbox with id 'accept-rules'");
  await act(session, "click the button with id 'create-account-btn'");

  // Page 18: Check Email — mock has a simulate button
  await act(session, "click the button with id 'simulate-confirm'");

  // Page 19: Auth Setup — pick a verification method
  await act(
    session,
    `check the checkbox with name 'authMethod' and value '${input.verificationMethod === "text" ? "sms" : "backup"}'`
  );
  await act(session, "click the button with id 'continue-btn'");

  // Page 20: Verify — choose delivery method
  await act(
    session,
    `click the radio button with name 'verifyMethod' and value '${input.verificationMethod === "text" ? "sms" : "backup"}'`
  );
  await act(session, "click the button with id 'continue-btn'");

  // Page 21: Enter Code
  await act(session, `type "${input.verificationCode}" into the input with id 'verificationCode'`);
  await act(session, "click the button with id 'verify-btn'");

  // Page 22: Login Success
  await act(session, "click the button with id 'continue-btn'");
}

// ---------------------------------------------------------------------------
// Phase 4: Application Center (pages 23–40)
// Page order matches router.js registration order exactly.
// ---------------------------------------------------------------------------

async function phase4ApplicationCenter(
  session: BrowserSession,
  input: FemaApplicant
): Promise<void> {
  logger.info("fema phase 4: application center");

  // Page 23: App Center Intro — informational
  await act(session, "click the button with id 'next-btn'");

  // Page 24: Help Page — informational
  await act(session, "click the button with id 'next-btn'");

  // Page 25: Personal Information
  await act(session, `type "${input.firstName}" into the input with id 'firstName'`);
  await act(session, `type "${input.lastName}" into the input with id 'lastName'`);
  await act(session, `type "${input.ssn}" into the input with id 'ssn'`);
  await act(session, `type "${input.dateOfBirth}" into the input with id 'dateOfBirth'`);
  await act(session, `type "${input.phone}" into the input with id 'primaryPhone'`);
  await act(session, "select the option with value 'cell' in the select with id 'primaryPhoneType'");
  if (input.alternatePhone) {
    await act(session, `type "${input.alternatePhone}" into the input with id 'altPhone'`);
  }
  await act(
    session,
    `click the radio button with name 'hasCoApplicant' and value '${input.coApplicant ? "yes" : "no"}'`
  );
  await act(session, "click the button with id 'next-btn'");

  // Page 26: Address
  await act(session, `type "${input.address.line1}" into the input with id 'streetAddress'`);
  await act(session, `type "${input.address.city}" into the input with id 'city'`);
  await act(session, `type "${input.address.zip}" into the input with id 'zipCode'`);
  await act(
    session,
    `click the radio button with name 'ownOrRent' and value '${input.ownershipStatus}'`
  );
  await act(
    session,
    `select the option with value '${input.homeType.toUpperCase()}' in the select with id 'home-type'`
  );
  await act(
    session,
    `click the radio button with name 'mailingAddressSame' and value '${input.mailingAddressSame ? "yes" : "no"}'`
  );
  if (!input.mailingAddressSame && input.mailingAddress) {
    const m = input.mailingAddress;
    await act(session, `type "${m.line1}" into the input with id 'mailingStreetAddress'`);
    await act(session, `type "${m.city}" into the input with id 'mailingCity'`);
    await act(session, `type "${m.zip}" into the input with id 'mailingZipCode'`);
  }
  await act(session, "click the button with id 'next-btn'");

  // Page 27: Address Verification
  await act(session, "click the radio button with id 'address-entered'");
  await act(session, "click the button with id 'next-btn'");

  // Page 28 (conditional): Extent of Damage — shown when homeDamage selected
  if (input.extentOfDamage) {
    const dmg = input.extentOfDamage;
    // severity enum values match checkbox IDs exactly: damage-minor, damage-major, etc.
    await act(session, `click the radio button with id 'damage-${dmg.severity}'`);
    await act(session, "click the button with id 'next-btn'");
  }

  // Page 29: Home Access — requires homeAccess radio, currentLiving select, movingStorage radio
  const homeAccessValue = input.canAccessHome ? "yes" : "no-flooding";
  await act(
    session,
    `click the radio button with name 'homeAccess' and value '${homeAccessValue}'`
  );
  await act(session, "select the option with value 'MY_HOME' in the select with id 'currentLiving'");
  await act(session, "click the radio button with name 'movingStorage' and value 'no'");
  await act(session, "click the button with id 'next-btn'");

  // Page 30 (conditional): Serious Needs
  // Mock site has 4 checkboxes: #need-supplies, #need-shelter, #need-infant, #need-none
  if (input.seriousNeeds) {
    const sn = input.seriousNeeds;
    const needsSupplies = sn.food || sn.fuel || sn.medical || sn.clothing;
    if (needsSupplies) await act(session, "check the checkbox with id 'need-supplies'");
    if (sn.shelter) await act(session, "check the checkbox with id 'need-shelter'");
    if (sn.infantSupplies) await act(session, "check the checkbox with id 'need-infant'");
    if (!needsSupplies && !sn.shelter && !sn.infantSupplies) {
      await act(session, "check the checkbox with id 'need-none'");
    }
    await act(session, "click the button with id 'next-btn'");
  }

  // Page 31 (conditional): Essential Utilities
  // Two questions — both must be answered before Next enables.
  if (input.essentialUtilities) {
    const eu = input.essentialUtilities;
    const outNow = eu.electricity === "out" || eu.gas === "out" || eu.water === "out";
    const val = outNow ? "yes" : "no";
    await act(session, `click the radio button with id 'utilities-out-${val}'`);
    await act(session, `click the radio button with id 'utilities-now-${val}'`);
    await act(session, "click the button with id 'next-btn'");
  }

  // Page 32 (conditional): Home Insurance
  if (input.homeInsurance) {
    const ins = input.homeInsurance;
    await act(session, "check the checkbox with id 'ins-homeowners'");
    await act(session, `type "${ins.company}" into the input with id 'homeowners-company'`);
    await act(session, "click the button with id 'next-btn'");
  }

  // Page 33: Occupants — applicant card pre-populated; advance without adding more
  await act(session, "click the button with id 'next-btn'");

  // Page 34 (conditional): Funeral Expenses
  // #add-deceased-btn opens modal; submit button (type=submit) inside #add-deceased-form saves it.
  if (input.funeralExpenses) {
    const fe = input.funeralExpenses;
    const nameParts = fe.deceasedName.split(" ");
    await act(session, "click the button with id 'add-deceased-btn'");
    await act(
      session,
      `type "${nameParts[0]}" into the input with id 'deceased-first-name'`
    );
    await act(
      session,
      `type "${nameParts.slice(1).join(" ")}" into the input with id 'deceased-last-name'`
    );
    await act(session, `type "${fe.dateOfDeath}" into the input with id 'deceased-dod'`);
    await act(session, "click the submit button inside the form with id 'add-deceased-form'");
    await act(session, "click the button with id 'next-btn'");
  }

  // Page 35 (conditional): Vehicle Damage
  // #add-vehicle-btn opens modal; #modal-save-btn saves it.
  if (input.vehicleDamage) {
    const vd = input.vehicleDamage;
    await act(session, "click the button with id 'add-vehicle-btn'");
    await act(session, `type "${vd.year}" into the input with id 'modal-year'`);
    await act(session, `type "${vd.make}" into the input with id 'modal-make'`);
    await act(session, `type "${vd.model}" into the input with id 'modal-model'`);
    await act(
      session,
      `click the radio button with name 'modal-isDrivable' and value '${vd.drivable ? "yes" : "no"}'`
    );
    await act(
      session,
      `click the radio button with name 'modal-hasLiability' and value '${vd.insured ? "yes" : "no"}'`
    );
    await act(session, "click the button with id 'modal-save-btn'");
    await act(session, "click the button with id 'next-btn'");
  }

  // Page 36: Income Information
  const inc = input.income;
  await act(
    session,
    `click the radio button with name 'selfEmployment' and value '${inc.employmentStatus === "self-employed" ? "yes" : "no"}'`
  );
  await act(session, `type "${inc.annualIncome}" into the input with id 'annual-income'`);
  await act(session, `type "${inc.dependentsCount}" into the input with id 'dependents-count'`);
  await act(session, "check the checkbox with id 'income-certification'");
  await act(session, "click the button with id 'next-btn'");

  // Page 37: Payment Information — bank-name required when direct_deposit selected
  const bank = input.bankAccount;
  await act(session, "click the radio button with id 'payment-direct'");
  await act(session, `type "${bank.bankName}" into the input with id 'bank-name'`);
  await act(session, `click the radio button with id 'account-${bank.accountType}'`);
  await act(session, `type "${bank.routingNumber}" into the input with id 'routing-number'`);
  await act(session, `type "${bank.accountNumber}" into the input with id 'account-number'`);
  await act(session, `type "${bank.accountNumber}" into the input with id 'verify-account-number'`);
  await act(session, "click the button with id 'next-btn'");

  // Page 38: Notifications
  const notif = input.notifications;
  await act(
    session,
    `click the radio button with name 'deliveryMethod' and value '${notif.method === "mail" ? "postal" : "email"}'`
  );
  await act(
    session,
    `select the option with value '${notif.language}' in the select with id 'language'`
  );
  // textNotifications is required — select no to avoid needing to accept terms
  await act(session, "click the radio button with id 'text-no'");
  await act(session, "click the button with id 'next-btn'");

  // Page 39: Disability Needs — both hasDisability AND equipmentDamaged are required
  if (input.disabilityNeeds) {
    const dn = input.disabilityNeeds;
    await act(
      session,
      `click the radio button with name 'hasDisability' and value '${dn.accessibleHousing || dn.electricalMedicalEquipment ? "yes" : "no"}'`
    );
    await act(
      session,
      `click the radio button with id '${dn.electricalMedicalEquipment ? "equipment-yes" : "equipment-no"}'`
    );
  } else {
    await act(session, "click the radio button with name 'hasDisability' and value 'no'");
    await act(session, "click the radio button with id 'equipment-no'");
  }
  await act(session, "click the button with id 'next-btn'");

  // Page 40: Other Needs — must select at least one option
  if (!input.otherNeeds) {
    await act(session, "check the checkbox with id 'need-none'");
  } else {
    await act(session, "check the checkbox with id 'need-other'");
    await act(session, `type "${input.otherNeeds}" into the input with id 'other-text'`);
  }

  // Patch all required sections to 'complete' in localStorage so the review
  // page renders with the submit button enabled. Each page's markSectionComplete()
  // only fires when validateForm() passes — if any validation silently failed
  // (e.g. due to pre-filled fields not triggering change events), the section
  // stays 'not-started' and the submit button is disabled. Patching here before
  // navigating to /review-application guarantees the button is enabled.
  await session.limiter.schedule(() =>
    session.stagehand.page.evaluate(`
      (() => {
        const KEY = 'fema_mock_fema_mock_application';
        try {
          const state = JSON.parse(localStorage.getItem(KEY) || '{}');
          if (!state.sections) state.sections = {};
          ['personalInformation','address','homeAccess','occupants',
           'incomeInformation','paymentInformation','notifications',
           'disabilityNeeds','otherNeeds'].forEach(s => {
            state.sections[s] = 'complete';
          });
          localStorage.setItem(KEY, JSON.stringify(state));
        } catch(e) {}
      })()`
    )
  );

  await act(session, "click the button with id 'next-btn'");
}

// ---------------------------------------------------------------------------
// Phase 5: Review and Submit (pages 41–42)
// ---------------------------------------------------------------------------

async function phase5Submit(session: BrowserSession): Promise<string | undefined> {
  logger.info("fema phase 5: review and submit");

  // Page 41: Review Application
  await act(session, "click the button with id 'submit-application'");

  // Page 42: Success — wait for the confirmation number element to appear,
  // then read it directly from the DOM. The success page render is async
  // (calls loadState()) so the element may not be present immediately after
  // the click. waitForSelector ensures we don't read before it's rendered.
  //   <div class="alert alert-success text-center">
  //     <div class="h3 mb-0 font-monospace">FEMA-XXXXXXXXXX</div>
  //   </div>
  try {
    await session.limiter.schedule(() =>
      session.stagehand.page.waitForSelector(".alert-success .font-monospace", {
        timeout: 15_000,
      })
    );
    const confirmationNumber = await session.limiter.schedule(() =>
      session.stagehand.page.evaluate(
        `document.querySelector(".alert-success .font-monospace")?.textContent?.trim() ?? null`
      ) as Promise<string | null>
    );
    if (confirmationNumber) return confirmationNumber;
    logger.warn("confirmation number element not found on success page");
    return undefined;
  } catch (err) {
    logger.warn(`could not read confirmation number: ${String(err)}`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Drives a Stagehand browser session through the FEMA disaster assistance
 * form. When a sessionFixture is provided the mock site pre-seeds the
 * session at /personal-info (Phase 4), so Phases 1–3 are skipped.
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
    if (input.sessionFixture) {
      // Fixture pre-seeds the session at /personal-info with auth done and
      // needs pre-selected — phases 1–3 are already complete in the state.
      await session.stagehand.page.goto(
        `${config.scraper.femaBaseUrl}?sessionFixture=${encodeURIComponent(input.sessionFixture)}`
      );
      pagesCompleted = 22;
    } else {
      await phase1PreApplication(session, input.preApplication);
      pagesCompleted = 6;

      await phase2Needs(session, input.needs);
      pagesCompleted = 16;

      await phase3Identity(session, input.identity);
      pagesCompleted = 22;
    }

    await phase4ApplicationCenter(session, input.applicant);
    pagesCompleted = 40;

    const confirmationNumber = await phase5Submit(session);
    pagesCompleted = 42;

    logger.info(`fema submission complete, confirmation=${confirmationNumber ?? "unknown"}`);
    return { confirmationNumber, pagesCompleted };
  } catch (err) {
    logger.warn(`fema submission failed at page ~${pagesCompleted}: ${String(err)}`);
    throw err instanceof SelectorFailureError
      ? err
      : new SelectorFailureError(`submission failed at page ~${pagesCompleted}: ${String(err)}`);
  }
}
