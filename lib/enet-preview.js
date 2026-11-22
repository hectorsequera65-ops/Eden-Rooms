export const PREVIEW_HOST = 'test-enet-versions-sralcer.eden-rooms.pages.dev';

export function isEnetPreview(request, env) {
  const url = new URL(request.url);
  return url.origin === `https://${PREVIEW_HOST}`
    && (!env.CF_PAGES_BRANCH || ['test/enet-versions-sralcer', 'test-enet-versions-sralcer'].includes(env.CF_PAGES_BRANCH));
}
