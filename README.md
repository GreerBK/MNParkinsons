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
- **API requests** — the middleware in [`functions/api/_middleware.js`](functions/api/_middleware.js) writes one row per `/api/*` request to the **API Log** table in Airtable: endpoint, search/filter terms, response status, coarse location, and a "Likely bot" flag. It reuses `AIRTABLE_WRITE_PAT`, so no extra setup is needed.
- **Per-activity view counts** — when a person opens an activity page, the log row links to that activity, and the Activities table's **Views (last 7 days)** column counts those links. Sort Activities by that column to see what's popular. Bots and failed requests are excluded; the count is a rolling 7-day window (it moves with the log's retention).

Log rows are deleted automatically after 7 days (the middleware prunes as it goes, oldest first, at most once every 30 seconds per server instance, and keeps at it while a backlog remains — no cron job). To keep more or less history, change `RETENTION_DAYS` at the top of the middleware — but note log rows count against the Airtable base's record limit, so keep retention short on the free plan. Logging is designed to always lose gracefully: rows are batched (up to 10 per Airtable call) and paced so they can't compete with the real API for Airtable's per-base rate limit, any rate-limit response pauses logging for a minute, and if Airtable is slow or the token is missing the site is unaffected and rows are simply dropped. No IP addresses and no request bodies are ever logged. The `Visitor` column is an anonymous code — a one-way, daily-rotating, secret-keyed scramble (HMAC) of address + browser, the standard privacy-first analytics technique — from which the address can't be recovered and a visitor can't be followed across days. The code rotates at midnight Central time, the same day boundary the `Day` column uses.

**Reading the log accurately:**

- **One row = one API call, not one visit.** A person browsing the finder page typically produces ~2 rows (activities + filter-options); opening an activity page adds one more. For visit/page-view counts, use Cloudflare Web Analytics — this log is for *what* people search, *which* activities they open, errors, and bot traffic.
- **Repeat requests within a minute may be missing** — browsers cache API responses for 60s, so refreshes don't re-hit the server. The log slightly undercounts, never overcounts.
- **The log admits its own gaps.** If rows ever had to be dropped (traffic flood, Airtable rate limit or outage), the next successful write includes a `LOG GAP · about N requests not recorded` row — filter `Method = GAP` to find them. A quiet log with no GAP rows really was a quiet site.
- **Bot columns:** `Verified bot` is Cloudflare's cryptographic identification of known crawlers (Googlebot etc.) and can't be faked; `Likely bot` adds a looser user-agent guess. A scraper pretending to be Chrome can evade `Likely bot`, so treat it as a floor, not an exact count.
- **Group by the `Day` column** to see traffic per day in Central time.
- **`Filters used`** records which finder filters were applied (as `Type: Yoga` / `Day: Monday` chips — one per filter, so charts count each filter separately even when several were combined). New filter values in Airtable become new chips automatically.
- **`Zip searched`** records the 5-digit zip a visitor entered in the location search (the app sends it along for logging; distance math still happens in the browser, and precise coordinates are never sent).
- **Unique visitors** come from counting distinct `Visitor` codes — accurate *within* a day; summing days double-counts return visitors, because the code deliberately rotates daily. For 30-day unique visitors, use Cloudflare Web Analytics.
## "Submit an Activity"

Visitors can suggest a new activity at `#/submit` (linked from the nav and the footer). Submissions go to `/api/submit`, which files them in the **Submissions** table with `Status = New`. Nothing appears on the site until it's approved.

Review workflow, all inside Airtable:

1. Open the **Submissions** table and look at rows with `Status = New`. Edit anything that needs cleanup. If **Suggested Activity Type** is filled and you want to adopt it, first add it as an Activity Type option in *both* Submissions and Activities, then tag the row with it.
2. Set `Status = Approved`. The **"Publish approved submission"** automation copies the row into Activities as an Active activity (the Geocode automation then fills Latitude/Longitude) and flips the submission to `Added`.
3. Or set `Status = Rejected` to decline. **Submitter Name/Email** are only for follow-up questions and are never copied to Activities.

The endpoint reuses the `AIRTABLE_WRITE_PAT` variable set up for reporting (above). Spam protection: a hidden honeypot field, strict length limits and allow-lists, and best-effort per-IP rate limiting at the edge (50 submissions an hour per network address: enough for a room of people on one venue Wi-Fi, since an address is not a person).

## Tracked QR codes

Printed QR codes (flyers, posters, table tents) point at `https://mnparkinsons.org/q/<code>` instead of straight at the site. [`functions/q/[code].js`](functions/q/[code].js) sends the visitor on and records the scan behind them, so we can tell which piece of paper brought someone in, and can change where a code leads after it is printed.

**Making a code** (nothing to set up, no deploy):

1. Make up a short code for the place it will be printed, e.g. `udall-flyer`: lowercase letters, numbers and dashes, starting with a letter or a number, 40 characters at most. One code per source you want to tell apart; every copy of the same flyer shares one.
2. Open `https://mnparkinsons.org/q/udall-flyer.png` and save the picture (a ~1000 px PNG). Swap `.png` for `.svg` for a vector that stays sharp at poster size. The picture always points at mnparkinsons.org, whichever address you opened it on.
3. Scan it once yourself before it goes in front of people. That first scan adds the code's row to the **QR Codes** table, so the code is already registered before a whole room points their phones at it. (A code that meets its first scans from a crowd still sends everyone to the site, but some of that first minute's scans can end up only in a `NOT RECORDED` note, see below.) For an event, scan each code again shortly beforehand, from where the event is: it reminds the nearest Cloudflare data centre where the code leads.

Afterwards you can give the row a friendlier `Name`, or set its `Destination`: a page of this site (paste its address, or just the part from `#` on, like `#/submit`) or the full `https://` address of another site (one typed starting with `www.` works too). Blank means the home page; changes take effect within about five minutes, even after printing. A Destination that is plainly not a web address (a bare word, a file name, an email address, another site typed without `https://` or `www.`, such as `zoom.us/j/123`) sends people to the home page rather than to an error page. A misspelled address that still looks like one cannot be caught, so after setting or changing a Destination, wait five minutes and scan the code once to see where it lands. (If it still lands on the old page, scan again: when Airtable is slow to answer, the site uses the destination it remembered, and catches up on the next scan.) You can also add the row by hand first if you want a destination from day one. Never change a row's `Code` once it is printed.

Because any code works, a mistyped or made-up address opened by a person becomes a row too; those are safe to delete. To keep that from getting out of hand, the table gains about 20 new rows a day at most (rows added by hand count towards it). Past that, a new code still redirects but is not registered until the day has passed, so add its row by hand if you need it sooner; its scans are counted from about ten seconds after you add it.

If a brand-new code is first scanned by a crowd at the same moment, two rows (now and then three or four) can appear for it. Within about ten seconds the site settles every scan on one of them; the others normally stay empty, though one can keep the scans a single server instance took in those first seconds. Delete the spares that have no scans, and leave alone any that has. Step 3 avoids this.

**Reading the results:**

- Every scan is a row in the **QR Scans** table: time, the code, approximate city/region and the anonymous `Visitor` code. Rows are kept permanently; nothing prunes them.
- The **QR Codes** table totals them per code: `Scans` (all time), `Scans (last 7 days)` and `Last scan` (the day, in Central time). One person scanning twice counts twice.
- The **Weekly QR scan report** automation emails that table every Monday morning. Recipients are the "To" line of its Send email step.
- **Who is counted:** a browser opening the link, and a click on the link in Word, Excel or PowerPoint. Crawlers, uptime checks, scripts and the link previews that chat apps fetch (WhatsApp, Signal, iMessage, Slack and others) are redirected but not stored. The test is a good guess, not a guarantee: a mail security scanner that opens links in a real browser still counts, so treat the count for a link sent by email as an upper limit. For a printed code it is close to exact.
- **`Visitor`** is the same anonymous daily code the API Log uses, a scramble of network address and browser. It is a hint, not a person: phones with the same browser version on one shared Wi-Fi (an event, a clinic) share a code, and a phone that moves from Wi-Fi to cellular gets a second one. Do not count people with it.
- A scan lands on the site with `?src=<code>` in the address. That address is the `Referer` of the visit's API calls, and the scan's `Visitor` code matches the API Log's `Visitor` column for the same day, so the API Log shows what visits that began with a given code went on to search for and open. The tag stays in the address bar, so a link copied from there carries it too; the site's own Share button removes it.
- A row whose `Scan` reads **`NOT RECORDED · about N scans`** is a note, not a scan, and is linked to no code. A person's scan is either stored or counted in one of these. A note is written once the scans it covers have stopped coming for ten seconds (two minutes after the first of them at the latest, or ten minutes when Airtable itself was failing and nothing has got through since), where possible by the very request that lost the scan, and is dated when those losses began. One server instance writes at most five close together and then one every ten minutes. The causes: the limits below, a new code over the daily limit, or Airtable being slow or down. When the site cannot tell whether a write got through it does not send it twice, so a note can cover scans that were in fact stored; and when the unanswered write was itself a note, the next note says so (`about 12 scans (5 of them may repeat an earlier note)`): do not add those 5 twice. One honest limit: rows and counts wait in a server instance's memory until they are written (a scan row usually two or three seconds, a count at least ten seconds, and either one ten minutes or more during Airtable trouble), and if Cloudflare retires that instance first they are gone. Treat the totals as a close count, not an audit trail.
- The `Link` column also works as a plain tracked link in an email or a social post.

**When Airtable is slow, and limits:**

A scan always reaches the site. Airtable usually answers in a fraction of a second, but its first answer after the base has sat unused for a while takes three to five seconds, and on a quiet day that is most scans. So the site remembers where each code leads (for up to a month, per Cloudflare data centre): a code that has been scanned before waits at most a second for Airtable and then uses what it remembers, and only a code with nothing remembered waits for Airtable itself, five seconds at most, before falling back to the home page. Either way the counting carries on in the background. A missing token or an Airtable outage costs a scan its count at worst, never its redirect. One more case ends on the home page: looking a code up is rationed (8 at once per server instance, then one every three seconds), so when dozens of different codes are first scanned in the same minute, or someone is walking made-up `/q/` addresses, the first scan of a code the nearest data centre has not seen in the last month can land on the home page and be counted only in a `NOT RECORDED` note. Step 3 is the cure here too.

The route is deliberately frugal with the base's shared limits (5 requests a second, a cap on total records). Each server instance makes at most two Airtable calls a second from this route, goes silent for half a minute or so after any rate-limit answer, and rations what it writes: one network address can add 300 scans at once and then one every two minutes; one server instance stores 600 at once and then 600 an hour; new codes are capped at about 20 a day. These are speed bumps, not walls. Cloudflare can serve one busy moment from several server instances, each keeping its own count, and nothing short of a queue in front of Airtable would make them share the limit exactly. Instances in one data centre do take turns registering a new code, and a few busy instances together stay inside the base's limit; a large crowd spread over half a dozen or more can still trip it. When that happens the redirects carry on, counting pauses for about half a minute, and the rows that were waiting are written afterwards or owned up to in a note. A determined flood can also add rows and use up the workspace's monthly allowance of API calls. If that ever happens, a Cloudflare rate-limiting rule on `/q/*` and `/api/*` (dashboard → Security → WAF) is the real fix.

Scan rows are written with `AIRTABLE_WRITE_PAT` (no extra setup in Production; Preview deployments without it redirect but do not count). The site reads and writes these two tables by field name: renaming or deleting `Code`, `Destination` or any QR Scans field breaks tracking. With `Code` or `Destination` gone, codes also fall back to the home page once the site's memory of them runs out, and with QR Scans' `Scan` or `Time` gone there are no `NOT RECORDED` notes either: the table simply goes quiet. `Name` and `Notes` are only filled in on new rows as a convenience; if they are renamed or deleted, new codes still register, just unlabelled. Adding fields is fine.

## Security & performance

- **No user input ever reaches Airtable formulas.** The API functions fetch Active records with a fixed query and apply search/filters in plain JavaScript, so quotes or symbols in a search can't break or alter the query. The one deliberate exception is the QR redirect, which looks a code up by formula only after the code has matched a strict letters-numbers-dashes pattern.
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

`npm test` runs the automated tests for the Functions (the QR redirect, the API log and the Submit limit). They use a pretend Airtable and a controlled clock, so they need no network or credentials and finish in a few seconds.
