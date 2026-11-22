import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker, { DispatchSlots } from '../backend/enet/cron/worker.mjs';

const interval = 300_000;
const current = Math.floor(Date.now() / interval) * interval;

test('cron reserves each slot once and sends only the expected GitHub inputs', async (t) => {
  const values = new Map();
  const storage = { kv: { get: values.get.bind(values), put: values.set.bind(values) } };
  let object = new DispatchSlots({ storage });
  const env = {
    DISPATCH_SLOTS: {
      idFromName: (name) => name,
      get: () => ({ fetch: async (url, init) => object.fetch(new Request(url, init)) }),
    },
    ENET_GITHUB_DISPATCH_TOKEN: 'test-only-token',
    ENET_CRON_REF: 'feat/enet-cloudflare-cron',
    ENET_CRON_PUBLISH: 'false',
  };
  t.mock.method(Date, 'now', () => current + interval + 1000);
  const outbound = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
  const tick = (scheduledTime) => worker.scheduled({ scheduledTime }, env);

  await tick(current);
  await tick(current + interval + 1);
  assert.equal(outbound.mock.callCount(), 0);
  await Promise.all([tick(current + interval), tick(current + interval)]);
  object = new DispatchSlots({ storage });
  await tick(current + interval);
  assert.equal(outbound.mock.callCount(), 1);

  const [url, options] = outbound.mock.calls[0].arguments;
  assert.equal(url, 'https://api.github.com/repos/hectorsequera65-ops/Eden-Rooms/actions/workflows/enet-versions.yml/dispatches');
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'manual');
  assert.equal(options.headers.Authorization, 'Bearer test-only-token');
  assert.deepEqual(JSON.parse(options.body), {
    ref: 'feat/enet-cloudflare-cron',
    inputs: { publish: false, cloudflare_slot: String(current + interval) },
  });

  t.mock.method(Date, 'now', () => current + 2 * interval);
  env.ENET_CRON_PUBLISH = 'true';
  await assert.rejects(tick(current + 2 * interval), /Invalid ENet cron configuration/);
  env.ENET_CRON_REF = 'main';
  outbound.mock.mockImplementationOnce(async () => new Response('token or diagnostics', { status: 403 }));
  await assert.rejects(tick(current + 2 * interval), {
    message: `GitHub dispatch returned HTTP 403 for ENet cron slot ${current + 2 * interval}`,
  });
  await tick(current + 2 * interval);
  assert.equal(outbound.mock.callCount(), 2);

  t.mock.method(Date, 'now', () => current + 3 * interval);
  outbound.mock.mockImplementationOnce(async () => { throw new Error('private detail'); });
  await assert.rejects(tick(current + 3 * interval), {
    message: `GitHub dispatch failed for ENet cron slot ${current + 3 * interval}`,
  });
  await tick(current + 3 * interval);
  assert.equal(outbound.mock.callCount(), 3);

  t.mock.method(Date, 'now', () => current + 4 * interval);
  outbound.mock.mockImplementationOnce(async () => new Response('{"workflow_run_id":1}', { status: 200 }));
  await tick(current + 4 * interval);
  assert.equal(outbound.mock.callCount(), 4);
  assert.deepEqual(JSON.parse(outbound.mock.calls[3].arguments[1].body), {
    ref: 'main',
    inputs: { publish: true, cloudflare_slot: String(current + 4 * interval) },
  });

  t.mock.method(Date, 'now', () => current + 5 * interval);
  outbound.mock.mockImplementationOnce(async () => Response.redirect('https://example.com/'));
  await assert.rejects(tick(current + 5 * interval), /GitHub dispatch returned HTTP 302/);
  assert.equal(outbound.mock.callCount(), 5);
});
