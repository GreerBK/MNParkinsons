# MN Parkinson's Connect

A free activity finder for people with Parkinson's disease and their caregivers in Minnesota. Search and filter local programs by type, intensity, cost, format, and distance.

Activity data is managed through Airtable and the site is hosted on Cloudflare Pages.

## Configuration

The site talks to Airtable through Cloudflare Pages Functions (in `functions/api/`). All credentials and identifiers are stored as **server-side environment variables** in the Cloudflare Pages dashboard (Settings → Environment variables) and are never committed to this repo or bundled into the browser:

| Variable | What it is |
|---|---|
| `AIRTABLE_PAT` | Airtable personal access token (the secret — keep private) |
| `AIRTABLE_BASE_ID` | The Airtable base identifier |
| `AIRTABLE_TABLE_ID` | The activities table identifier |

To find the base and table IDs, open the table in Airtable and read them from the URL (`airtable.com/<baseId>/<tableId>/...`). See `.env.example` for the variable names to set. Never paste the PAT into client-side code or commit it.

## Airtable Field Reference

The app reads these fields from the `Activities` table in Airtable:

| Field | Type | Notes |
|---|---|---|
| Activity Name | singleLineText | Primary name |
| Activity Type | multipleSelects | Category browse + filter |
| Location | singleLineText | Venue name |
| Address | multilineText | Full street address |
| Activity Zip Code | multilineText | 5-digit zip or "Virtual" |
| Virtual/In-Person/Hybrid | singleSelect | Format field |
| Schedule | multilineText | Human-readable schedule |
| Days of Week | multipleSelects | Monday … Sunday |
| Intensity | multipleSelects | Light / Moderate / High |
| Cost | multilineText | Human-readable cost text |
| Cost Category | singleSelect | Free / Fee / Free Trial |
| Program Contact | singleLineText | Contact person name |
| Program Email Address | email | Email |
| Site Phone # | phoneNumber | Phone number |
| Phone Info | phoneNumber | (legacy duplicate of Site Phone # — consolidate later) |
| Registration Link | url | URL (sometimes contains an email — clean up later) |
| Website | url | Primary website URL |
| online website (clickable link) | url | (legacy display-label field — consolidate later) |
| Caregiver Friendly | singleSelect | Yes / No / Unknown |
| Status | singleSelect | Active / Inactive / Pending |
| Start Date | dateTime | (consider converting to `date`) |
| End Date | dateTime | (consider converting to `date`) |
| Latitude | number | Decimal — auto-filled by Geocode automation |
| Longitude | number | Decimal — auto-filled by Geocode automation |
| Geocoded At | dateTime | Timestamp set by the automation when lat/lng are written |
| Additional Details | multilineText | Free-text notes |
| Description | richText | Long-form description |

## Geocoding

Latitude/Longitude are filled automatically by the Airtable Automation defined in [`airtable-automation/geocode.js`](airtable-automation/geocode.js). Setup instructions are in the comments at the top of that file. The old local Python script is no longer needed.

## "Report incorrect information"

Every activity page has a small "See something incorrect or out of date?" form. Submissions go to `/api/report`, which files them in the **Reports** table (linked to the activity) with `Status = New`. Review workflow: open the Reports table, work through the New rows, fix the linked activity (and bump its **Last Verified** date), then set the report's Status to Fixed.

Setup this feature needs (one time):

1. **`AIRTABLE_WRITE_PAT`** environment variable in Cloudflare Pages (Production *and* Preview): an Airtable personal access token with the `data.records:write` and `data.records:read` scopes, granted access to only this base. The main `AIRTABLE_PAT` stays read-only on purpose.
2. Optional: an Airtable Automation — *When a record is created* in Reports → *Send email* — so new reports land in your inbox.

Spam protection: a hidden honeypot field, strict length limits, and the endpoint verifies the reported activity actually exists and is Active before saving anything.

## "Submit an Activity"

Visitors can suggest a new activity at `#/submit` (linked from the nav and the footer). Submissions go to `/api/submit`, which files them in the **Submissions** table with `Status = New`. Nothing appears on the site until it's approved.

Review workflow, all inside Airtable:

1. Open the **Submissions** table and look at rows with `Status = New`. Edit anything that needs cleanup. If **Suggested Activity Type** is filled and you want to adopt it, first add it as an Activity Type option in *both* Submissions and Activities, then tag the row with it.
2. Set `Status = Approved`. The **"Publish approved submission"** automation copies the row into Activities as an Active activity (the Geocode automation then fills Latitude/Longitude) and flips the submission to `Added`.
3. Or set `Status = Rejected` to decline. **Submitter Name/Email** are only for follow-up questions and are never copied to Activities.

The endpoint reuses the `AIRTABLE_WRITE_PAT` variable set up for reporting (above). Spam protection: a hidden honeypot field, strict length limits and allow-lists, and best-effort per-IP rate limiting at the edge.

## Security & performance

- **No user input ever reaches Airtable formulas.** The API functions fetch Active records with a fixed query and apply search/filters in plain JavaScript, so quotes or symbols in a search can't break or alter the query.
- **Edge caching.** Responses are cached at Cloudflare's edge for ~5 minutes, so even heavy traffic stays far below Airtable's rate limits. New Airtable edits appear on the site within a few minutes.
- **Security headers** (Content-Security-Policy, frame blocking, etc.) live in [`public/_headers`](public/_headers).
- **Fonts are self-hosted** — no third-party requests, nothing shared with Google.

## Local development

```
npm install
npm run build
npx wrangler pages dev dist
```

Create a `.dev.vars` file (git-ignored) with `AIRTABLE_PAT`, `AIRTABLE_BASE_ID`, and `AIRTABLE_TABLE_ID` so the local API functions can reach Airtable. In production these are set as environment variables in the Cloudflare Pages dashboard.
