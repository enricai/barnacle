# FEMA DisasterAssistance.gov — Complete Agent Form Flow

A human-readable walkthrough of every step the AI agent takes when filling out a FEMA disaster assistance application on DisasterAssistance.gov, written as if you were watching someone do it in a browser.

Sample user: **Julia Watkins** — WA flood, home damage only, no co-applicant, no insurance, no income, online/mobile payment.

---

## Agent 0 — Getting In (Pages 1–2)

### Page 1: Landing / Home Page

The browser opens on the DisasterAssistance.gov homepage in full-screen.

- Click the **"Apply Now"** button.

---

### Page 2: reCAPTCHA Verification

A reCAPTCHA challenge appears before the application can continue.

- Click the **"I'm not a robot"** checkbox. Wait 2–3 seconds.
- Take a screenshot to see what happened:
  - If a **green checkmark** appears and no image puzzle popped up → skip straight to clicking Submit.
  - If an **image challenge popup** appeared → continue below.
- Read the challenge prompt (e.g., "Select all images with traffic lights").
- Click every image in the grid that matches the prompt. Wait 1–2 seconds after each click — new replacement images may load in.
- If a replacement image also matches, click it too. Repeat until no more matching images remain.
- If unsure about a challenge, click **"Skip"** rather than guessing.
- Once all matches are selected, click **"Verify"**. Wait 2–3 seconds.
  - If a new round of images appears, repeat the process (up to 3 rounds may occur).
  - If the popup disappears and the checkbox shows a green checkmark, the captcha is solved.
- Confirm the green checkmark is showing.
- Click **"Submit"**.

The browser lands on the **Location of Loss** page. Agent 0 is done.

---

## Agent 1 — Pre-Login Application Pages (Pages 3–16)

### Page 3: Location of Loss

- Type the ZIP code into the zip code field: **98112**
- Click **"Next"**.

---

### Page 4: Disaster Selection

- Find the radio button for **DR-4906-WA** and select it.
- Triple-check that only DR-4906-WA is selected.
- Click **"Next"**.

---

### Page 5: County / Select Your Area

- If a "Did your damage happen in one of the places below?" question appears, select **"None of the above"**.
- Select county from the dropdown: **KING**
- Click **"Next"**.

---

### Page 6: Assistance Information

An informational page about FEMA assistance types — no fields to fill.

- Scroll to the bottom.
- Click **"Next"**.

---

### Page 7: Disaster-Related Needs

Check only what applies. For this user:

- ☑ **Home damage** (under Property Damage)
- Leave all other checkboxes unchecked.

- Click **"Next"**.

---

### Page 8: Conditional — Funeral Expenses

*Shown only if "Funeral expenses" was checked on Page 7. For this user it still appears but is answered No.*

- **"Do you have funeral or reburial expenses related to this disaster?"** → Select: **No**
- Triple-check the radio button before clicking Next.
- Click **"Next"**.

---

### Page 9: Conditional — Medical/Dental Expenses

*Shown only if "Medical or dental expenses" was checked on Page 7. Both questions must be answered before Next enables.*

- **"Do you have medical expenses related to this disaster?"** → Select: **No**
- **"Do you have dental expenses related to this disaster?"** → Select: **No**
- Triple-check both radio buttons before clicking Next.
- Click **"Next"**.

---

### Page 10: Conditional — Primary Home Details

*Shown because "Home damage" was checked on Page 7.*

- **"Please select one of the following"** → Select: **This is my primary home. I live here more than 6 months of the year.**
- **"Do you also have damage to your personal property, like appliances and furniture?"** → Select: **No**
- Click **"Next"**.

---

### Page 11: Conditional — Childcare Expenses

*Shown only if "Childcare costs" was checked on Page 7.*

- **"Do you have childcare expenses related to this disaster?"** → Select: **No**
- Click **"Next"**.

---

### Page 12: Conditional — Home Safety Items

*Shown only if "Home safety costs" was checked on Page 7.*

- **"Do you need home safety items?"** → Select: **No**
- Click **"Next"**.

---

### Page 13: Review Needs

A summary of all the needs you selected. No fields to fill.

- Click **"Next"**.

---

### Page 14: Date of Loss

- Enter the date of loss manually — type **12/10/2025** (month: 12, day: 10, year: 2025). Do not use the date picker; click elsewhere on the page to dismiss it if it appears.
- Check the **"Confirm this date"** checkbox.
- Click **"Next"**.

---

### Page 15: Damage Types

Check only what applies. For this user:

- ☑ **Flood**
- Leave all other checkboxes unchecked.

- Click **"Next"**.

---

### Page 16: Privacy Act Statement / Create an Online Account

- Check: **"I agree that I have read and accept the Privacy Act Statement."**
- Check: **"I declare that I or someone in my household is a citizen, non-citizen national, or qualified alien of the United States."**
- Click **"Sign In or Create an Account"**.

> Agent 1 stops here. Pages 17–19 (Login.gov) are handled manually / by a separate auth sub-agent.

---

### Pages 17–19: Login.gov Sign-In (Auth Sub-Agent)

#### Page 17: Sign In

- Enter email: **test@test.com**
- Enter password: **1234567890987**
- Check the **"Show password"** checkbox (to confirm it entered correctly).
- Click **"Submit"**.

#### Page 18: Two-Factor Authentication

- Select the **Text message (SMS)** radio button.
- Triple-check the selection before continuing.
- Click **"Continue"**.

#### Page 19: Enter Security Code

- Enter the one-time code: **456789**
- Click **"Submit"**.

The browser returns to DisasterAssistance.gov, now logged in. Agent 1 is fully done.

---

## Agent 2 — The FEMA Application Center (Pages 20–37)

### Page 20: Welcome to the FEMA Application Center

An informational welcome screen explaining the process. No fields to fill.

- Wait **5 seconds** after the page loads before doing anything.
- Scroll to the bottom.
- Click **"Start Application"**.

---

### Page 21: Application Center Intro

An informational page listing what you'll need (SSN, annual household income, contact info, insurance info, bank account info). No fields to fill.

- Click **"Next"**.

---

### Page 22: Application Help

An informational page explaining how to navigate (asterisks = required fields, progress bar, Next/Skip/Back buttons, left menu). No fields to fill.

- Click **"Next"**.

---

### Page 23: Personal Information *(Progress: 5%)*

- **First Name**: Julia
- **MI**: *(leave blank)*
- **Last Name**: Watkins
- **Social Security Number**: 600-32-4567
- **Date of Birth**: 05/12/1980 — type manually; if the date picker appears, click elsewhere to dismiss it first
- **Email Address**: j.walkings@gmail.com *(pre-filled from login, read-only)*
- **Primary Phone Number**: 602-333-0987
- **Phone Type**: Cell *(select from dropdown — may need to click dropdown then type "C" or arrow down)*
- **Note**: *(leave blank)*
- **Alternate Phone Number**: *(leave blank)*
- **Co-applicant?**: No

- Click **"Next"**.

---

### Page 24: Address Information *(Progress: 10%)*

- **ZIP**: 98112
- **ZIP+4**: *(leave blank)*
- **Street Address**: 1529 Grandview Place E
- **City**: Seattle
- **State**: WASHINGTON *(pre-populated, may be disabled)*
- **County**: KING *(pre-populated, may be disabled)*
- **Own or rent?**: Own
- **Home type**: HOUSE - SINGLE, DUPLEX *(select from dropdown)*
- **Is mailing address the same as home address?**: Yes

- Click **"Next"**.

> An address verification page may appear. If it does, the suggested address is pre-selected by default — just click **"Next"** to accept it.

---

### Page 25: Extent of Damage *(Progress: 30%)*

*Shown because home damage was selected.*

The page shows 5 damage level cards in a row. Click the card or radio button for:

- **Minor Damage**

- Click **"Next"**.

---

### Page 26: Home Access *(Progress: 40%)*

- **Are you safely able to get to your home or leave if you need to?**: Yes, I am able to both get to and leave my home.
- **Where do you currently live or stay?**: MY HOME *(dropdown)*
- **Do you get assistance with short-term lodging expenses from any other source?**: No
- **Do you need help with moving and storage expenses after the disaster?**: No

- Click **"Next"**.

---

### Page 27: Serious Needs

*Shown because emergency needs were selected. For this user, none apply.*

- **Do you need water, food, first aid, or gas?**: No / not checked
- **Do you need emergency shelter?**: No / not checked
- **Do you need infant or hygiene items?**: No / not checked
- Select: **No serious needs** (or "I have no serious needs at this time")

- Click **"Next"**.

---

### Page 28: Essential Utilities

*Shown as part of emergency needs flow.*

- **Have utilities been out for 3 or more days?**: No
- **Are utilities out right now?**: No

- Click **"Next"**.

---

### Page 29: Home Insurance *(Progress: 55%)*

*Shown because home damage was selected.*

- Check: **I don't have home or personal property insurance.**
- Leave all other checkboxes unchecked.

- Click **"Next"**.

---

### Page 30: Occupants *(Progress: 60%)*

The page shows a pre-populated card for the applicant. For this user:

- 1 card: **JULIA WATKINS** (Applicant) — masked SSN, age 45
- No additional household members to add.

- Click **"Next"**.

---

### Page 31: Funeral Expenses *(conditional)*

*Shown only if funeral expenses were selected on Page 7. Skipped for this user.*

---

### Page 32: Vehicle Damage *(conditional)*

*Shown only if vehicle damage was selected on Page 7. Skipped for this user.*

---

### Page 33: Income Information *(Progress: 70%)*

- **Annual gross income**: Check **"No income available."**
- **Is your household's main source of income from self-employment?**: No
- **How many dependents do you have, including yourself?**: 1
- Check the certification box: **"I certify this is my total annual income and understand that failure to disclose my total income could result in fines or imprisonment."**

- Click **"Next"**.

---

### Page 34: Payment Information *(Progress: 75%)*

- **How would you like to get your payment?**: Online or Mobile Payment

- Click **"Next"**.

---

### Page 35: Notifications *(Progress: 80%)*

- **Language**: ENGLISH *(default)*
- **Delivery Method**: Postal mail
- **Would you also like to get text notifications?**: Yes
- Check: **"I accept the text service terms."**

*(When Yes is selected, a phone number dropdown and terms box appear — both pre-populated from Personal Information.)*

- Click **"Next"**.

---

### Page 36: Disability Needs *(Progress: 85%)*

- **Do you or anyone in your household have a disability?**: No
- **Did the disaster damage, disrupt, or cause you loss of any assistive devices or medically required equipment?**: No

- Click **"Next"**.

---

### Page 37: Additional Needs *(Progress: 90%)*

- Check: **I don't have any other needs.**
- Leave all other checkboxes unchecked.

- Click **"Next"**.

---

### Page 38: Review Your Application *(Progress: 95%)*

A full summary of every section is displayed. No fields to fill.

- Scroll all the way to the bottom.
- Click **"Submit Application"**.

---

### Page 39: Confirmation *(Progress: 100%)*

The application has been submitted successfully.

- Green checkmark and message: *"Thank you, Julia Watkins. Your disaster assistance application has been received."*
- A **FEMA confirmation number** is shown in the format `FEMA-xxxxxxxxxx`.
- A "What's Next" section explains the 10-day review period.
- A complete application summary, Print This Page button, and Return to Home button are shown.

The agent takes no further actions. The browser is left open on this page.

**The full application flow is complete.**

---

## Quick Reference: All Pages in Order

| # | Page | Conditional? | Agent |
|---|------|-------------|-------|
| 1 | Landing / Apply Now | No | 0 |
| 2 | reCAPTCHA Verification | No | 0 |
| 3 | Location of Loss | No | 1 |
| 4 | Disaster Selection | No | 1 |
| 5 | County / Select Your Area | No | 1 |
| 6 | Assistance Information *(info only)* | No | 1 |
| 7 | Disaster-Related Needs | No | 1 |
| 8 | Conditional — Funeral Expenses | If funeral selected | 1 |
| 9 | Conditional — Medical/Dental | If medical selected | 1 |
| 10 | Conditional — Primary Home | If home damage selected | 1 |
| 11 | Conditional — Childcare | If childcare selected | 1 |
| 12 | Conditional — Home Safety | If home safety selected | 1 |
| 13 | Review Needs *(info only)* | No | 1 |
| 14 | Date of Loss | No | 1 |
| 15 | Damage Types | No | 1 |
| 16 | Privacy Act Statement | No | 1 |
| 17 | Login.gov — Sign In | No | Auth sub-agent |
| 18 | Login.gov — Two-Factor Auth | No | Auth sub-agent |
| 19 | Login.gov — Enter Security Code | No | Auth sub-agent |
| 20 | Welcome to FEMA App Center *(info only)* | No | 2 |
| 21 | Application Center Intro *(info only)* | No | 2 |
| 22 | Application Help *(info only)* | No | 2 |
| 23 | Personal Information (5%) | No | 2 |
| 24 | Address Information (10%) | No | 2 |
| 24a | Address Verification *(auto-accepted)* | May appear | 2 |
| 25 | Extent of Damage (30%) | If home damage selected | 2 |
| 26 | Home Access (40%) | No | 2 |
| 27 | Serious Needs | No | 2 |
| 28 | Essential Utilities | No | 2 |
| 29 | Home Insurance (55%) | If home damage selected | 2 |
| 30 | Occupants (60%) | No | 2 |
| 31 | Funeral Expenses | If funeral selected | 2 |
| 32 | Vehicle Damage | If vehicle damage selected | 2 |
| 33 | Income Information (70%) | No | 2 |
| 34 | Payment Information (75%) | No | 2 |
| 35 | Notifications (80%) | No | 2 |
| 36 | Disability Needs (85%) | No | 2 |
| 37 | Additional Needs (90%) | No | 2 |
| 38 | Review Your Application (95%) | No | 2 |
| 39 | Confirmation / Success (100%) | No | 2 |
