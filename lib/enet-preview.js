export const PREVIEW_HOST = 'test-enet-versions-sralcer.eden-rooms.pages.dev';

export function isEnetPreview(request, env) {
  const url = new URL(request.url);
  return url.origin === `https://${PREVIEW_HOST}`
    && (!env.CF_PAGES_BRANCH || ['test/enet-versions-sralcer', 'test-enet-versions-sralcer'].includes(env.CF_PAGES_BRANCH));
}

export function scheduledPreview(request, env) {
  return env.ENET_SCHEDULED_ENABLED === 'true' && isEnetPreview(request, env);
}

export function respond(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'}
  });
}

export const PREVIEW_SNAPSHOTS = 'enet_scheduled_snapshots';
export const PRODUCTION_SNAPSHOTS = 'enet_production_snapshots';
export const PRODUCTION_HOST = 'eden-rooms.pages.dev';

export function isScheduledProduction(request, env) {
  return new URL(request.url).origin === `https://${PRODUCTION_HOST}`
    && (!env.CF_PAGES_BRANCH || env.CF_PAGES_BRANCH === 'main')
    && env.ENET_PRODUCTION_ENABLED === 'true';
}

export async function productionStorage(env) {
  const db = env.DB;
  if (!db || db === env.ENET_PREVIEW_DB) return null;
  try {
    const marker = await db.prepare(
      "SELECT target FROM enet_scheduled_target WHERE target = 'production'"
    ).first();
    return marker?.target === 'production' ? db : null;
  } catch {
    return null;
  }
}

export async function previewStorage(env) {
  const db = env.ENET_PREVIEW_DB;
  if (!db) return null;
  try {
    const productionSchema = await db.prepare(
      "SELECT name FROM sqlite_schema WHERE name = 'enet_scheduled_target' COLLATE NOCASE"
    ).first();
    return productionSchema ? null : db;
  } catch {
    return null;
  }
}
