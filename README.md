# MN Parkinson's Connect

A simple activity finder for people with Parkinson's in Minnesota.

## Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in your Airtable credentials:
   ```
   cp .env.example .env
   ```
   - `VITE_AIRTABLE_PAT` — Your Personal Access Token (airtable.com → account → Developer Hub → Personal Access Tokens). Needs `data.records:read` scope.
   - `VITE_AIRTABLE_BASE_ID` — Already set to your base: `appKtPJiD3Pex9ai1`
   - `VITE_AIRTABLE_TABLE_ID` — Already set to your table: `tblfEZNHgfRwvvVJc`

3. Run locally:
   ```
   npm run dev
   ```

## Deploy to Cloudflare Pages (free)

1. Push this folder to a GitHub repo.

2. Go to [Cloudflare Pages](https://pages.cloudflare.com) → Create a project → Connect to GitHub → Select your repo.

3. Set build settings:
   - **Build command:** `npm run build`
   - **Output directory:** `dist`

4. Add environment variables in Cloudflare Pages settings:
   - `VITE_AIRTABLE_PAT` = your token
   - `VITE_AIRTABLE_BASE_ID` = `appKtPJiD3Pex9ai1`
   - `VITE_AIRTABLE_TABLE_ID` = `tblfEZNHgfRwvvVJc`

5. Deploy. Done. Your site is live at `your-project.pages.dev`.

## Airtable Field Mapping

The app expects these exact field names in your Airtable table:

| Field | Notes |
|---|---|
| Activity Name | Primary name |
| Type of Activity | Used for category browse + filter |
| Location | Venue name |
| Address | Full street address |
| Activity Zip Code | 5-digit zip or "Virtual" |
| Virtual/In-Person/Hybrid | Format field |
| Days/Times Meeting | Human-readable schedule |
| Days of Week | Comma-separated days |
| Time of Day | Morning / Afternoon / Evening |
| Level of Intensity | Light / Moderate / High |
| Cost Display | Human-readable cost text |
| Cost Category | Free / Paid / First Session Free |
| Program Contact | Contact person name |
| Program Email Address | Email |
| Site Phone # | Phone number |
| Online Registration Link | URL |
| Online Website | URL |
| Caregiver Friendly | Yes / No / Unknown |
| Status | Active / Inactive / Pending |
| Latitude | Decimal number |
| Longitude | Decimal number |
