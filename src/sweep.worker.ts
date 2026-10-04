import raw from './data/lekki-network.json';
import { Network, type RawNetwork } from './sim/network';
import { applyStreets, runPoint, type SweepRequest } from './sim/sweep';

const data = raw as unknown as RawNetwork;

self.onmessage = (e: MessageEvent<SweepRequest>) => {
  const req = e.data;
  const net = new Network(data, req.cfg.meetupSpacing);
  applyStreets(net, req.streets);
  req.values.forEach((value, i) => {
    const point = runPoint(data, net, req.cfg, req.param, value, req.seeds);
    // A run may have changed meetup spacing; restore streets for the next one.
    if (req.param === 'meetupSpacing') net.setMeetupSpacing(req.cfg.meetupSpacing);
    self.postMessage({ type: 'point', index: i, point });
  });
  self.postMessage({ type: 'done' });
};
