const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=86400' };
function validIPv4(ip) {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) return false;
  const parts=ip.split('.').map(Number);
  if(parts.some(n=>n>255)) return false;
  const [a,b]=parts;
  return a!==0&&a!==10&&a!==127&&a<224&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)&&!(a===192&&b===168)&&!(a===100&&b>=64&&b<=127);
}
async function lookup(url) {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),4500);
  try {
    const response=await fetch(url,{signal:controller.signal,headers:{Accept:'application/json'}});
    if(!response.ok) return {error:'HTTP '+response.status};
    return {data:await response.json()};
  } catch(e){return {error:e?.name==='AbortError'?'Tiempo agotado':'Error de conexión'};}
  finally{clearTimeout(timer);}
}
export async function onRequestGet({request}) {
  const ip=new URL(request.url).searchParams.get('ip')?.trim()||'';
  if(!validIPv4(ip)) return Response.json({error:'IP pública IPv4 inválida'},{status:400});
  const providers=[
    {name:'ipwho.is',url:'https://ipwho.is/'+ip,parse:d=>d.success!==false&&d.country?{city:d.city,region:d.region,country:d.country}:null},
    {name:'ipapi.co',url:'https://ipapi.co/'+ip+'/json/',parse:d=>!d.error&&d.country_name?{city:d.city,region:d.region,country:d.country_name}:null},
    {name:'ip-api.com',url:'http://ip-api.com/json/'+ip+'?fields=status,message,country,regionName,city',parse:d=>d.status==='success'?{city:d.city,region:d.regionName,country:d.country}:null},
    {name:'ipinfo.io',url:'https://ipinfo.io/'+ip+'/json',parse:d=>d.country&&!d.bogon?{city:d.city,region:d.region,country:d.country}:null}
  ];
  const checks=await Promise.all(providers.map(async p=>{
    const result=await lookup(p.url);
    if(!result.data)return {name:p.name,error:result.error||'Sin datos'};
    const parsed=p.parse(result.data);
    return parsed?.country?{name:p.name,location:parsed}:{name:p.name,error:'Sin ubicación válida'};
  }));
  const success=checks.find(c=>c.location);
  if(success){
    const {city='',region='',country}=success.location;
    return new Response(JSON.stringify({ip,city,region,country,source:success.name}),{headers:jsonHeaders});
  }
  return Response.json({error:'Ubicación temporalmente no disponible',providers:checks.map(({name,error})=>({name,error}))},{status:503,headers:{'Cache-Control':'no-store'}});
}
