The actual site the agent automates is DisasterAssistance.gov — the real FEMA disaster assistance application portal.

The af-mock-disaster-assistance-gov repo you originally asked about is a pixel-perfect mock/replica of that site, built specifically to train and test the AI agent safely before it runs against the real thing. The af-fema-real-ai-agent repo is the production agent that runs against the live site.

So the flow is:
 1. Mock site (af-mock-disaster-assistance-gov) — used for development, testing, and agent training at localhost:8020
 2. Real site — DisasterAssistance.gov — where the production agent (in af-fema-real-ai-agent) actually submits FEMA disaster assistance applications on behalf of disaster survivors


How the AI Agent Walks Through the Form

  Before the Agent Touches Anything — Seeding the Session

  Before the agent even looks at a page, it loads the app with a fixture file — a pre-built JSON snapshot of a partially or fully filled-out application. It does this by passing a URL parameter like ?sessionFixture=demo. The app reads that file and injects all those saved values into browser storage, so when any page renders, it already "knows" things like the applicant's name, address, and which types of disaster help they need.

  ---
  Phase 1: Pre-Application (Pages 1–6)

  The agent starts at the landing page and moves forward:

  1. Landing — just clicks through to begin.
  2. reCAPTCHA — completes the bot-check (mocked in this environment).
  3. Location — enters a zip code to establish where the disaster occurred.
  4. Disaster Selection — picks the specific declared disaster from a list.
  5. County — selects the affected county.
  6. Assistance Info — confirms eligibility and acknowledges what types of assistance are available.

  ---
  Phase 2: Needs Assessment (Pages 7–16)

  This is where the agent tells the form what kind of help the applicant needs:

  7. Needs Selection — checks boxes for things like home damage, vehicle damage, funeral expenses, or emergency food/shelter. This single page controls which later pages appear or disappear. The agent picks carefully here.

  8–12. Conditional Detail Pages — depending on what was checked, additional pages pop up:
  - If funeral expenses were checked → a page asking for details about the deceased.
  - If medical expenses → a page for medical details.
  - If home damage → a deeper home damage page.
  - If childcare → a childcare page.
  - If home safety items → a safety items page.

     The agent fills these in or skips them entirely if the conditions aren't met.

  13. Needs Review — a summary of what was selected; agent confirms and moves on.
  14. Date of Loss — enters the date the disaster happened.
  15. Damage Types — checks off specific types of damage (roof, flooding, fire, etc.).
  16. Privacy — acknowledges the privacy act and declares citizenship status.

  ---
  Phase 3: Login / Identity (Pages 17–22)

  The app requires the applicant to create or log into an account:

  17. Sign In — enters an email address.
  18. Check Email — confirms the email was received.
  19. Auth Setup — sets up a password or authentication method.
  20. Verify — chooses how to receive a verification code (text, email, etc.).
  21. Enter Code — types in the verification code.
  22. Login Success — identity is confirmed, application center unlocks.

  ---
  Phase 4: Application Center — The Core Form (Pages 23–40)

  This is the heart of the form. The agent fills out up to 18 pages of detailed information. Ten of these always appear; up to six more appear conditionally based on what was selected in Phase 2.

  Always-present pages:

  23. App Center Intro — welcome/instructions screen, agent clicks through.
  24. Help Page — informational, agent moves on.
  25. Personal Information — fills in first name, last name, Social Security Number, date of birth, email, phone numbers, and whether there's a co-applicant.
  26. Address — enters the disaster-affected address and mailing address. Specifies whether they own or rent, and what type of home it is.
  27. Address Verification — confirms the address is correct.
  28. Home Access — answers whether the applicant can currently access and live in their home. If not, explains why (debris, flooding, evacuation, etc.) and describes safety hazards.
  29. Occupants — states how many people live in the home, including adults, children, seniors, and people with disabilities.
  30. Income Information — enters employment status, employer, occupation, annual income, and explains how the disaster affected their income.
  31. Payment Information — enters bank account details (routing number, account number) for direct deposit of assistance funds.
  32. Notifications — sets preferred contact method (email, text, phone, mail), best time to call, language preference, and any accessibility needs.

  Conditionally-present pages (only shown if the matching need was selected earlier):

  33. Extent of Damage (if home damage was selected) — describes how severe the damage is, whether the home is habitable, estimated repair cost, which rooms were affected, and whether water entered.
  34. Serious Needs (if emergency needs were selected) — answers whether there are immediate needs for food, shelter, medical care, infant supplies, clothing, or fuel.
  35. Essential Utilities (if serious needs were confirmed) — reports status of electricity, gas, water, sewage, and heating/cooling.
  36. Home Insurance (if property damage was selected) — provides insurance company name, policy number, whether a claim was filed, and what the settlement amount was.
  37. Funeral Expenses (if funeral was selected) — enters the deceased person's name, date of death, relationship to applicant, and estimated funeral costs.
  38. Vehicle Damage (if vehicle damage was selected) — fills in vehicle make/model/year, how badly it was damaged, whether it's still drivable, and whether vehicle insurance covers it.
  39. Disability Needs — notes whether the applicant needs accessible housing, electrical medical equipment, or other accommodations.
  40. Other Needs — describes any additional needs not covered elsewhere.

  ---
  Phase 5: Review and Submit (Pages 41–42)

  41. Review Application — the agent (and applicant) sees a complete summary of every answer. The agent can go back to fix anything here.
  42. Submit — clicks the final submit button. The application is sent and a confirmation number appears.
  43. (Debug only) Session Editor — a developer tool that lets testers directly edit any field in the session state; the agent uses this in testing to jump to specific scenarios.

  ---
  How the Agent Navigates So Smoothly

  The key mechanism: as the agent fills in each field, the form auto-saves every second to browser storage. When the agent clicks "Next," the router checks the state to decide whether the next page should be shown or skipped entirely. The agent doesn't need to track this — the router does it automatically, jumping over irrelevant pages and landing on the next meaningful one.

  This means the agent can navigate a 29-page form in as few as 10 clicks if most needs don't apply, or work through all 29+ steps if every assistance type was selected.
