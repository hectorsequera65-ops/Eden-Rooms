const INTERVAL_MS = 5 * 60 * 1000;
const DISPATCH_URL = 'https://api.github.com/repos/hectorsequera65-ops/Eden-Rooms/actions/workflows/enet-versions.yml/dispatches';

function isSlot(slot) {
  return Number.isSafeInteger(slot) && slot > 0 && slot % INTERVAL_MS === 0;
}

export class DispatchSlots {
  constructor(ctx) {
    this.slots = ctx.storage.kv;
  }

  fetch(request) {
    const path = new URL(request.url).pathname;
    const slot = Number(path.slice(1));
    if (request.method !== 'POST' || !isSlot(slot) || path !== `/${slot}`) {
      return new Response(null, { status: 400 });
    }
    // Synchronous SQLite operations prevent interleaving. The output gate
    // holds the response until the reservation is durably committed.
    if (slot <= (this.slots.get('latest') ?? -1)) {
      return new Response(null, { status: 409 });
    }
    this.slots.put('latest', slot);
    return new Response(null, { status: 201 });
  }
}

export default {
  async scheduled(event, env) {
    const scheduledTime = event.scheduledTime;
    if (!Number.isSafeInteger(scheduledTime) || scheduledTime < INTERVAL_MS) {
      console.warn('ENet cron skipped an invalid slot', scheduledTime);
      return;
    }
    // Cloudflare can report a scheduled timestamp within the five-minute slot.
    const slot = scheduledTime - (scheduledTime % INTERVAL_MS);

    const publish = env.ENET_CRON_PUBLISH === 'true';
    if (!env.ENET_GITHUB_DISPATCH_TOKEN || !env.ENET_CRON_REF ||
        !['true', 'false'].includes(env.ENET_CRON_PUBLISH) ||
        (publish && env.ENET_CRON_REF !== 'main')) {
      throw new Error('Invalid ENet cron configuration');
    }

    const store = env.DISPATCH_SLOTS;
    const reservation = await store.get(store.idFromName('enet-versions')).fetch(
      `https://dispatch-slots.internal/${slot}`, { method: 'POST' },
    );
    if (reservation.status === 409) {
      console.info('ENet cron skipped a duplicate slot', slot);
      return;
    }
    if (reservation.status !== 201) {
      throw new Error('Could not reserve ENet cron slot');
    }

    // An ambiguous network failure may already have created a run. Keep the
    // reservation and let the next slot proceed without reissuing this POST.
    const response = await fetch(DISPATCH_URL, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${env.ENET_GITHUB_DISPATCH_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'EdenRoomsENetCron',
        'X-GitHub-Api-Version': '2026-03-10',
      },
      body: JSON.stringify({
        ref: env.ENET_CRON_REF,
        inputs: { publish, cloudflare_slot: String(slot) },
      }),
    }).catch(() => {
      throw new Error(`GitHub dispatch failed for ENet cron slot ${slot}`);
    });

    if (response.body) await response.body.cancel();
    if (response.status !== 200 && response.status !== 204) {
      throw new Error(`GitHub dispatch returned HTTP ${response.status} for ENet cron slot ${slot}`);
    }
    console.info('GitHub accepted ENet cron dispatch', slot);
  },
};
