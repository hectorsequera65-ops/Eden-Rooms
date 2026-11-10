const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=86400' };
function validIPv4(ip) {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) return false;
  const parts = ip.split('.').map(Number);
  if (parts.some(n => n > 255)) return false;
  const [a,b] = parts;
  return a !== 0 && a !== 10 && a !== 127 && a < 224 &&
    !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && b === 168) && !(a === 100 && b >= 64 && b <= 127);
}
async function lookup(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const r = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json', 'User-Agent': 'EdenRooms/1.0' } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
  finally { clearTimeout(timer); }
}
export async function onRequestGet({ request }) {
  const ip = new URL(request.url).searchParams.get('ip')?.trim() || '';
  if (!validIPv4(ip)) return Response.json({ error: 'IP pública IPv4 inválida' }, { status: 400 });
  const primary = await lookup('https://ipwho.is/' + ip);
  let city = '', region = '', country = '', source = '';
  if (primary && primary.success !== false && primary.country) {
    ({ city = '', region = '', country = '' } = primary);
    source = 'ipwho.is';
  } else {
    const fallback = await lookup('https://ipapi.co/' + ip + '/json/');
    if (fallback && !fallback.error && fallback.country_name) {
      city = fallback.city || '';
      region = fallback.region || '';
      country = fallback.country_name;
      source = 'ipapi.co';
    }
  }
  if (!country) return Response.json({ error: 'Ubicación temporalmente no disponible' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  return new Response(JSON.stringify({ ip, city, region, country, source }), { headers: jsonHeaders });
}
