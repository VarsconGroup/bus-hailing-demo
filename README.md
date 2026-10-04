# Lekki Bus-Hailing Simulator

A playable simulation of an on-demand minibus pilot in **Lekki Phase 1, Lagos**. Buses cruise
the main corridors. A rider books a seat, the system picks the nearest bus with a free seat
and the closest meetup point on a street the bus can drive, and everyone walks, waits, rides
and pays. You change the variables and watch how the day plays out.

Streets are real: they come from OpenStreetMap, clipped to Phase 1 (lagoon to the north,
Lekki–Epe Expressway to the south, the toll gate curve to Kusenla Road).

## What you can do

- **Change the variables**: fleet size, seats, bookings per hour and the rush-hour profile,
  share of trips to the edges (toll gate, link bridge, expressway junctions), no-shows,
  meetup spacing, max walk, dispatch strategy, traffic, rider patience, detour limits,
  dwell times, fare model (flat / per km / zone), fuel and bus-hour costs, service hours.
- **Book a ride yourself**: click your start, then your destination. You'll see your meetup
  point, your bus, the ETA and the fare, and you can follow the trip.
- **Inspect** any bus (seats, planned stops with ETAs, km driven) or rider (walk, promised
  vs. actual pickup, fare).
- **Edit the network**: allow or ban buses on any street, close a road or add a traffic jam.
  Meetup points and routes update immediately.
- **Compare scenarios**: run whole simulated days across a range (e.g. 2–20 buses) and get
  the served %, waits, riders per bus, profit and break-even fare. It also tells you the
  smallest fleet that hits your target.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit + simulation tests
npm run build      # static site in dist/
npm run smoke      # browser smoke test against dist/ (uses Playwright/Chromium)
```

The GitHub Action in `.github/workflows/pages.yml` tests, builds and deploys to GitHub Pages
from the default branch. Turn it on under **Settings → Pages → Source: GitHub Actions**.

## How it works

| Piece | File |
|---|---|
| Street graph, meetup points, shortest paths | `src/sim/network.ts` |
| Where and when riders appear | `src/sim/demand.ts` |
| Matching riders to buses (portable core) | `src/sim/dispatch.ts`, explained in [`docs/dispatch-rules.md`](docs/dispatch-rules.md) |
| The simulated day: driving, boarding, no-shows, metrics | `src/sim/simulation.ts` |
| Fares, costs, summary metrics | `src/sim/economics.ts` |
| Map, dashboard, settings, scenario sweeps | `src/ui/*`, `src/sweep.worker.ts` |

The simulation is deterministic for a given random seed. Demand uses its own random stream,
so two runs with different fleets see exactly the same bookings. That makes comparisons fair.

## Assumptions (all adjustable, none measured)

There is no demand data yet. Every demand number is a planning assumption.

- **Bookings** arrive randomly (Poisson) at *bookings per hour*. They follow a daily
  profile: a morning peak around 07:45, a smaller evening peak around 17:45 and a midday
  bump. The profile averages to your setting over the service window.
- **Trip mix**: mornings lean home → edge gates or work, evenings lean the other way, and
  some trips stay local all day.
  - Homes are spread along residential streets.
  - Hotspots are clusters of real OSM points of interest: malls, schools, offices, banks
    and restaurants.
- **Speeds** (free flow): expressway 55 km/h, arterials 35, collectors 28, local 20. These are
  scaled by *traffic speed* and, if enabled, slowed by up to 45% at peaks.
- **Walking**: 1.2 m/s, with walking distance taken as 1.3 × the straight line.
- **Costs**: fuel ₦150/km (a Hiace at ~8 km/L and ₦1,200/L) and ₦2,500 per bus-hour for
  driver, lease and maintenance. Change both to your real quotes.

## Refreshing the map data

`data/osm-raw.json` is a raw Overpass extract, and `src/data/lekki-network.json` is built
from it.

```bash
npm run fetch-osm      # needs internet; or run the "Fetch OpenStreetMap data" GitHub Action
npm run build-network  # clips to the pilot zone and classifies streets
```

To change the pilot area, edit the `ZONE` polygon and `GATES` in `scripts/build-network.mjs`.

Map data © OpenStreetMap contributors, available under the ODbL.
