import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker, { DispatchSlots } from '../backend/enet/cron/worker.mjs';

const interval = 300_000;
const current = Date.UTC(2026, 0, 1);

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
    ENET_CRON_REF: 'integration/enet-cloudflare-preview',
    ENET_CRON_PUBLISH: 'false',
  };
  const outbound = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
  const tick = (scheduledTime) => worker.scheduled({ scheduledTime }, env);

  for (const invalidSlot of [undefined, String(current), 0, -interval, current + 0.5, NaN, Infinity]) {
    await tick(invalidSlot);
  }
  assert.equal(outbound.mock.callCount(), 0);
  for (const [path, method] of [
    ['invalid', 'POST'],
    [current + interval + 1, 'POST'],
    [`0${current + interval}`, 'POST'],
    [current + interval, 'GET'],
  ]) {
    const response = object.fetch(new Request(`https://dispatch-slots.internal/${path}`, { method }));
    assert.equal(response.status, 400);
  }
  assert.equal(values.size, 0);
  await Promise.all([tick(current + interval), tick(current + interval)]);
  object = new DispatchSlots({ storage });
  await tick(current + interval + 4522);
  await tick(current);
  assert.equal(outbound.mock.callCount(), 1);

  const [url, options] = outbound.mock.calls[0].arguments;
  assert.equal(url, 'https://api.github.com/repos/hectorsequera65-ops/Eden-Rooms/actions/workflows/enet-versions.yml/dispatches');
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'manual');
  assert.equal(options.headers.Authorization, 'Bearer test-only-token');
  assert.deepEqual(JSON.parse(options.body), {
    ref: 'integration/enet-cloudflare-preview',
    inputs: { publish: false, cloudflare_slot: String(current + interval) },
  });

  env.ENET_CRON_PUBLISH = 'true';
  await assert.rejects(tick(current + 2 * interval), /Invalid ENet cron configuration/);
  env.ENET_CRON_REF = 'main';
  outbound.mock.mockImplementationOnce(async () => new Response('token or diagnostics', { status: 403 }));
  await assert.rejects(tick(current + 2 * interval), {
    message: `GitHub dispatch returned HTTP 403 for ENet cron slot ${current + 2 * interval}`,
  });
  await tick(current + 2 * interval);
  assert.equal(outbound.mock.callCount(), 2);

  outbound.mock.mockImplementationOnce(async () => { throw new Error('private detail'); });
  await assert.rejects(tick(current + 3 * interval), {
    message: `GitHub dispatch failed for ENet cron slot ${current + 3 * interval}`,
  });
  await tick(current + 3 * interval);
  assert.equal(outbound.mock.callCount(), 3);

  outbound.mock.mockImplementationOnce(async () => new Response('{"workflow_run_id":1}', { status: 200 }));
  await tick(current + 4 * interval);
  assert.equal(outbound.mock.callCount(), 4);
  assert.deepEqual(JSON.parse(outbound.mock.calls[3].arguments[1].body), {
    ref: 'main',
    inputs: { publish: true, cloudflare_slot: String(current + 4 * interval) },
  });

  outbound.mock.mockImplementationOnce(async () => Response.redirect('https://example.com/'));
  await assert.rejects(tick(current + 5 * interval), /GitHub dispatch returned HTTP 302/);
  await tick(current + 5 * interval);
  assert.equal(outbound.mock.callCount(), 5);
});

test('cron uses the original slot despite clock skew or delayed execution', async (t) => {
  const reserve = t.mock.fn(async () => new Response(null, { status: 201 }));
  const env = {
    DISPATCH_SLOTS: {
      idFromName: (name) => name,
      get: () => ({ fetch: reserve }),
    },
    ENET_GITHUB_DISPATCH_TOKEN: 'test-only-token',
    ENET_CRON_REF: 'integration/enet-cloudflare-preview',
    ENET_CRON_PUBLISH: 'false',
  };
  const now = t.mock.method(Date, 'now', () => current);
  const outbound = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));

  for (const age of [-interval, 0, 4 * interval, 60 * interval]) {
    now.mock.mockImplementation(() => current + age);
    reserve.mock.resetCalls();
    outbound.mock.resetCalls();
    await worker.scheduled({ scheduledTime: current }, env);
    assert.equal(reserve.mock.callCount(), 1, `reservation at age ${age} ms`);
    assert.equal(reserve.mock.calls[0].arguments[0], `https://dispatch-slots.internal/${current}`);
    assert.equal(outbound.mock.callCount(), 1, `dispatch at age ${age} ms`);
    assert.deepEqual(JSON.parse(outbound.mock.calls[0].arguments[1].body).inputs, {
      publish: false,
      cloudflare_slot: String(current),
    });
  }
});

test('cron reserves the five-minute slots observed in Wrangler logs', async (t) => {
  const slots = new Map();
  const object = new DispatchSlots({
    storage: { kv: { get: (key) => slots.get(key), put: (key, value) => slots.set(key, value) } },
  });
  const env = {
    DISPATCH_SLOTS: {
      idFromName: (name) => name,
      get: () => ({ fetch: (url, options) => object.fetch(new Request(url, options)) }),
    },
    ENET_GITHUB_DISPATCH_TOKEN: 'test-only-token',
    ENET_CRON_REF: 'integration/enet-cloudflare-preview',
    ENET_CRON_PUBLISH: 'false',
  };
  const outbound = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));

  const observedTimes = [
    1795386004522, 1795386304522, 1795386904522, 1795387204522, 1795387504522,
    1795401304522, 1795401604522, 1795402804522, 1795403104522, 1795403404522,
  ];
  const expectedSlots = [
    1795386000000, 1795386300000, 1795386900000, 1795387200000, 1795387500000,
    1795401300000, 1795401600000, 1795402800000, 1795403100000, 1795403400000,
  ];
  const warningDelays = [1007, 853, 922, 751, 623, 2415, 878, 1446, 826, 971];
  const now = t.mock.method(Date, 'now', () => observedTimes[0]);
  for (const [index, scheduledTime] of observedTimes.entries()) {
    now.mock.mockImplementation(() => scheduledTime + warningDelays[index]);
    await worker.scheduled({ scheduledTime }, env);
    assert.equal(outbound.mock.callCount(), index + 1, `dispatch for ${scheduledTime}`);
    await worker.scheduled({ scheduledTime: expectedSlots[index] }, env);
  }
  await worker.scheduled({ scheduledTime: observedTimes[0] }, env);

  assert.deepEqual(outbound.mock.calls.map(({ arguments: [, options] }) => (
    JSON.parse(options.body).inputs
  )), expectedSlots.map((slot) => ({ publish: false, cloudflare_slot: String(slot) })));
  assert.equal(slots.get('latest'), expectedSlots.at(-1));
});
