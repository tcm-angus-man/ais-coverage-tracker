# Voyage Gap Backfill

Hey team — there's a new tab in the coverage Google Sheet called **voyage_gap**. Here's what it is and what to do with it.

## What it is

For our T1 and T2 ships, we looked at the heatmap and pulled out every stretch of days where the ship has no visible coverage. Each row is a suggested cruise for the team to create so we can fill that gap.

## How we came up with the rows

Pretty simple:

- We find the **last day the ship was visible** on the globe before a gap.
- We find the **next day the ship was visible** after the gap.
- Everything between those two dates is a gap we want to backfill.
- If the gap is long, we break it into **7-day pieces** so it's easier to work through one chunk at a time.
- We use the **last-seen port** as both the start and end port on the row — it's just a starting hint, not the final answer.
- We **skip the COVID period (March 2020 – November 2021)** since most ships didn't sail then.
- We also skip days the ship was out of service.

## The important part — this is different from our usual workflow

Normally we get itineraries from our itinerary provider in advance and create voyages from those. The problem is those itineraries are often wrong against what AIS actually shows — wrong dates, wrong ports, sometimes cruises that never sailed.

This new approach works the other way round. We start from "the AIS shows the ship was missing here" and ask the team to fill it in.

**So please** — when you pick up a row:

1. Check the AIS track for that ship and date range. The ship was somewhere.
2. The port and dates on the row are a *starting hint*, not the answer. **If the AIS shows different ports or dates, go with the AIS.**
3. Create the voyage and **make sure it's set to visible on the globe**. That's the whole point — we want the gap to disappear from the heatmap.
4. Don't leave it un-visible because "the suggested data was off." Correct it and publish it.

The row is the bracket; the cruise inside the bracket comes from AIS.

## Regenerating

The list will be regenerated periodically. As the team fills in voyages, those rows will stop appearing — so the list naturally shrinks as we make progress.

If a row looks wrong (e.g. ship was in shipyard, tier is wrong, ship retired earlier than we have recorded), let me know and we'll fix it at the source rather than editing the sheet directly.
