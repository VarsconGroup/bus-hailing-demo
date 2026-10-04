// Fares, costs and the summary numbers shown in the dashboard and scenario sweeps.
import type { SimConfig } from './config';

export function fareFor(cfg: SimConfig, trip: { directDist: number; edgeTrip: boolean }): number {
  switch (cfg.fareModel) {
    case 'flat':
      return cfg.fare;
    case 'distance':
      return Math.round((cfg.baseFare + (cfg.farePerKm * trip.directDist) / 1000) / 10) * 10;
    case 'zone':
      return trip.edgeTrip ? cfg.fareEdge : cfg.fareInside;
  }
}

export interface Summary {
  hours: number;
  requested: number;
  served: number;
  pickedUp: number;
  cancelled: number;
  rejected: number;
  rejectedWalk: number;
  rejectedNoBus: number;
  noShows: number;
  /** picked up ÷ bookings within walking reach of a meetup point (excludes no-shows) */
  serviceRate: number;
  /** share of bookings with a meetup point within walking range at both ends */
  reachRate: number;
  avgWait: number; // min
  p90Wait: number; // min
  avgWalk: number; // m (both ends)
  avgRide: number; // min
  avgDetour: number; // ride ÷ direct
  onTime: number; // share picked up no more than 2 min after the promised time
  occupancy: number; // passenger-km ÷ seat-km
  avgLoad: number; // riders on board while carrying
  utilisation: number; // share of bus-hours with a booking
  km: number;
  emptyKmShare: number;
  ridesPerBusHour: number;
  revenue: number;
  fuelCost: number;
  busCost: number;
  profit: number;
  profitPerHour: number;
  breakEvenFare: number;
}

const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const pct = (a: number[], p: number) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

export function summarize(
  cfg: SimConfig,
  st: {
    requested: number; pickedUp: number; served: number; cancelled: number; rejectedWalk: number; rejectedNoBus: number; noShows: number;
    waits: number[]; walks: number[]; rides: number[]; detours: number[]; lateness: number[];
    revenue: number; km: number; kmLoaded: number; paxKm: number; seatKm: number; busHours: number; busyHours: number;
  },
  hours: number,
): Summary {
  const fuelCost = st.km * cfg.fuelCostPerKm;
  const busCost = st.busHours * cfg.busCostPerHour;
  const profit = st.revenue - fuelCost - busCost;
  const eligible = st.requested - st.noShows - st.rejectedWalk;
  return {
    hours,
    requested: st.requested,
    served: st.served,
    pickedUp: st.pickedUp,
    cancelled: st.cancelled,
    rejected: st.rejectedWalk + st.rejectedNoBus,
    rejectedWalk: st.rejectedWalk,
    rejectedNoBus: st.rejectedNoBus,
    noShows: st.noShows,
    serviceRate: eligible > 0 ? st.pickedUp / eligible : NaN,
    reachRate: st.requested > 0 ? 1 - st.rejectedWalk / st.requested : NaN,
    avgWait: mean(st.waits),
    p90Wait: pct(st.waits, 0.9),
    avgWalk: mean(st.walks),
    avgRide: mean(st.rides),
    avgDetour: mean(st.detours),
    onTime: st.lateness.length ? st.lateness.filter((l) => l <= 2).length / st.lateness.length : NaN,
    occupancy: st.seatKm > 0 ? st.paxKm / st.seatKm : 0,
    avgLoad: st.kmLoaded > 0 ? st.paxKm / st.kmLoaded : 0,
    utilisation: st.busHours > 0 ? st.busyHours / st.busHours : 0,
    km: st.km,
    emptyKmShare: st.km > 0 ? 1 - st.kmLoaded / st.km : 0,
    ridesPerBusHour: st.busHours > 0 ? st.pickedUp / st.busHours : 0,
    revenue: st.revenue,
    fuelCost,
    busCost,
    profit,
    profitPerHour: hours > 0 ? profit / hours : 0,
    breakEvenFare: st.pickedUp ? (fuelCost + busCost) / st.pickedUp : NaN,
  };
}
