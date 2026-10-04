// Every knob the simulation exposes. The UI is generated from PARAM_SPECS, so adding a
// parameter here is enough to get a slider/select for it.

export type MatchingStrategy = 'nearest' | 'pooling';
export type MeetupStrategy = 'closest' | 'fastest';
export type IdleBehaviour = 'patrol' | 'park' | 'rebalance';
export type FareModel = 'flat' | 'distance' | 'zone';

export interface SimConfig {
  seed: number;
  serviceStart: number; // hour of day
  serviceEnd: number;
  // Fleet
  fleetSize: number;
  seatsPerBus: number;
  idleBehaviour: IdleBehaviour;
  // Demand
  bookingsPerHour: number;
  useDemandProfile: boolean;
  edgeTripShare: number; // 0..1 share of commute trips to/from the zone's edge gates
  hotspotShare: number; // 0..1 share of local trip ends at a hotspot rather than a home
  noShowRate: number; // 0..1
  // Street & meetup points
  meetupSpacing: number; // metres between meetup points along bus corridors
  maxWalk: number; // metres a rider will walk to a meetup point
  walkSpeed: number; // m/s
  meetupStrategy: MeetupStrategy;
  // Operations
  matchingStrategy: MatchingStrategy;
  trafficLevel: number; // 1 = free flow, 0.5 = everything at half speed
  timeVaryingTraffic: boolean;
  maxWaitMin: number; // rider patience (minutes) - also the max ETA we will promise
  maxDetour: number; // ride time may be at most this x the direct ride (+2 min)
  stopDwellSec: number; // fixed time to pull over at a meetup point
  boardSec: number; // per rider boarding / alighting
  driverGraceSec: number; // how long a driver waits for a no-show
  // Economics (Naira)
  fareModel: FareModel;
  fare: number; // flat
  baseFare: number; // distance
  farePerKm: number;
  fareInside: number; // zone
  fareEdge: number;
  fuelCostPerKm: number;
  busCostPerHour: number; // driver + vehicle lease/maintenance per bus-hour
}

export const DEFAULT_CONFIG: SimConfig = {
  seed: 42,
  serviceStart: 6,
  serviceEnd: 22,
  fleetSize: 10,
  seatsPerBus: 14,
  idleBehaviour: 'patrol',
  bookingsPerHour: 100,
  useDemandProfile: true,
  edgeTripShare: 0.45,
  hotspotShare: 0.5,
  noShowRate: 0.04,
  meetupSpacing: 200,
  maxWalk: 500,
  walkSpeed: 1.2,
  meetupStrategy: 'closest',
  matchingStrategy: 'nearest',
  trafficLevel: 0.8,
  timeVaryingTraffic: true,
  maxWaitMin: 12,
  maxDetour: 1.8,
  stopDwellSec: 20,
  boardSec: 8,
  driverGraceSec: 90,
  fareModel: 'flat',
  fare: 500,
  baseFare: 300,
  farePerKm: 150,
  fareInside: 400,
  fareEdge: 600,
  fuelCostPerKm: 150,
  busCostPerHour: 2500,
};

export interface NumberSpec {
  key: keyof SimConfig;
  label: string;
  kind: 'number';
  min: number;
  max: number;
  step: number;
  unit?: string;
  format?: (v: number) => string;
  help: string;
  /** Changing this needs a restart (network/fleet rebuilt). */
  restart?: boolean;
  showIf?: (c: SimConfig) => boolean;
}
export interface SelectSpec {
  key: keyof SimConfig;
  label: string;
  kind: 'select';
  options: { value: string; label: string }[];
  help: string;
  restart?: boolean;
  showIf?: (c: SimConfig) => boolean;
}
export interface BoolSpec {
  key: keyof SimConfig;
  label: string;
  kind: 'bool';
  help: string;
  restart?: boolean;
  showIf?: (c: SimConfig) => boolean;
}
export type ParamSpec = NumberSpec | SelectSpec | BoolSpec;

const pct = (v: number) => `${Math.round(v * 100)}%`;
const naira = (v: number) => `₦${v.toLocaleString('en-NG')}`;
export const clock = (h: number) => {
  const m = Math.round(h * 60) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

export const PARAM_GROUPS: { title: string; params: ParamSpec[] }[] = [
  {
    title: 'Fleet',
    params: [
      { key: 'fleetSize', label: 'Buses on the road', kind: 'number', min: 1, max: 40, step: 1, help: 'Number of buses cruising the corridors.', restart: true },
      { key: 'seatsPerBus', label: 'Seats per bus', kind: 'number', min: 4, max: 18, step: 1, help: 'A Toyota Hiace seats ~14 passengers; a Coaster ~18.' },
      {
        key: 'idleBehaviour', label: 'Empty buses should…', kind: 'select', help: 'What a bus with no bookings does.',
        options: [
          { value: 'patrol', label: 'Keep driving the corridor loops' },
          { value: 'rebalance', label: 'Drive towards recent demand' },
          { value: 'park', label: 'Park and wait where they are' },
        ],
      },
    ],
  },
  {
    title: 'Demand',
    params: [
      { key: 'bookingsPerHour', label: 'Bookings per hour', kind: 'number', min: 10, max: 1200, step: 10, help: 'Average bookings per hour. With the daily profile on, peaks are higher and the midday lull lower.' },
      { key: 'useDemandProfile', label: 'Rush-hour demand profile', kind: 'bool', help: 'Morning peak (to the toll gate and offices) and evening peak (back home).' },
      { key: 'edgeTripShare', label: 'Commutes to the edges', kind: 'number', min: 0, max: 1, step: 0.05, format: pct, help: 'Share of commute trips going to/from the toll gate, link bridge and expressway junctions (vs. shops, schools and offices inside Phase 1).' },
      { key: 'hotspotShare', label: 'Local trips at hotspots', kind: 'number', min: 0, max: 1, step: 0.05, format: pct, help: 'For trips inside Phase 1: share of trip ends at busy places (malls, schools, Admiralty Way) rather than homes.' },
      { key: 'noShowRate', label: 'No-show rate', kind: 'number', min: 0, max: 0.3, step: 0.01, format: pct, help: 'Riders who book but never turn up. The driver waits out the grace period.' },
    ],
  },
  {
    title: 'Meetup points',
    params: [
      { key: 'meetupSpacing', label: 'Meetup point spacing', kind: 'number', min: 80, max: 600, step: 20, unit: 'm', help: 'Distance between pickup points along bus corridors. Fewer points = more walking, fewer stops.', restart: true },
      { key: 'maxWalk', label: 'Max walk to meetup', kind: 'number', min: 100, max: 1200, step: 50, unit: 'm', help: 'Riders farther than this from any meetup point cannot book.' },
      { key: 'walkSpeed', label: 'Walking speed', kind: 'number', min: 0.6, max: 1.8, step: 0.1, unit: 'm/s', help: '1.2 m/s ≈ 4.3 km/h.' },
      {
        key: 'meetupStrategy', label: 'Pick meetup point by', kind: 'select', help: 'Closest = nearest to the rider. Fastest = the point within walking range that gets them picked up soonest.',
        options: [
          { value: 'closest', label: 'Closest to the rider' },
          { value: 'fastest', label: 'Fastest pickup (walk + bus ETA)' },
        ],
      },
    ],
  },
  {
    title: 'Dispatch & traffic',
    params: [
      {
        key: 'matchingStrategy', label: 'Assign rider to', kind: 'select', help: 'Nearest = the bus with a free seat that can reach the meetup first. Pooling = the bus whose detour costs everyone the least.',
        options: [
          { value: 'nearest', label: 'Nearest available bus' },
          { value: 'pooling', label: 'Best pooling (least total delay)' },
        ],
      },
      { key: 'trafficLevel', label: 'Traffic speed', kind: 'number', min: 0.2, max: 1.2, step: 0.05, format: pct, help: '100% = free-flow speeds (expressway 55, Admiralty Way 35, side roads 25 km/h).' },
      { key: 'timeVaryingTraffic', label: 'Rush-hour slowdowns', kind: 'bool', help: 'Roads slow down by up to 45% at peak hours.' },
      { key: 'maxWaitMin', label: 'Rider patience', kind: 'number', min: 3, max: 30, step: 1, unit: 'min', help: 'The longest pickup ETA we will offer. Riders cancel if the bus is much later than this.' },
      { key: 'maxDetour', label: 'Max ride detour', kind: 'number', min: 1, max: 3, step: 0.1, unit: '×', help: 'Ride time may be at most this multiple of the direct ride (+2 min) when sharing.' },
      { key: 'stopDwellSec', label: 'Pull-over time per stop', kind: 'number', min: 0, max: 90, step: 5, unit: 's', help: 'Time to pull over and rejoin traffic.' },
      { key: 'boardSec', label: 'Boarding time per rider', kind: 'number', min: 2, max: 40, step: 1, unit: 's', help: 'Time each rider takes to get on or off.' },
      { key: 'driverGraceSec', label: 'Driver waits for no-shows', kind: 'number', min: 0, max: 300, step: 15, unit: 's', help: 'How long the driver waits at the meetup point before marking a no-show.' },
    ],
  },
  {
    title: 'Economics',
    params: [
      {
        key: 'fareModel', label: 'Fare model', kind: 'select', help: 'How a trip is priced.',
        options: [
          { value: 'flat', label: 'Flat fare' },
          { value: 'distance', label: 'Base + per km' },
          { value: 'zone', label: 'Zone: inside vs. to the edges' },
        ],
      },
      { key: 'fare', label: 'Flat fare', kind: 'number', min: 100, max: 3000, step: 50, format: naira, help: 'Same price for every trip.', showIf: (c) => c.fareModel === 'flat' },
      { key: 'baseFare', label: 'Base fare', kind: 'number', min: 0, max: 2000, step: 50, format: naira, help: 'Charged on every trip.', showIf: (c) => c.fareModel === 'distance' },
      { key: 'farePerKm', label: 'Per km', kind: 'number', min: 0, max: 1000, step: 10, format: naira, help: 'Per km of the direct bus route between the meetup points.', showIf: (c) => c.fareModel === 'distance' },
      { key: 'fareInside', label: 'Inside Phase 1', kind: 'number', min: 100, max: 3000, step: 50, format: naira, help: 'Trips that start and end inside the estate.', showIf: (c) => c.fareModel === 'zone' },
      { key: 'fareEdge', label: 'To/from the edges', kind: 'number', min: 100, max: 3000, step: 50, format: naira, help: 'Trips to or from the toll gate, link bridge or expressway junctions.', showIf: (c) => c.fareModel === 'zone' },
      { key: 'fuelCostPerKm', label: 'Fuel cost per km', kind: 'number', min: 20, max: 500, step: 10, format: naira, help: 'A Hiace does ~8 km/L; at ₦1,200/L that is ₦150/km.' },
      { key: 'busCostPerHour', label: 'Driver + vehicle per bus-hour', kind: 'number', min: 0, max: 10000, step: 250, format: naira, help: 'Driver pay, lease, maintenance, insurance per bus per hour on the road.' },
    ],
  },
  {
    title: 'Service hours & scenario',
    params: [
      { key: 'serviceStart', label: 'Service starts', kind: 'number', min: 0, max: 23, step: 0.5, format: clock, help: 'Bookings open (the simulated day starts here).', restart: true },
      { key: 'serviceEnd', label: 'Service ends', kind: 'number', min: 1, max: 24, step: 0.5, format: clock, help: 'Bookings close; buses finish their trips and park.' },
      { key: 'seed', label: 'Random seed', kind: 'number', min: 1, max: 999, step: 1, help: 'Same seed + same settings = the same day, so you can compare changes fairly.', restart: true },
    ],
  },
];

export const ALL_PARAMS: ParamSpec[] = PARAM_GROUPS.flatMap((g) => g.params);
