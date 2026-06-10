# MN Parkinson's Connect

A free activity finder for people with Parkinson's disease and their caregivers in Minnesota. Search and filter local programs by type, intensity, cost, format, and distance.

Activity data is managed through Airtable and the site is hosted on Cloudflare Pages.

## Airtable Field Reference

The app reads these fields from the `Activities` table:

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
