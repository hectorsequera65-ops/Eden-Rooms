const validId = /^[0-9A-F]{16}$/;
export async function onRequestGet({ request, params }) {
  const id = new URL(request.url).searchParams.get("id")?.toUpperCase() || "";
  if (!validId.test(id)) return new Response("ID invalido", { status: 400 });
  const sources = [
    `https://api.nlib.cc/nx/${id}/icon/256`,
    `https://api.nlib.cc/nx/${id}/icon`
  ];
  for (const source of sources) {
    try {
      const response = await fetch(source, { headers: { Accept: "image/jpeg,image/png,image/webp" }, signal: AbortSignal.timeout(7000) });
      const type = response.headers.get("content-type") || "";
      if (!response.ok || !/^image\/(jpeg|png|webp)/i.test(type)) continue;
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength < 1000 || bytes.byteLength > 2000000) continue;
      return new Response(bytes, {
        headers: {
          "Content-Type": type,
          "Cache-Control": "public, max-age=86400, s-maxage=604800",
          "X-Content-Type-Options": "nosniff"
        }
      });
    } catch (_) { /* Try next source. */ }
  }
  return new Response("Portada no disponible", { status: 404, headers: { "Cache-Control": "public, max-age=300" } });
}
