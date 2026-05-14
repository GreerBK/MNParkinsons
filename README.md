# MN Parkinson's Connect

A free activity finder for people with Parkinson's disease and their caregivers in Minnesota. Search and filter local programs by type, intensity, cost, format, and distance.

Activity data is managed through Airtable and the site is hosted on Cloudflare Pages.

## Airtable Field Reference

The app reads these fields from the Airtable table:

| Field | Notes |
|---|---|
| Activity Name | Primary name |
| Type of Activity | Category browse + filter |
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
