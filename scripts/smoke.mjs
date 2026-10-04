#!/usr/bin/env node
// Browser smoke test: serves dist/, drives every map tool and a scenario sweep, fails on
// console errors, and saves screenshots to $SHOTS (default ./screenshots).
// Usage: npm run build && node scripts/smoke.mjs
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';

const root = process.argv[2] || 'dist';
const shots = process.env.SHOTS || 'screenshots';
mkdirSync(shots, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer((req, res) => {
  let p = join(root, decodeURIComponent(req.url.split('?')[0]));
  if (p.endsWith('/')) p += 'index.html';
  if (!existsSync(p)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' }).end(readFileSync(p));
}).listen(0);
const url = `http://localhost:${server.address().port}/`;

const exe = process.env.CHROMIUM || (existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined);
const browser = await chromium.launch({ executablePath: exe });
const errors = [];
const fail = (m) => { errors.push(m); console.error('✗', m); };

async function open(viewport, colorScheme) {
  const page = await browser.newPage({ viewport, colorScheme });
  page.on('console', (m) => m.type() === 'error' && !/ERR_CERT_AUTHORITY_INVALID|fonts\.(googleapis|gstatic)/.test(m.text()) && fail(`console: ${m.text()}`));
  page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));
  await page.goto(url);
  await page.waitForSelector('.map-canvas');
  await page.waitForTimeout(1500);
  return page;
}

// Desktop, light
const page = await open({ width: 1440, height: 900 }, 'light');
await page.click('[data-speed="180"]');
await page.waitForTimeout(3000);
await page.screenshot({ path: `${shots}/desktop-light.png` });

const box = await page.locator('.map-canvas').boundingBox();
const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];

// Book a ride: two clicks on the map
await page.click('[data-tool="book"]');
await page.mouse.click(...at(0.45, 0.45));
await page.mouse.click(...at(0.7, 0.6));
await page.waitForTimeout(500);
const toast = await page.locator('#toast').innerText();
console.log('booking toast:', toast.replace(/\s+/g, ' '));
if (!/Bus \d+ is coming|Can’t book|Looking for a bus/.test(toast)) fail('booking did not produce a result toast');
await page.screenshot({ path: `${shots}/booking.png` });

// Street tools: click the centre of the map a few times with each
for (const tool of ['bus', 'close', 'jam']) {
  await page.click(`[data-tool="${tool}"]`);
  for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.4], [0.6, 0.3]]) await page.mouse.click(...at(fx, fy));
}
await page.waitForTimeout(1500);
await page.screenshot({ path: `${shots}/disruptions.png` });

// Inspect: click the first bus via the log, then check the inspector
await page.click('[data-tool="select"]');
await page.locator('.log li[data-bus]').first().click().catch(() => {});
await page.waitForTimeout(400);
console.log('inspector:', (await page.locator('.inspector-body').innerText()).split('\n').slice(0, 3).join(' | '));

// Settings: change a live and a restart parameter
await page.locator('#cfg-matchingStrategy').selectOption('pooling');
await page.locator('#cfg-fleetSize').fill('12');
await page.locator('#cfg-fleetSize').dispatchEvent('change');
await page.waitForTimeout(800);

// Compare scenarios: a small, fast sweep
await page.click('#tab-compare');
await page.locator('#sweep-from').fill('4');
await page.locator('#sweep-to').fill('12');
await page.locator('#sweep-steps').fill('3');
await page.click('#sweep-run');
await page.waitForFunction(() => /Done/.test(document.querySelector('#sweep-status')?.textContent || ''), null, { timeout: 180000 });
console.log('sweep:', (await page.locator('#sweep-rec').innerText()).replace(/\s+/g, ' '));
await page.screenshot({ path: `${shots}/compare.png` });
await page.close();

// Desktop dark and phone
const dark = await open({ width: 1440, height: 900 }, 'dark');
await dark.screenshot({ path: `${shots}/desktop-dark.png` });
await dark.close();
const phone = await open({ width: 390, height: 844 }, 'light');
const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
if (overflow > 1) fail(`phone layout scrolls sideways by ${overflow}px`);
await phone.screenshot({ path: `${shots}/phone.png`, fullPage: false });
await phone.close();

await browser.close();
server.close();
if (errors.length) {
  console.error(`${errors.length} problem(s)`);
  process.exit(1);
}
console.log('Smoke test passed. Screenshots in', shots);
