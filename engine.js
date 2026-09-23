/* =========================================================
   拾音 · 前端信令引擎（原生 WebRTC + WebSocket）
   —— 云原生部署版，替换了纯静态版里的 PeerJS。
   与 src/room-core.js 的协议严格对应，服务端由 Cloudflare
   Durable Object 承载；本地测试用同一份 room-core.js。

   设计要点：
   - 每个对端一条 RTCPeerConnection（网状）
   - 确定性协商：peerId 字典序较小的一方发起 offer，避免同时 offer
   - 挂断即消：房主离开由服务端关闭房间，前端收到 closed 即结束
   - 群聊邀请链接带 ?mode=group，用于区分一对一
   ========================================================= */
(function () {
  "use strict";

  var CFG = Object.assign({
    prefix: "shiyin",
    maxGroup: 4,
    reconnectSeconds: 60,
    codeChars: "ABCDEFGHJKMNPQRSTUVWXYZ23456789",
    wsPath: "/ws",
    turnPath: "/api/turn",
    iceServers: [
      { urls: "stun:stun.cloudflare.com:3478" },
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun.miwifi.com:3478" },
      { urls: "stun:stun.qq.com:3478" }
    ]
  }, window.__SHIYIN__ || {});

  var $ = function (id) { return document.getElementById(id); };
  var VIEWS = ["idle", "host", "join", "live", "reconnect", "gwait", "glive", "expired", "ended", "busy", "error"];

  var st = {
    view: "idle", mode: "solo", pendingMode: "solo", isHost: false, roomId: null,
    selfId: null, ws: null, wsIntended: false, reconnecting: false,
    pcs: {}, pending: {}, remote: {}, names: {}, audioEls: {},
    localStream: null, muted: false, inCall: false, soloPeerId: null,
    timer: 0, timerId: null, qualityId: null, reconnectId: null, reconnectLeft: 0,
    pendingJoinCode: null
  };

  var _wake = null, _ctx = null, _osc = null;

  function show(name) {
    st.view = name;
    VIEWS.forEach(function (v) {
      var el = $("view-" + v);
      if (el) el.classList.toggle("hidden", v !== name);
    });
    try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch (e) {}
  }

  function setNet(state, label) {
    var n = $("net"), l = $("net-label");
    if (n) n.className = "net " + (state || "");
    if (l) l.textContent = label || "在线";
  }

  /* ── 工具 ── */
  function genCode() {
    var out = "";
    for (var i = 0; i < 6; i++) out += CFG.codeChars.charAt(Math.floor(Math.random() * CFG.codeChars.length));
    return out;
  }
  function randName() {
    var pool = ["青柠", "海盐", "远山", "晚风", "晨曦", "松林", "白露", "星野", "拾光", "松果", "云杉", "竹影"];
    return pool[Math.floor(Math.random() * pool.length)] + "·" + Math.floor(Math.random() * 90 + 10);
  }
  function setHash(code) { try { window.history.replaceState(null, "", "#" + code); } catch (e) {} }
  function clearHash() { try { window.history.replaceState(null, "", window.location.pathname + window.location.search); } catch (e) {} }
  function hashCode() {
    var h = (window.location.hash || "").slice(1);
    return h.length >= 4 ? h.toUpperCase() : null;
  }
  function baseUrl() { return window.location.href.split("#")[0].split("?")[0]; }
  function shareLink(code, mode) {
    return baseUrl() + (mode === "group" ? "?mode=group" : "") + "#" + code;
  }
  function fmt(s) { var m = Math.floor(s / 60), x = s % 60; return m + ":" + (x < 10 ? "0" : "") + x; }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).catch(function () {});
    return Promise.resolve();
  }
  function tryPlay(el) { if (!el) return; var p = el.play(); if (p && p.catch) p.catch(function () {}); }
  function initAudioCtx() {
    try {
      if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (_ctx.state === "suspended") _ctx.resume();
    } catch (e) {}
  }

  /* ── 麦克风 ── */
  function getMic() {
    if (st.localStream) return Promise.resolve(true);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError("当前浏览器不支持麦克风采集，请更换现代浏览器后重试。");
      return Promise.resolve(false);
    }
    return navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      .then(function (stream) { st.localStream = stream; return true; })
      .catch(function (e) {
        showError("麦克风权限被拒绝。请允许麦克风访问后重试。(" + (e && e.name ? e.name : "unknown") + ")");
        return false;
      });
  }

  /* ── ICE 服务器：优先用服务端下发（含 TURN 凭证）── */
  function loadIce() {
    return fetch(CFG.turnPath, { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.iceServers && d.iceServers.length) CFG.iceServers = d.iceServers; })
      .catch(function () {});
  }

  /* ── WebSocket 信令 ── */
  function wsUrl(code, mode) {
    var proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return proto + "//" + window.location.host + CFG.wsPath + "?room=" + encodeURIComponent(code) + "&mode=" + mode;
  }

  function connectSignaling(code, mode) {
    return new Promise(function (resolve, reject) {
      var ws;
      try { ws = new WebSocket(wsUrl(code, mode)); } catch (e) { reject(new Error("WS_INIT")); return; }
      st.ws = ws; st.wsIntended = true;
      var opened = false;
      ws.onopen = function () { opened = true; setNet("", "在线"); resolve(ws); };
      ws.onmessage = function (ev) {
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        onSignalMessage(m);
      };
      ws.onclose = function () {
        if (!opened) { reject(new Error("WS_CLOSED")); return; }
        setNet("connecting", "连接中断");
        if (st.wsIntended) scheduleWsReconnect();
      };
      ws.onerror = function () { if (!opened) reject(new Error("WS_ERROR")); };
      setTimeout(function () { if (!opened) reject(new Error("WS_TIMEOUT")); }, 12000);
    });
  }

  function scheduleWsReconnect() {
    if (st.reconnecting) return;
    st.reconnecting = true;
    setNet("connecting", "重连中");
    setTimeout(function () {
      st.reconnecting = false;
      if (!st.wsIntended || !st.roomId) return;
      connectSignaling(st.roomId, st.mode).then(function () { setNet("", "在线"); })
        .catch(function () { scheduleWsReconnect(); });
    }, 1200);
  }

  function sendSig(to, data) {
    if (st.ws && st.ws.readyState === 1) st.ws.send(JSON.stringify({ t: "sig", to: to, data: data }));
  }

  function onSignalMessage(m) {
    switch (m.t) {
      case "joined": onJoined(m); break;
      case "peer-joined": onPeerJoined(m.id); break;
      case "peer-left": onPeerLeft(m.id); break;
      case "sig": handleSignal(m.from, m.data); break;
      case "full":
        closeSignaling(); cleanup(true); show("busy");
        break;
      case "closed":
        closeSignaling();
        if (st.inCall || st.view === "live" || st.view === "glive") onCallEnded();
        else { cleanup(true); show("expired"); }
        break;
    }
  }

  function onJoined(m) {
    st.selfId = m.id;
    st.isHost = !!m.host;
    if (!st.names[st.selfId]) st.names[st.selfId] = "我";
    (m.peers || []).forEach(function (pid) { ensurePeerName(pid); setupPeer(pid); });
    if (st.mode === "group") {
      renderRoster();
      show(st.inCall ? "glive" : "gwait");
    } else {
      if (st.isHost) show("host");
      // 非房主：等待确定性协商完成，保持邀请视图直到接通
    }
  }

  function onPeerJoined(pid) {
    ensurePeerName(pid);
    if (st.view === "reconnect") clearInterval(st.reconnectId);
    setupPeer(pid);
    if (st.mode === "group") {
      renderRoster();
      if (st.inCall) show("glive"); else show("gwait");
    }
  }

  function onPeerLeft(pid) {
    teardownPeer(pid);
    if (st.mode === "group") {
      renderRoster();
    } else if (st.inCall) {
      onPartnerLost();
    }
  }

  function ensurePeerName(pid) {
    if (!st.names[pid]) st.names[pid] = randName();
  }

  /* ── 逐对端连接 ── */
  function setupPeer(pid) {
    if (st.pcs[pid]) return st.pcs[pid];
    var pc = new RTCPeerConnection({ iceServers: CFG.iceServers });
    st.pcs[pid] = pc;
    st.pending[pid] = [];
    if (st.localStream) {
      st.localStream.getTracks().forEach(function (t) { try { pc.addTrack(t, st.localStream); } catch (e) {} });
    }
    pc.onicecandidate = function (e) { if (e.candidate) sendSig(pid, { candidate: e.candidate }); };
    pc.ontrack = function (e) { attachRemote(pid, e.streams[0]); };
    pc.onconnectionstatechange = function () {
      var s = pc.connectionState;
      if (s === "connected") onPeerConnected(pid);
      else if (s === "failed" || s === "disconnected" || s === "closed") onPeerDropped(pid);
    };
    if (st.selfId && st.selfId < pid) {
      pc.createOffer().then(function (o) { return pc.setLocalDescription(o); })
        .then(function () { sendSig(pid, { sdp: pc.localDescription }); })
        .catch(function () {});
    }
    return pc;
  }

  function teardownPeer(pid) {
    var pc = st.pcs[pid];
    if (pc) { try { pc.close(); } catch (e) {} delete st.pcs[pid]; }
    delete st.pending[pid];
    if (st.audioEls[pid]) { try { st.audioEls[pid].srcObject = null; st.audioEls[pid].remove(); } catch (e) {} delete st.audioEls[pid]; }
    delete st.remote[pid];
    if (st.soloPeerId === pid) st.soloPeerId = null;
  }

  function handleSignal(from, data) {
    if (!data) return;
    var pc = st.pcs[from] || setupPeer(from);
    if (data.sdp) {
      pc.setRemoteDescription(data.sdp).then(function () {
        flushCandidates(from);
        if (data.sdp.type === "offer") {
          return pc.createAnswer().then(function (a) { return pc.setLocalDescription(a); })
            .then(function () { sendSig(from, { sdp: pc.localDescription }); });
        }
      }).catch(function () {});
    } else if (data.candidate) {
      if (pc.remoteDescription && pc.remoteDescription.type) pc.addIceCandidate(data.candidate).catch(function () {});
      else (st.pending[from] = st.pending[from] || []).push(data.candidate);
    }
  }

  function flushCandidates(pid) {
    var pc = st.pcs[pid]; var list = st.pending[pid] || [];
    st.pending[pid] = [];
    list.forEach(function (c) { try { pc.addIceCandidate(c).catch(function () {}); } catch (e) {} });
  }

  function attachRemote(pid, stream) {
    st.remote[pid] = stream;
    if (st.mode === "solo") {
      var ra = $("remote-audio");
      if (ra) { ra.srcObject = stream; tryPlay(ra); }
    } else {
      var a = st.audioEls[pid];
      if (!a) {
        a = document.createElement("audio");
        a.autoplay = true; a.playsInline = true;
        st.audioEls[pid] = a;
        var box = $("group-audio"); if (box) box.appendChild(a);
      }
      a.srcObject = stream; tryPlay(a);
    }
  }

  function onPeerConnected(pid) {
    if (st.mode === "solo") { st.soloPeerId = pid; onConnect(); }
    else if (!st.inCall) { onConnect(); }
  }

  function onPeerDropped(pid) {
    teardownPeer(pid);
    if (st.inCall) {
      if (st.mode === "group") {
        renderRoster();
        if (Object.keys(st.pcs).length === 0) onPartnerLost();
      } else onPartnerLost();
    }
  }

  /* ── 通话生命周期 ── */
  function startTimer() {
    st.timer = 0; clearInterval(st.timerId);
    st.timerId = setInterval(function () {
      st.timer++;
      var t = $("timer"), g = $("gtimer");
      if (t) t.textContent = fmt(st.timer);
      if (g) g.textContent = fmt(st.timer);
    }, 1000);
  }
  function stopTimer() { clearInterval(st.timerId); st.timerId = null; }

  function onConnect() {
    var wasInCall = st.inCall;
    st.inCall = true;
    clearInterval(st.reconnectId);
    if (st.mode === "solo") { show("live"); startTimer(); startQuality(); startKeepAlive(); }
    else { renderRoster(); show("glive"); if (!wasInCall) startTimer(); }
  }

  function startQuality() { clearInterval(st.qualityId); st.qualityId = setInterval(checkQuality, 3000); }
  function checkQuality() {
    var pc = st.soloPeerId ? st.pcs[st.soloPeerId] : null;
    if (!pc) return;
    pc.getStats().then(function (stats) {
      var rtt = 0, loss = 0, has = false;
      stats.forEach(function (r) {
        if (r.type === "remote-inbound-rtp" && r.kind === "audio") {
          rtt = r.roundTripTime || 0;
          var pl = r.packetsLost || 0, pr = r.packetsReceived || 1;
          loss = pl / (pl + pr) * 100; has = true;
        }
      });
      if (!has) return;
      var q = $("quality"), lbl = $("quality-lbl");
      if (!q) return;
      if (rtt < 0.15 && loss < 2) { q.className = "quality good"; lbl.textContent = "良好"; }
      else if (rtt < 0.4 && loss < 8) { q.className = "quality fair"; lbl.textContent = "一般"; }
      else { q.className = "quality poor"; lbl.textContent = "较差"; }
    }).catch(function () {});
  }

  function onPartnerLost() {
    if (st.view === "reconnect") return;
    st.inCall = false;
    stopTimer(); clearInterval(st.qualityId); st.qualityId = null;
    st.reconnectLeft = CFG.reconnectSeconds;
    var cd = $("countdown"); if (cd) cd.textContent = st.reconnectLeft;
    var bw = $("btn-wait"); if (bw) { bw.textContent = "继续等待"; bw.disabled = false; }
    show("reconnect");
    clearInterval(st.reconnectId);
    st.reconnectId = setInterval(function () {
      st.reconnectLeft--;
      var c = $("countdown"); if (c) c.textContent = st.reconnectLeft;
      if (st.reconnectLeft <= 0) { clearInterval(st.reconnectId); onCallEnded(); }
    }, 1000);
    if (st.mode === "solo" && st.soloPeerId && st.ws && st.ws.readyState === 1) {
      var pid = st.soloPeerId;
      teardownPeer(pid);
      setTimeout(function () { ensurePeerName(pid); setupPeer(pid); }, 800);
    }
  }

  function onCallEnded() {
    st.inCall = false;
    stopTimer(); clearInterval(st.qualityId); clearInterval(st.reconnectId); stopKeepAlive();
    var ft = $("final-timer"); if (ft) ft.textContent = fmt(st.timer);
    show("ended");
    cleanup(false);
  }

  function cleanup(resetUrl) {
    st.inCall = false;
    stopTimer();
    clearInterval(st.qualityId); st.qualityId = null;
    clearInterval(st.reconnectId); st.reconnectId = null;
    stopKeepAlive();
    Object.keys(st.pcs).forEach(function (pid) { teardownPeer(pid); });
    st.pcs = {}; st.pending = {}; st.remote = {}; st.audioEls = {};
    if (st.localStream) { try { st.localStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} st.localStream = null; }
    var ra = $("remote-audio"); if (ra) ra.srcObject = null;
    var ga = $("group-audio"); if (ga) ga.innerHTML = "";
    if (resetUrl) { clearHash(); st.roomId = null; st.isHost = false; st.selfId = null; st.soloPeerId = null; st.names = {}; }
  }

  function closeSignaling() {
    st.wsIntended = false;
    if (st.ws) { try { st.ws.close(); } catch (e) {} st.ws = null; }
  }

  function showError(msg) {
    var e = $("error-msg"); if (e) e.textContent = msg || "出现了一些问题。";
    closeSignaling(); cleanup(true); show("error");
  }
  function backToIdle() { closeSignaling(); cleanup(true); show("idle"); }

  /* ── 保活 ── */
  function startKeepAlive() {
    try { if ("wakeLock" in navigator && !_wake) navigator.wakeLock.request("screen").then(function (l) { _wake = l; }).catch(function () {}); } catch (e) {}
    try {
      initAudioCtx();
      if (!_osc) {
        _osc = _ctx.createOscillator();
        var g = _ctx.createGain(); g.gain.value = 0.0008;
        _osc.connect(g); g.connect(_ctx.destination); _osc.start();
      }
    } catch (e) {}
  }
  function stopKeepAlive() {
    try { if (_wake) { _wake.release(); _wake = null; } } catch (e) {}
    try { if (_osc) { _osc.stop(); _osc = null; } } catch (e) {}
  }

  /* ── 成员列表（群聊）── */
  function renderRoster() {
    var ids = [st.selfId].concat(Object.keys(st.pcs));
    var n = ids.length;
    var g = $("gcount"), g2 = $("gcount2");
    if (g) g.textContent = n + " / " + CFG.maxGroup;
    if (g2) g2.textContent = n + " / " + CFG.maxGroup;
    var html = ids.map(function (id) {
      var name = st.names[id] || "成员";
      var isSelf = id === st.selfId;
      var ch = (name || "?").slice(0, 1);
      var live = isSelf || (st.pcs[id] && st.pcs[id].connectionState === "connected");
      return '<div class="person">' +
        '<span class="av">' + ch + '</span>' +
        '<span class="nm">' + name + (isSelf ? "（我）" : "") + '</span>' +
        '<span class="on ' + (live ? "yes" : "no") + '"></span>' +
        '</div>';
    }).join("");
    var pw = $("people-gwait"), pl = $("people-glive");
    if (pw) pw.innerHTML = html;
    if (pl) pl.innerHTML = html;
  }

  /* ================= 一对一 ================= */
  function startHost() {
    initAudioCtx();
    var btn = $("btn-create"); if (btn) btn.disabled = true;
    getMic().then(function (ok) {
      if (!ok) { if (btn) btn.disabled = false; return; }
      return loadIce().then(function () {
        var code = genCode();
        st.roomId = code; st.mode = "solo"; st.isHost = true; setHash(code); st.names = {};
        $("room-link").textContent = shareLink(code, "solo");
        $("room-code").textContent = code;
        var wa = $("share-wa");
        if (wa) wa.href = "https://wa.me/?text=" + encodeURIComponent("加入我的拾音通话（免注册）：" + shareLink(code, "solo"));
        copyText(shareLink(code, "solo")).then(function () { flashCopied(); });
        return connectSignaling(code, "solo").then(function () { show("host"); if (btn) btn.disabled = false; });
      });
    }).catch(function (err) {
      if (btn) btn.disabled = false;
      showError("连接失败，请稍后重试。" + (err && err.message ? "(" + err.message + ")" : ""));
    });
  }

  function joinRoom(code, mode) {
    mode = mode === "group" ? "group" : "solo";
    if (!code) return;
    initAudioCtx();
    var btn = $("btn-join"); if (btn) btn.disabled = true;
    getMic().then(function (ok) {
      if (!ok) { if (btn) btn.disabled = false; return; }
      return loadIce().then(function () {
        st.roomId = code; st.mode = mode; st.isHost = false; st.names = {};
        return connectSignaling(code, mode).then(function () { if (btn) btn.disabled = false; });
      });
    }).catch(function (err) {
      if (btn) btn.disabled = false;
      showError("无法加入通话，可能链接已失效。" + (err && err.message ? "(" + err.message + ")" : ""));
    });
  }

  function flashCopied() {
    var c = $("copied"); if (!c) return;
    c.classList.remove("hidden");
    setTimeout(function () { c.classList.add("hidden"); }, 3200);
  }

  /* ================= 群聊 ================= */
  function startGroup() {
    initAudioCtx();
    var btn = $("btn-group"); if (btn) btn.disabled = true;
    getMic().then(function (ok) {
      if (!ok) { if (btn) btn.disabled = false; return; }
      return loadIce().then(function () {
        var code = genCode();
        st.roomId = code; st.mode = "group"; st.isHost = true; setHash(code); st.names = {};
        $("room-link-g").textContent = shareLink(code, "group");
        $("room-code-g").textContent = code;
        var wa = $("share-wa-g");
        if (wa) wa.href = "https://wa.me/?text=" + encodeURIComponent("加入我的拾音群聊通话（免注册）：" + shareLink(code, "group"));
        return connectSignaling(code, "group").then(function () { show("gwait"); renderRoster(); if (btn) btn.disabled = false; });
      });
    }).catch(function (err) {
      if (btn) btn.disabled = false;
      showError("连接失败，请稍后重试。" + (err && err.message ? "(" + err.message + ")" : ""));
    });
  }

  /* ================= 事件绑定 ================= */
  function bind() {
    var bc = $("btn-create"); if (bc) bc.onclick = startHost;
    var bg = $("btn-group"); if (bg) bg.onclick = startGroup;
    var bjc = $("btn-join-code"); if (bjc) bjc.onclick = function () { tryJoinFromInput("solo"); };
    var jc = $("join-code");
    if (jc) {
      jc.addEventListener("input", function () { this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); });
      jc.addEventListener("keydown", function (e) { if (e.key === "Enter") tryJoinFromInput("solo"); });
    }
    var bj = $("btn-join"); if (bj) bj.onclick = function () { joinRoom(hashCode() || st.pendingJoinCode, st.pendingMode); };
    var bcx = $("btn-cancel"); if (bcx) bcx.onclick = backToIdle;
    var bcg = $("btn-cancel-g"); if (bcg) bcg.onclick = backToIdle;
    var bm = $("btn-mute"); if (bm) bm.onclick = toggleMute;
    var bmg = $("btn-mute-g"); if (bmg) bmg.onclick = toggleMute;
    var be = $("btn-end"); if (be) be.onclick = function () { onCallEnded(); closeSignaling(); };
    var blg = $("btn-leave-g"); if (blg) blg.onclick = function () { onCallEnded(); closeSignaling(); };
    var be2 = $("btn-end2"); if (be2) be2.onclick = function () { onCallEnded(); closeSignaling(); };
    var bw = $("btn-wait"); if (bw) bw.onclick = function () { st.reconnectLeft = CFG.reconnectSeconds; };
    ["btn-new1", "btn-new2", "btn-new3", "btn-new4"].forEach(function (id) { var b = $(id); if (b) b.onclick = backToIdle; });
    var lb = $("linkbox"); if (lb) lb.onclick = function () { copyText(shareLink(st.roomId, "solo")); flashCopied(); };
    var lbg = $("linkbox-g"); if (lbg) lbg.onclick = function () { copyText(shareLink(st.roomId, "group")); };
    var bs = $("btn-share"); if (bs) bs.onclick = function () { copyText(shareLink(st.roomId, "solo")).then(function () { flashCopied(); }); };
    var bsg = $("btn-share-g"); if (bsg) bsg.onclick = function () { copyText(shareLink(st.roomId, "group")); };
    try {
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "visible" && st.inCall && "wakeLock" in navigator) {
          try { navigator.wakeLock.request("screen").then(function (l) { _wake = l; }).catch(function () {}); } catch (e) {}
        }
      });
    } catch (e) {}
  }

  function tryJoinFromInput(mode) {
    var jc = $("join-code");
    var code = (jc && jc.value ? jc.value : "").toUpperCase().trim();
    if (code.length < 4) {
      if (jc) { jc.style.borderColor = "var(--bad)"; jc.placeholder = "至少 4 位"; setTimeout(function () { jc.style.borderColor = ""; jc.placeholder = "6 位口令"; }, 1800); }
      return;
    }
    joinRoom(code, mode);
  }

  function toggleMute() {
    st.muted = !st.muted;
    if (st.localStream) st.localStream.getAudioTracks().forEach(function (t) { t.enabled = !st.muted; });
    ["btn-mute", "btn-mute-g"].forEach(function (id) { var b = $(id); if (b) b.textContent = st.muted ? "取消静音" : "静音"; });
  }

  /* ================= 启动 ================= */
  function init() {
    bind();
    try {
      var q = new URLSearchParams(window.location.search);
      st.pendingMode = q.get("mode") === "group" ? "group" : "solo";
    } catch (e) { st.pendingMode = "solo"; }
    var code = hashCode();
    if (code) {
      st.pendingJoinCode = code;
      var s = $("join-code-show"); if (s) s.textContent = code;
      show("join");
    } else {
      show("idle");
    }
    setNet("", "在线");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
