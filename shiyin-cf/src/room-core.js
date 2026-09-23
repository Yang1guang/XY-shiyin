/* =========================================================
   拾音 · 信令房间核心（room-core.js）
   与运行环境无关：Node 本地测试与 Cloudflare Durable Object 共用同一份逻辑，
   保证「本地跑通的语义 = 线上语义」。

   职责：
   - 房间成员管理（一对一上限 2，群聊上限 4）
   - 成员加入 / 离开的广播
   - ICE 信令的点对点转发（不做解析，只透传 SDP / candidate）
   - 「挂断即消」：房主离开则整间关闭；房间清空则回收

   协议（JSON 文本帧，字段 t = type）：
   客户端 -> 服务端：
     { t:"sig", to:<peerId>, data:{...} }   转发给指定成员
   服务端 -> 客户端：
     { t:"joined",     id:<selfId>, host:<bool>, peers:[<id>...] }
     { t:"peer-joined",id:<peerId> }
     { t:"peer-left",  id:<peerId> }
     { t:"sig",        from:<peerId>, data:{...} }
     { t:"full" }                              房间已满
     { t:"closed" }                            房间已关闭（房主挂断 / 已失效）
   ========================================================= */

export const MAX_SOLO = 2;
export const MAX_GROUP = 4;

/**
 * 创建一个房间实例。
 * @param {object} opts
 * @param {number} opts.max      房间人数上限
 * @param {function} opts.send    (connId, obj) => void   向某条连接发送消息
 * @param {function} [opts.onEmpty]  房间清空时回调（用于回收 DO 状态）
 */
export function createRoom(opts) {
  const max = opts.max || MAX_SOLO;
  const send = opts.send;
  const onEmpty = opts.onEmpty || function () {};

  const peers = new Map(); // connId -> { id, joinedAt }
  let hostId = null;       // 第一个加入者即房主
  let closed = false;
  let seq = 0;

  function newId() {
    // 用于确定性协商：id 可比较（字符串字典序），小的一方发起 offer
    seq += 1;
    const s = String(seq).padStart(3, '0');
    const r = Math.random().toString(36).slice(2, 6);
    return 'p' + s + r;
  }

  function roster() {
    return [...peers.values()].map(function (p) { return p.id; });
  }

  return {
    get size() { return peers.size; },
    get hostId() { return hostId; },
    isClosed() { return closed; },

    /** 成员加入，返回分配到的 peerId（失败返回 null） */
    join(connId) {
      if (closed) { send(connId, { t: 'closed' }); return null; }
      if (peers.size >= max) { send(connId, { t: 'full' }); return null; }

      const id = newId();
      peers.set(connId, { id: id, joinedAt: Date.now() });
      if (!hostId) hostId = id;

      // 先告知加入者自己的身份与现有名单（不含自己）
      const others = roster().filter(function (x) { return x !== id; });
      send(connId, { t: 'joined', id: id, host: id === hostId, peers: others });

      // 再广播给房间其他成员
      for (const [c, p] of peers) {
        if (c !== connId) send(c, { t: 'peer-joined', id: id });
      }
      return id;
    },

    /** ICE 信令转发 */
    signal(fromConnId, msg) {
      if (closed) return;
      const from = peers.get(fromConnId);
      if (!from || !msg || !msg.to) return;
      for (const [c, p] of peers) {
        if (p.id === msg.to && c !== fromConnId) {
          send(c, { t: 'sig', from: from.id, data: msg.data });
        }
      }
    },

    /** 成员离开；房主离开 => 关闭整间 */
    leave(connId) {
      const p = peers.get(connId);
      if (!p) return;
      peers.delete(connId);

      if (p.id === hostId) {
        // 挂断即消：房主离开，通知所有剩余成员并关闭
        closed = true;
        for (const [c] of peers) send(c, { t: 'closed' });
        peers.clear();
        onEmpty();
        return;
      }

      for (const [c] of peers) send(c, { t: 'peer-left', id: p.id });
      if (peers.size === 0) { closed = true; onEmpty(); }
    }
  };
}
