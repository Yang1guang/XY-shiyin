/* =========================================================
   拾音 · Durable Object 信令房间（signaling.js）
   每个房间码对应一个 DO 实例，天然做到房间隔离与状态一致。
   复用 room-core.js，保证与本地测试同源。
   ========================================================= */

import { createRoom, MAX_SOLO, MAX_GROUP } from './room-core.js';

export class SignalingRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.conns = new Map(); // connId -> WebSocket
    this.room = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const mode = url.searchParams.get('mode') === 'group' ? 'group' : 'solo';

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // 使用 hibernation 友好的可接受 WebSocket
    server.accept();

    if (!this.room || this.room.isClosed()) {
      const max = mode === 'group' ? MAX_GROUP : MAX_SOLO;
      const self = this;
      this.room = createRoom({
        max: max,
        send: function (connId, obj) {
          const ws = self.conns.get(connId);
          if (ws) { try { ws.send(JSON.stringify(obj)); } catch (e) {} }
        },
        onEmpty: function () { self.room = null; }
      });
    }

    const connId = 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    this.conns.set(connId, server);

    // 尝试加入（可能因满员被拒）
    this.room.join(connId);

    server.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m && m.t === 'sig' && this.room) this.room.signal(connId, m);
    });

    const cleanup = () => {
      this.conns.delete(connId);
      if (this.room) this.room.leave(connId);
    };
    server.addEventListener('close', cleanup);
    server.addEventListener('error', cleanup);

    return new Response(null, { status: 101, webSocket: client });
  }
}
