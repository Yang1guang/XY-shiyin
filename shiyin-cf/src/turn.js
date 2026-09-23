/* =========================================================
   拾音 · ICE 服务器下发（turn.js）
   返回给前端的 STUN / TURN 列表。

   支持三种来源：
   1. STUN_URLS          ：逗号分隔的 STUN 列表（默认用 Cloudflare STUN）
   2. TURN_URL/USERNAME/CREDENTIAL ：静态自建 TURN（如 coturn）
   3. CF_TURN_KEY_ID + CF_TURN_API_TOKEN ：Cloudflare Calls 托管 TURN，
      服务端用 API Token 换取短期凭证，前端不接触长期密钥（推荐）。
   ========================================================= */

function splitList(v) {
  return String(v || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

async function cloudflareTurn(env) {
  const keyId = env.CF_TURN_KEY_ID;
  const token = env.CF_TURN_API_TOKEN;
  if (!keyId || !token) return null;
  try {
    const ttl = parseInt(env.TURN_TTL || '86400', 10);
    const resp = await fetch(
      'https://rtc.live.cloudflare.com/v1/turn/keys/' + keyId + '/credentials/generate-ice-servers',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ttl: ttl })
      }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    // Cloudflare 返回 { iceServers: { urls:[...], username, credential } }
    if (data && data.iceServers) return Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers];
    return null;
  } catch (e) {
    return null;
  }
}

export async function buildIceServers(env) {
  const ice = [];

  // 1) STUN
  const stuns = splitList(env.STUN_URLS);
  const stunList = stuns.length ? stuns : ['stun:stun.cloudflare.com:3478'];
  for (const u of stunList) ice.push({ urls: u });

  // 2) Cloudflare 托管 TURN（优先）
  const cf = await cloudflareTurn(env);
  if (cf) { for (const s of cf) ice.push(s); }

  // 3) 静态自建 TURN（兜底 / 叠加）
  if (env.TURN_URL && env.TURN_USERNAME && env.TURN_CREDENTIAL) {
    ice.push({
      urls: splitList(env.TURN_URL),
      username: env.TURN_USERNAME,
      credential: env.TURN_CREDENTIAL
    });
  }

  return ice;
}

export async function handleTurn(env) {
  const iceServers = await buildIceServers(env);
  return new Response(JSON.stringify({ iceServers: iceServers }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*'
    }
  });
}
