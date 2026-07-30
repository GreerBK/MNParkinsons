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

## Traffic logging

Two complementary views of site traffic:

- **Page views** — Cloudflare Web Analytics (enabled in the Cloudflare dashboard) tracks visits, top pages, referrers, and countries. Cookieless, so no consent banner is needed.
- **API requests** — the middleware in [`functions/api/_middleware.js`](functions/api/_middleware.js) writes one row per `/api/*` request to the **API Log** table in Airtable: endpoint, search/filter terms, response status, coarse location, and a "Likely bot" flag. It reuses `AIRTABLE_WRITE_PAT`, so no extra setup is needed.

Log rows are deleted automatically after 7 days (the middleware prunes as it goes — no cron job). To keep more or less history, change `RETENTION_DAYS` at the top of the middleware — but note log rows count against the Airtable base's record limit, so keep retention short on the free plan. Logging is designed to always lose gracefully: rows are batched (up to 10 per Airtable call) and paced so they can't compete with the real API for Airtable's per-base rate limit, any rate-limit response pauses logging for a minute, and if Airtable is slow or the token is missing the site is unaffected and rows are simply dropped. No IP addresses and no request bodies are ever logged.

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
