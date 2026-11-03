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
| Activity Type | multipleSelects | Category browse + filter. "Events" is special, see [Events](#events) |
| Location | singleLineText | Venue name |
| Address | multilineText | Full street address |
| Activity Zip Code | multilineText | 5-digit zip or "Virtual" |
| Virtual/In-Person/Hybrid | singleSelect | Format field |
| Schedule | multilineText | Human-readable schedule. For events: the time only ("1:30 to 3:30 PM") |
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
| Start Date | date | First day the listing shows (optional). For events: the event date |
| End Date | date | Last day the listing shows (optional). For events: the last day of a multi-day event |
| Latitude | number | Decimal — auto-filled by Geocode automation |
| Longitude | number | Decimal — auto-filled by Geocode automation |
| Geocoded At | dateTime | Timestamp set by the automation when lat/lng are written |
| Additional Details | multilineText | Free-text notes |
| Description | richText | Long-form description |

## Events

Categories are just Activity Type options, and a category tile appears on the home page as soon as one visible activity carries it. "Events" is the one category the site treats differently: it is for dated, one-time or short-run happenings (a bowling afternoon, a symposium) rather than things that meet every week.

To list an event: tag it **Events** (plus any other type that fits, e.g. Golf), put the date in **Start Date** (and the last day in **End Date** if it runs more than one day), and put only the time in **Schedule**, with AM or PM spelled out ("1:30 to 3:30 PM"). The site then:

- shows the date and time on the card and on the detail page, with the weekday taken from Start Date (so it can never disagree with the text);
- says "Today" on the day and "Happening now" on the later days of a multi-day event;
- sorts an Events-only list soonest first and heads it "Upcoming events";
- hides the event the day after End Date (or after Start Date when End Date is blank). Nothing needs to be taken down by hand.

Leave past events marked Active. The site hides them from every list on its own, and an old link (a flyer, a Facebook post, a search result) then shows "This event took place on ... and is no longer listed" instead of an error. Setting a past event Inactive turns that old link into the generic error page.

Dates are plain `YYYY-MM-DD` values and are compared as such; they are never run through `new Date()`, which would read them as UTC midnight and shift every date a day early for visitors in Minnesota.

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
- **API requests** — the middleware in [`functions/api/_middleware.js`](functions/api/_middleware.js) writes one row per `/api/*` request to the **API Log** table in Airtable: endpoint, search/filter terms, response status, coarse location, and a "Likely bot" flag. It reuses `AIRTABLE_WRITE_PAT`, so no extra setup is needed. A **Traffic Dashboard** interface in the Airtable base (pages Site Traffic, Filters and Locations) charts this table; edits to it sit in a draft until you click Publish in Interface Designer.
- **Per-activity view counts** — when a person opens an activity page, the log row links to that activity, and two columns on the Activities table count those links: **Views (last 30 days)** (a count with a date condition on the log's `Time`) and **Views (last 90 days)** (a plain count of every linked row, so its window is simply the log's retention, `RETENTION_DAYS` — rename it if you change that). Sort Activities by either to see what's popular. Bots and failed requests are excluded from both.

Log rows are deleted automatically after 90 days (the middleware prunes as it goes, oldest first, at most once every 30 seconds per server instance, and keeps at it while a backlog remains — no cron job). To keep more or less history, change `RETENTION_DAYS` at the top of the middleware, and size it against the Airtable base's record cap: log rows share that cap with the Activities, Reports and Submissions tables, and a full base blocks the public report and submit forms. At roughly 110 rows a day, 90 days is about 10,000 rows against the 50,000 of Airtable's Team plan; a full year would be about 40,000, so a modest rise in traffic would fill the base (and the Free plan's 1,000 would hold about nine days). A full base is worse than it sounds: Airtable then rejects every new record, which breaks the forms and also stops this purge, because the purge only runs after a successful write — someone would have to delete rows by hand. Airtable repeats the number in two places — the Activities column **Views (last 90 days)** (its name and its description) and the API Log table description — so change them together, then search the base for the old number to be sure nothing was missed. The Traffic Dashboard's dated sections carry their own 7- and 30-day date filters, so they stay correct as long as retention is at least 30 days; their "All" tab is simply every row the log still holds. After raising it, expect no deletions until the oldest rows age past the new horizon, and expect the longer windows to fill in gradually: after the November 2026 change, the 30-day column and tabs cover a full month from late November and the 90-day column (and the dashboard's "All" tab) a full quarter from late January 2027 — until then they show everything the log has, so the 30- and 90-day figures stay close for a while. Health check: in steady state the oldest row is about 90 days old (sort the API Log table by Time, oldest first); an oldest row that keeps getting older means the purge has stopped (most likely the read token lost access to the table). Logging is designed to always lose gracefully: rows are batched (up to 10 per Airtable call) and paced so they can't compete with the real API for Airtable's per-base rate limit, any rate-limit response pauses logging for a minute, and if Airtable is slow or the token is missing the site is unaffected and rows are simply dropped. No IP addresses and no request bodies are ever logged. The `Visitor` column is an anonymous code — a one-way, daily-rotating, secret-keyed scramble (HMAC) of address + browser, the standard privacy-first analytics technique — from which the address can't be recovered and which cannot by itself link a visitor across days. The other columns (browser string, city, referer, searched zip, search text) are coarse but not nothing, which is one reason rows are kept for only three months. The visitor code rotates at midnight Central time, the same day boundary the `Day` column uses.

**Reading the log accurately:**

- **One row = one API call, not one visit.** A person browsing the finder page typically produces ~2 rows (activities + filter-options); opening an activity page adds one more. For visit/page-view counts, use Cloudflare Web Analytics — this log is for *what* people search, *which* activities they open, errors, and bot traffic.
- **Repeat requests within a minute may be missing** — browsers cache API responses for 60s, so refreshes don't re-hit the server. The log slightly undercounts, never overcounts.
- **The log admits its own gaps.** If rows ever had to be dropped (traffic flood, Airtable rate limit or outage), the next successful write includes a `LOG GAP · about N requests not recorded` row — filter `Method = GAP` to find them. A quiet log with no GAP rows really was a quiet site.
- **Bot columns:** `Verified bot` is Cloudflare's cryptographic identification of known crawlers (Googlebot etc.) and can't be faked; `Likely bot` adds a looser user-agent guess. A scraper pretending to be Chrome can evade `Likely bot`, so treat it as a floor, not an exact count.
- **Group by the `Day` column** to see traffic per day in Central time.
- **`Filters used`** records which finder filters were applied (as `Type: Yoga` / `Day: Monday` chips — one per filter, so charts count each filter separately even when several were combined). New filter values in Airtable become new chips automatically.
- **`Zip searched`** records the 5-digit zip a visitor entered in the location search (the app sends it along for logging; distance math still happens in the browser, and precise coordinates are never sent).
- **Unique visitors** come from counting distinct `Visitor` codes — accurate *within* a day; summing days double-counts return visitors, because the code deliberately rotates daily. Even though the log keeps 90 days of rows, it still cannot give weekly or monthly uniques, and neither can Cloudflare Web Analytics, which counts visits (sessions), not people. Compare weeks by their daily totals instead.
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
- **Security headers** (Content-Security-Policy, frame blocking, etc.) live in [`public/_headers`](public/_headers). The policy allows Cloudflare's Web Analytics beacon (`static.cloudflareinsights.com` for the script, `cloudflareinsights.com` for its report); without those two entries the browser blocks it and Web Analytics records nothing.
- **Fonts are self-hosted** — no third-party requests, nothing shared with Google.

## Local development

```
npm install
npm run build
npx wrangler pages dev dist
```

Create a `.dev.vars` file (git-ignored) with `AIRTABLE_PAT`, `AIRTABLE_BASE_ID`, and `AIRTABLE_TABLE_ID` so the local API functions can reach Airtable. In production these are set as environment variables in the Cloudflare Pages dashboard.
