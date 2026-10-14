import { test, before, after } from 'node:test';
import { startApp } from './app-harness.js';
import { tieout } from './tieout.js';

let app, t;
before(async () => { app = await startApp(); t = tieout(app); });
after(async () => { await app.close(); });

test('the sample books tie out every way', async () => {
  t.checkTied(await t.snapshot(), 'sample');
});
