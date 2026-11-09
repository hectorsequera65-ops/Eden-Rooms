export async function onRequestGet() {
  try {
    const upstream = await fetch('https://api.ynet-fun.xyz/lobby', {
      headers: { 'Accept': 'application/json', 'User-Agent': 'EdenRooms/1.0' },
      cf: { cacheTtl: 5, cacheEverything: true }
    });
    if (!upstream.ok) return Response.json({ error: 'API de Eden no disponible', status: upstream.status }, { status: 502 });
    const data = await upstream.json();
    if (!data || !Array.isArray(data.rooms)) return Response.json({ error: 'Formato inesperado' }, { status: 502 });
    return Response.json({ rooms: data.rooms }, { headers: { 'Cache-Control': 'public, max-age=5' } });
  } catch (e) {
    return Response.json({ error: 'No se pudo consultar la API de Eden' }, { status: 502 });
  }
}
