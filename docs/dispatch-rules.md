# Dispatch rules

This is the matching logic the simulator uses, written so it can be rebuilt in any backend
language. The reference implementation is [`src/sim/dispatch.ts`](../src/sim/dispatch.ts). It is
pure: no simulation state, no I/O, about 250 lines.

## Terms

| Term | Meaning |
|---|---|
| **Bus street** | A street buses may drive on. The default is the main corridors (OSM primary, secondary and tertiary roads, plus the expressway). |
| **Meetup point** | A place on a bus street where a bus can pull over. Points are placed greedily: edge gates first, then junctions, then along the corridors, never closer than *spacing* metres apart. There are none on the expressway. |
| **Stop list** | A bus's ordered plan of pickups and drop-offs. |
| **Ready time** | When the rider can be at the meetup point: match time + walk ÷ walking speed. |
| **Latest pickup** | Booking time + rider patience (*max wait*). Once a pickup is promised, it may slip by at most 3 minutes past the promise. |
| **Max ride** | `maxDetour × direct bus time + 2 min`. This is the ride-time limit for every rider sharing the bus. |

## 1. Choose meetup points

1. Find meetup points within *max walk* of the rider's start. Walking distance is
   1.3 × the straight-line distance.
2. If there are none, reject the booking with "no meetup point within X m". This is
   counted as *too far to walk*.
3. The drop-off is the meetup point nearest the destination.
4. If pickup and drop-off are the same point, the trip is too short, so reject it and suggest walking.
5. Strategy:
   - **Closest** (default): use only the nearest pickup point.
   - **Fastest**: try the 5 nearest points and keep whichever gives the cheapest
     assignment. A slightly longer walk can save a long wait.

## 2. Choose the bus

For each candidate pickup point:

1. **Pre-filter buses.** Lower bound = time the bus is next free at a node + travel to the pickup.
   Drop buses whose lower bound is after the latest pickup, then keep the 12 most promising.
2. **Try every insertion.** For each bus, insert the pickup before stop *i* and the drop-off
   before stop *j*, for all *i ≤ j*. Each candidate stop list is timed from the bus's next
   node:
   - travel between different nodes, plus *pull-over time*
   - at a pickup, wait until the rider's ready time, then add *boarding time*
   - at a drop-off, add *boarding time*
3. **Reject the insertion** if any of these is true:
   - the seats taken exceed capacity at any point
   - any pickup is later than that rider's latest pickup
   - any rider's ride is longer than their max ride

   For riders already on the plan, each limit is relaxed to whatever the current plan already
   gives them. A late bus can still take bookings, as long as it doesn't make anyone later.
4. **Score** the feasible insertions:
   - **Nearest available bus** (default, as specified for the pilot): the score is the new
     rider's pickup time, plus 0.01 × the extra delay to other riders as a tie-break. The bus
     with a free seat that reaches the rider first wins.
   - **Best pooling**: the score is the new rider's wait + ride time + the extra delay to
     everyone on the bus + 0.2 × the extra bus time. The bus whose detour costs everyone
     least wins.
5. Assign the lowest score overall. Write the new stop list to the bus and tell the rider:
   their meetup point, the walk, the bus, the promised pickup and the fare.

## Electric buses

- An electric bus whose battery falls below the *go to charge* level stops taking new
  bookings. It still finishes the pickups and drop-offs already in its plan.
- When its plan is empty it drives to the charging hub and queues. Chargers are handed out
  first come, first served.
- It charges at the charger's power up to the *charge up to* level, then returns to service.
- Dispatch does not check range per trip. The threshold (default 20% of 60 kWh, about 48 km)
  is far more than any trip inside Phase 1.

## 3. When no bus fits

The rider stays in *finding a bus* and is re-tried every 30 s until their latest pickup
passes. After that the booking is rejected as *no bus in time*.

## 4. After the match

- **No-shows**: the driver waits until the rider's ready time + the *grace period*, then
  drops the stop and carries on.
- **Late buses**: a rider whose bus hasn't arrived 5 minutes after their latest pickup
  cancels.
- **Closures on dual carriageways**: OpenStreetMap maps each direction as its own street.
  Closing one side leaves the other open; it carries both directions at half speed, so
  buses keep using it unless a detour is faster. Banning buses applies to both sides.
- **Network changes** (a street closed, buses banned): riders whose meetup point vanished are
  re-matched from scratch. Riders on board are re-routed to the nearest valid drop-off
  point.
- **Idle buses** follow one of three behaviours:
  - *keep driving the corridors*: random meetup points 0.6–2.5 km away
  - *drive towards recent demand*: hotspots and gates weighted by bookings in the last
    30 min, divided by the idle buses already heading there
  - *park*

## Things the production version will need that the simulator skips

- Live GPS positions instead of simulated ones. The insertion only needs "next node + time
  free".
- One-way streets and turn restrictions (the simulator treats all streets as two-way), and
  live traffic speeds per street.
- Re-optimising existing plans in the background. Insertion is greedy and never reshuffles
  earlier bookings.
- Payment, cancellation fees and driver acceptance.
