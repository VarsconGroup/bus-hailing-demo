import type { RawNetwork, RoadClass } from '../src/sim/network';

/**
 * n×n grid of streets `block` metres apart. Rows/columns listed in `busLines` are collector
 * bus streets; everything else is local. Gates at two corners.
 */
export function gridNetwork(n = 6, block = 200, busLines = [0, 2, 5]): RawNetwork {
  const nodes: [number, number][] = [];
  const id = (i: number, j: number) => i * n + j;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) nodes.push([j * block, i * block]);
  const ways: RawNetwork['ways'] = [];
  for (let i = 0; i < n; i++) {
    const bus = busLines.includes(i);
    const cls: RoadClass = bus ? 'collector' : 'local';
    ways.push({ name: `Row ${i}`, cls, bus, nodes: Array.from({ length: n }, (_, j) => id(i, j)) });
    ways.push({ name: `Col ${i}`, cls, bus, nodes: Array.from({ length: n }, (_, j) => id(j, i)) });
  }
  const max = (n - 1) * block;
  return {
    source: 'schematic',
    bounds: { minX: 0, minY: 0, maxX: max, maxY: max },
    zone: [[-50, -50], [max + 50, -50], [max + 50, max + 50], [-50, max + 50]],
    nodes,
    ways,
    context: [],
    water: [],
    gates: [{ name: 'Gate A', x: 0, y: 0 }, { name: 'Gate B', x: max, y: max }],
    pois: [
      { name: 'Mall', kind: 'shopping', x: 400, y: 400 },
      { name: 'School', kind: 'school', x: 800, y: 200 },
    ],
  };
}
