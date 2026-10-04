// Fares, costs and the summary numbers shown in the dashboard and scenario sweeps.
import type { SimConfig } from './config';
import type { Stats } from './simulation';

// Emission factors (assumptions): petrol minibus ~8 km/L × 2.3 kg CO2/L; Nigerian grid
// ~0.43 kg CO2/kWh, with ~90% charger efficiency.
export const FUEL_CO2_PER_KM = 0.29;
export const GRID_CO2_PER_KWH = 0.43 / 0.9;

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
  electricityCost: number;
  busCost: number;
  /** kg of CO2 from driving (tailpipe for fuel buses, grid for electric) */
  co2Kg: number;
  co2PerRide: number; // kg
  kwh: number;
  chargeHours: number;
  queueHours: number;
  chargeVisits: number;
  flatBatteries: number;
  /** share of bus-hours lost to charging and queueing */
  chargingShare: number;
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
  st: Stats,
  hours: number,
): Summary {
  const fuelCost = st.fuelKm * cfg.fuelCostPerKm;
  const electricityCost = st.kwh * cfg.electricityPrice;
  const busCost = st.busHoursFuel * cfg.busCostPerHour + st.busHoursEv * cfg.evBusCostPerHour;
  const costs = fuelCost + electricityCost + busCost;
  const profit = st.revenue - costs;
  const co2Kg = st.fuelKm * FUEL_CO2_PER_KM + st.kwh * GRID_CO2_PER_KWH;
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
    electricityCost,
    busCost,
    co2Kg,
    co2PerRide: st.pickedUp ? co2Kg / st.pickedUp : NaN,
    kwh: st.kwh,
    chargeHours: st.chargeHours,
    queueHours: st.queueHours,
    chargeVisits: st.chargeVisits,
    flatBatteries: st.flatBatteries,
    chargingShare: st.busHours > 0 ? (st.chargeHours + st.queueHours) / st.busHours : 0,
    profit,
    profitPerHour: hours > 0 ? profit / hours : 0,
    breakEvenFare: st.pickedUp ? costs / st.pickedUp : NaN,
  };
}
