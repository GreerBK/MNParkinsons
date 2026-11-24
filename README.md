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
| Cost Category | singleSelect | Free / Paid / Fee / Free Trial |
| Program Contact | singleLineText | Contact person name |
| Program Email Address | email | Email |
| Site Phone # | phoneNumber | Phone number |
| Registration Link | url | Registration URL or a bare email address |
| Website | url | Primary website URL |
| Caregiver Friendly | singleSelect | Yes / No / Unknown |
| Status | singleSelect | Active / Inactive |
| Start Date | date | First day the listing shows. Required for Events |
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

## Airtable automations

Use [`airtable-automation/geocode.js`](airtable-automation/geocode.js) in the two geocoding actions:

- **Geocode new activities** runs when an Active activity has an address and its coordinates are empty. Pass the triggering Airtable record ID as `recordId`.
- **Refresh activity coordinates when address changes** watches `Address` and `Status`. Pass `recordId` and the string `yes` as `refresh`. It updates an Active listing after an address edit. If the replacement address has no usable result, the stale map pin is cleared so the finder can use the ZIP fallback.

Use [`airtable-automation/activity-weekdays.js`](airtable-automation/activity-weekdays.js) in the **Auto-fill Days of Week** actions. One runs for new Activities rows and the other watches `Schedule`, `Activity Type`, `Start Date`, and `End Date`. Both take `recordId` and update only that activity. The script expands weekday ranges and derives Events' days from their dates. Keep manual `Days of Week` selections for schedules that the script cannot interpret reliably.

## "Report incorrect information"

Every activity page has a small "See something incorrect or out of date?" form. Submissions go to `/api/report`, which files them in the **Reports** table (linked to the activity) with `Status = New`. Review workflow: open the Reports table, work through the New rows, fix the linked activity (and bump its **Last Verified** date), then set the report's Status to Fixed.

Setup this feature needs (one time):

1. Set **`AIRTABLE_WRITE_PAT`** in the Production environment in Cloudflare Pages. Grant `data.records:write` and `data.records:read` for the production base only. For writable previews, use a separate Airtable test base and test token. The write token also enables logging and retention pruning, so a preview pointed at the production base should omit it.
2. Optional: an Airtable Automation — *When a record is created* in Reports → *Send email* — so new reports land in your inbox.

The report endpoint checks the honeypot, validates lengths, and applies a per-network-address limit before checking the activity or sending a write to Airtable.

## Traffic logging

Two complementary views of site traffic:

- **Page views.** Cloudflare Web Analytics tracks overall visits and top pages.
- **API requests.** [`functions/api/_middleware.js`](functions/api/_middleware.js) logs endpoint templates, response status, timing, selected approved filter labels, and a bot classification. Free-text searches are counted under `Keyword search`. Search text, ZIP codes, visitor IDs, referrers, browser strings, and locations are excluded from new log rows.
- **Per-activity view counts.** Successful human visits to activity pages are linked to the activity. **Views (retained API log)** counts all retained rows. **Views (30 days of retained log)** filters those same rows to the last 30 days and is limited by the underlying log retention.

The middleware targets seven days of retention and prunes older rows in the background, oldest first. Logs use short queue deadlines so a burst favors serving the site. Rows can be dropped during an outage or when an instance is retired. Historical API log rows age out through the same retention process.

**Reading the log accurately:**

- Use Cloudflare Web Analytics for visits and page views. Responses served from browser cache are outside the API Log count.
- Filter `Method` to `GAP` for estimated losses reported by an instance that recovered. Rows lost when an instance exits can leave no gap marker.
- Group by `Day` for Central-time reporting. `Filters used` records approved labels such as `Type: Yoga` and `Day: Monday`.
## "Submit an Activity"

Visitors can suggest a new activity at `#/submit` (linked from the nav and the footer). Submissions go to `/api/submit`, which files them in the **Submissions** table with `Status = New`. Nothing appears on the site until it's approved.

Review workflow, all inside Airtable:

1. Open the **Submissions** table and look at rows with `Status = New`. Edit anything that needs cleanup. If **Suggested Activity Type** is filled and you want to adopt it, first add it as an Activity Type option in *both* Submissions and Activities, then tag the row with it.
2. Set `Status = Approved`. The **"Publish approved submission"** automation copies the row into Activities as an Active activity (the Geocode automation then fills Latitude/Longitude) and flips the submission to `Added`.
3. Or set `Status = Rejected` to decline. **Submitter Name/Email** are only for follow-up questions and are never copied to Activities.

The endpoint reuses the reporting write token. It checks the honeypot, validates fields against the Airtable schema, and limits submissions to 50 an hour per network address. The shared Airtable gateway separately paces concurrent requests. Events require a valid start date.

## Tracked QR codes

Printed QR codes (flyers, posters, table tents) point at `https://mnparkinsons.org/q/<code>` instead of straight at the site. [`functions/q/[code].js`](functions/q/[code].js) sends the visitor on and records the scan behind them, so we can tell which piece of paper brought someone in, and can change where a code leads after it is printed.

**Making a code** (nothing to set up, no deploy):

1. Make up a short code for the place it will be printed, e.g. `udall-flyer`: lowercase letters, numbers and dashes, starting with a letter or a number, 40 characters at most. One code per source you want to tell apart; every copy of the same flyer shares one.
2. Open `https://mnparkinsons.org/q/udall-flyer.png` and save the picture (a ~1000 px PNG). Swap `.png` for `.svg` for a vector that stays sharp at poster size. The picture always points at mnparkinsons.org, whichever address you opened it on.
3. Scan it before sharing it. The first scan registers it in **QR Codes**. Confirm the destination again before the event to refresh the remembered address.

Afterwards you can give the row a friendlier `Name`, or set its `Destination`: a page of this site (paste its address, or just the part from `#` on, like `#/submit`) or the full `https://` address of another site (one typed starting with `www.` works too). Blank means the home page; changes take effect within about five minutes, even after printing. A Destination that is plainly not a web address (a bare word, a file name, an email address, another site typed without `https://` or `www.`, such as `zoom.us/j/123`) sends people to the home page rather than to an error page. A misspelled address that still looks like one cannot be caught, so after setting or changing a Destination, wait five minutes and scan the code once to see where it lands. (If it still lands on the old page, scan again: when Airtable is slow to answer, the site uses the destination it remembered, and catches up on the next scan.) You can also add the row by hand first if you want a destination from day one. Never change a row's `Code` once it is printed.

Because any code works, a mistyped or made-up address opened by a person becomes a row too; those are safe to delete. To keep that from getting out of hand, the table gains about 20 new rows a day at most (rows added by hand count towards it). Past that, a new code still redirects but is not registered until the day has passed, so add its row by hand if you need it sooner.

The Airtable gateway gives one request at a time permission to register a code. If you find duplicates from older releases, leave linked scans in place and use the earliest code row for future destination changes. Registering codes before an event gives you time to verify where they go.

**Reading the results:**

- New **QR Scans** rows store the time, summary, and linked code. The site keeps these minimal records for lifetime totals. Earlier rows may contain location and visitor fields from previous releases.
- The **QR Codes** table totals them per code: `Scans` (all time), `Scans (last 7 days)` and `Last scan` (the day, in Central time). One person scanning twice counts twice.
- The **Weekly QR scan report** automation emails that table every Monday morning. Recipients are the "To" line of its Send email step.
- **Who is counted:** a browser opening the link, and a click on the link in Word, Excel or PowerPoint. Crawlers, uptime checks, scripts and the link previews that chat apps fetch (WhatsApp, Signal, iMessage, Slack and others) are redirected but not stored. The test is a good guess, not a guarantee: a mail security scanner that opens links in a real browser still counts, so treat the count for a link sent by email as an upper limit. For a printed code it is close to exact.
- The destination address may carry `?src=<code>` for campaign identification. API logging does not record it. The site's Share button removes the campaign tag.
- A row whose `Scan` reads **`NOT RECORDED · about N scans`** is a note, not a scan, and is linked to no code. A person's scan is either stored or counted in one of these. A note is written once the scans it covers have stopped coming for a quarter of a minute (two minutes after the first of them at the latest), where possible by the very request that lost the scan, and is dated when those losses began. One server instance writes at most five close together and then one every ten minutes. The causes: the limits below, a new code over the daily limit, or Airtable being slow or down. When the site cannot tell whether a write got through it does not send it twice, so a note can cover scans that were in fact stored; and when the unanswered write was itself a note, the next note says so (`about 12 scans (5 of them may repeat an earlier note)`): do not add those 5 twice. One honest limit: rows and counts wait in a server instance's memory until they are written, usually a second or two and up to a few minutes during Airtable trouble, and if Cloudflare retires that instance first they are gone. Treat the totals as a close count, not an audit trail.
- The `Link` column also works as a plain tracked link in an email or a social post.

**When Airtable is slow, and limits:**

A recently scanned code can use its remembered destination while Airtable is slow. Remembered destinations expire after 30 days. A code without a usable cached destination waits up to five seconds before redirecting to Home. Counting continues in the background when it can.

The configured gateway shares the Airtable request allowance across Cloudflare locations, including finder, form and logging calls. A busy gateway or an Airtable rate limit can delay counting. The QR route also caps scan writes and code creation. Scan totals and loss notes are estimates.

Scan writes require `AIRTABLE_WRITE_PAT`. Keep the `Code` and `Destination` fields on QR Codes and the `Scan`, `Time`, and `QR Code` fields on QR Scans. `Name` and `Notes` on QR Codes are optional.

## Security & performance

- **Airtable queries.** Activity search text and filters are applied in JavaScript. The detail and QR lookup formulas interpolate only record IDs or codes that pass strict validation.
- **Edge caching.** Public activity data uses a short cache. The API returns an explicit set of display fields and excludes Airtable backlinks and internal metrics.
- **Security headers** (Content-Security-Policy, frame blocking, etc.) live in [`public/_headers`](public/_headers). The policy allows Cloudflare's Web Analytics beacon (`static.cloudflareinsights.com` for the script, `cloudflareinsights.com` for its report); without those two entries the browser blocks it and Web Analytics records nothing.
- **Fonts are self-hosted** — no third-party requests, nothing shared with Google.

## Local development

```
npm install
npm run build
npx wrangler pages dev dist
```

Create a `.dev.vars` file (git-ignored) with `AIRTABLE_PAT`, `AIRTABLE_BASE_ID`, and `AIRTABLE_TABLE_ID` so the local API functions can reach Airtable. In production these are set as environment variables in the Cloudflare Pages dashboard.

Use Node.js 22.15 or later for `npm test`. The tests use a simulated Airtable and controlled clock, with no network or credentials required.

## Cloudflare deployment

The production Durable Object shares Airtable pacing, backoff, form limits, and QR destination updates across Cloudflare locations. Pages Functions bind to the class from a separate Worker.

1. Deploy the private Worker from the repository root with `npx wrangler deploy --config airtable-gateway/wrangler.jsonc`. It has no public Worker URL and uses the Airtable credentials already configured in Pages.
2. In the Pages production settings, add a Durable Object binding named `AIRTABLE_GATE`. Choose `AirtableGateway` from the `mnparkinsons-airtable-gateway` Worker. Set `AIRTABLE_GATE_REQUIRED=true` in that same environment and redeploy; the flag makes a missing binding fail closed.
3. Use separate Airtable credentials and a separate base for a writable preview. Local development can use the existing direct Airtable configuration without the gateway.
