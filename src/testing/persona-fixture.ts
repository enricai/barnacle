/**
 * Standard test persona used by recon runs + integration tests. Centralised
 * so every plugin uses the same identity (helps cross-site audit-log
 * correlation) and so we change it in one place when a field gets rejected
 * by a new validator (e.g. the 555 → 310 phone-number swap during the
 * AppCast recon investigation).
 *
 * The Email field is intentionally omitted — callers should compose the
 * payload by combining this fixture with a freshly allocated testmail.app
 * address. See `src/testmail/client.ts:allocateTestmailInbox`.
 */
export const TEST_PERSONA = {
  FirstName: "Reginald",
  LastName: "Reconaldo",
  /**
   * 555-0100..555-0199 is the only NANP range reserved for fiction, so this
   * number reaches no real person — unlike a plausible-looking area-code/NXX
   * pair, which is assignable and would send test traffic to a stranger.
   *
   * Avoid famously-fictional numbers like 310-867-5309 ("Jenny" pop-song):
   * some ATS phone widgets reject those with "Please provide correct phone
   * number." If a widget rejects this 555-01XX form too, prefer a number the
   * project controls over reverting to a real one.
   */
  Phone: "+1 208-555-0142",
  Address: {
    Line1: "123 Test Lane",
    City: "Austin",
    /** Two-letter region code for forms that want abbreviations. */
    StateAbbreviation: "TX",
    /** Full state name for forms that want the long form. */
    StateName: "Texas",
    PostalCode: "78701",
    /** Texas county for Austin. Required by tenants (Encompass Health, etc.)
     * that nest a County field inside the Address group. */
    County: "Travis County",
    /** Long-form for `<select>`s that show country names. */
    CountryName: "United States",
    /** Two-letter code for ISO-3166-style inputs. */
    CountryCode: "US",
  },
  /**
   * Throwaway values for forms that require SSN / DOB even for testing.
   * 123-45-6789 is a documented IRS test SSN; 01/01/1990 is a stable adult
   * birthday that won't trip age-bracket validators.
   */
  Ssn: "123-45-6789",
  DateOfBirth: "01/01/1990",
  /** Generic employment row used to fill required Employment History sections. */
  Employment: {
    Title: "Automation Testing Specialist",
    CompanyName: "Self-employed",
    CompanyPhone: "+1 310-867-5311",
    StartDate: "01/01/2020",
    EndDate: "12/31/2025",
    PositionDescription:
      "Designed and executed automated browser testing workflows for healthcare application portals",
  },
  /** Three reference rows used by ATSes that ask for professional references. */
  References: [
    {
      FirstName: "Pat",
      LastName: "Smith",
      Email: "pat.smith.ref@example.com",
      Phone: "+1 310-867-5312",
    },
    {
      FirstName: "Jamie",
      LastName: "Johnson",
      Email: "jamie.johnson.ref@example.com",
      Phone: "+1 310-867-5313",
    },
    {
      FirstName: "Taylor",
      LastName: "Brown",
      Email: "taylor.brown.ref@example.com",
      Phone: "+1 310-867-5314",
    },
  ],
  /** Signature text used in legal-attestation sections. */
  SignatureName: "Reginald Reconaldo",
} as const;

export type TestPersona = typeof TEST_PERSONA;
