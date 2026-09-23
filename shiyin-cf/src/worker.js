/* =========================================================
   拾音 · Cloudflare Worker 入口（worker.js）
   一个 Worker 同时承担：
     - 静态资源服务（public/ → ASSETS）
     - WebSocket 信令路由（/ws?room=CODE&mode=solo|group → Durable Object）
     - ICE 服务器下发（/api/turn）
     - 运行时配置（/api/config）
   ========================================================= */

import { SignalingRoom } from './signaling.js';
import { handleTurn } from './turn.js';

export { SignalingRoom };

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ── 信令：升级为 WebSocket，转交对应房间的 Durable Object ──
    if (path === '/ws') {
      const upgrade = request.headers.get('Upgrade') || '';
      if (upgrade.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }
      const room = (url.searchParams.get('room') || '').toUpperCase();
      const mode = url.searchParams.get('mode') === 'group' ? 'group' : 'solo';
      if (!room || room.length < 4) return new Response('Invalid room', { status: 400 });

      const id = env.SIGNALING.idFromName(mode + ':' + room);
      const stub = env.SIGNALING.get(id);
      return stub.fetch(request);
    }

    // ── ICE 服务器（STUN / TURN 凭证）──
    if (path === '/api/turn') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*' } });
      }
      return handleTurn(env);
    }

    // ── 前端运行时配置 ──
    if (path === '/api/config') {
      return json({
        maxGroup: parseInt(env.MAX_GROUP || '4', 10),
        prefix: env.PREFIX || 'shiyin',
        reconnectSeconds: parseInt(env.RECONNECT_SECONDS || '60', 10)
      });
    }

    // ── 其余交给静态资源 ──
    return env.ASSETS.fetch(request);
  }
};
