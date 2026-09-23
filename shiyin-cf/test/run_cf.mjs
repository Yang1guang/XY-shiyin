/* =========================================================
   拾音 · 本地端到端测试（run_cf.mjs）
   在同机内模拟 Cloudflare 环境：
     - 一个 Node http 服务器：静态资源 + /api/turn + WS /ws
     - WS 信令直接复用 src/room-core.js（与 Durable Object 同源）
   然后用 puppeteer 起 3 个设备上下文做一对一 + 群聊互连验证。
   全部通过后退出码为 0。
   ========================================================= */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import puppeteer from 'puppeteer-core';
import { createRoom, MAX_SOLO, MAX_GROUP } from '../src/room-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(__dirname, '../public');
const PORT = Number(process.env.PORT || 8231);
const BASE = `http://127.0.0.1:${PORT}/`;

const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 15; 23127PN0CC Build/AP3A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const UA_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

const DEV = {
  mac:    { ua: UA_MAC,     vp: { width: 1440, height: 900, deviceScaleFactor: 2, isMobile: false, hasTouch: false }, label: 'Mac 电脑 (1440x900)' },
  iphone: { ua: UA_IPHONE,  vp: { width: 393,  height: 852, deviceScaleFactor: 3, isMobile: true,  hasTouch: true },  label: 'iPhone 14 Pro (393x852)' },
  xiaomi: { ua: UA_ANDROID, vp: { width: 412,  height: 915, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true }, label: '小米 17 / Android (412x915)' }
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const WATCH = Number(process.env.WATCH_MS || 220000);
const wd = setTimeout(() => { log('[watchdog] 超时退出'); process.exit(2); }, WATCH);
wd.unref();

async function setDev(page, key) { const d = DEV[key]; await page.setUserAgent(d.ua); await page.setViewport(d.vp); }
async function nav(page, url) {
  page.setDefaultNavigationTimeout(60000);
  for (let i = 0; i < 3; i++) {
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); return; }
    catch (e) { log('  [nav retry ' + (i + 1) + '] ' + e.message); await sleep(1500); }
  }
  throw new Error('导航失败: ' + url);
}
async function waitFor(fn, timeout, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await fn()) return true; await sleep(500); }
  throw new Error('TIMEOUT: ' + label);
}
// 通过可见视图判断是否在通话中（不依赖任何调试钩子）
async function view(page) {
  return await page.evaluate(() => {
    const ids = ['idle','host','join','live','reconnect','gwait','glive','expired','ended','busy','error'];
    for (const id of ids) { const el = document.getElementById('view-' + id); if (el && !el.classList.contains('hidden')) return id; }
    return null;
  });
}
async function timer(page) {
  return await page.evaluate(() => { const t = document.getElementById('timer'); return t ? t.textContent : null; });
}
async function gcount(page) {
  return await page.evaluate(() => { const t = document.getElementById('gcount2') || document.getElementById('gcount'); return t ? t.textContent : null; });
}

(async () => {
  // ── 静态资源 + 信令服务器 ──
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
    if (p === '/') p = '/index.html';
    if (p === '/api/turn') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ iceServers: [
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'stun:stun.l.google.com:19302' }
      ] }));
      return;
    }
    const f = path.join(PUBLIC, p);
    fs.readFile(f, (err, data) => {
      if (err) { res.writeHead(404); res.end('nf'); return; }
      const ext = path.extname(f);
      const ct = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.js' ? 'text/javascript' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': ct });
      res.end(data);
    });
  });

  // 每个房间码一个 room 实例（与 DO 一一对应）
  const rooms = new Map();
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws') { socket.destroy(); return; }
    const room = (url.searchParams.get('room') || '').toUpperCase();
    const mode = url.searchParams.get('mode') === 'group' ? 'group' : 'solo';
    if (!room || room.length < 4) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const key = mode + ':' + room;
      if (!rooms.has(key) || rooms.get(key).isClosed()) {
        const max = mode === 'group' ? MAX_GROUP : MAX_SOLO;
        const conns = new Map();
        const room0 = createRoom({
          max,
          send(connId, obj) { const s = conns.get(connId); if (s && s.readyState === 1) { try { s.send(JSON.stringify(obj)); } catch (e) {} } },
          onEmpty() { rooms.delete(key); }
        });
        rooms.set(key, Object.assign(room0, { _conns: conns }));
      }
      const roomObj = rooms.get(key);
      const connId = 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      roomObj._conns.set(connId, ws);
      roomObj.join(connId);
      ws.on('message', (buf) => { let m; try { m = JSON.parse(buf.toString()); } catch (e) { return; } if (m && m.t === 'sig') roomObj.signal(connId, m); });
      const cleanup = () => { roomObj._conns.delete(connId); roomObj.leave(connId); };
      ws.on('close', cleanup); ws.on('error', cleanup);
    });
  });

  await new Promise(r => server.listen(PORT, '127.0.0.1', r));

  const results = { solo: false, group: false, details: {} };
  const consoleErrs = [];
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium', headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
      '--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required','--allow-running-insecure-content',
      '--ignore-certificate-errors']
  });
  const hook = (p, tag) => {
    p.on('console', m => { if (m.type() === 'error') consoleErrs.push(tag + ': ' + m.text()); });
    p.on('pageerror', e => consoleErrs.push(tag + ' PAGEERROR: ' + e.message));
  };

  try {
    // ===== 测试 1：一对一（Mac 发起 → iPhone 通过链接加入）=====
    log('\n=== 测试 1：一对一通话（Mac 发起 → iPhone 14 Pro 加入）===');
    const A = await browser.newPage(); await setDev(A, 'mac'); hook(A, 'Mac');
    await nav(A, BASE);
    await A.click('#btn-create');
    await waitFor(async () => /^[A-Z0-9]{6}$/.test(await A.evaluate(() => document.getElementById('room-code').textContent)), 20000, 'Mac 生成房间号');
    const room = await A.evaluate(() => document.getElementById('room-code').textContent.trim());
    log('Mac 创建房间号:', room, '| 视图:', await view(A));

    const B = await browser.newPage(); await setDev(B, 'iphone'); hook(B, 'iPhone');
    await nav(B, BASE + '#' + room);
    log('iPhone 打开邀请链接，视图:', await view(B));
    await B.click('#btn-join');

    await waitFor(async () => (await view(A)) === 'live' && (await view(B)) === 'live', 60000, '一对一双方接通');
    await sleep(2600);
    const av = await view(A), bv = await view(B), at = await timer(A), bt = await timer(B);
    log('Mac    视图:', av, '| 计时:', at);
    log('iPhone 视图:', bv, '| 计时:', bt);
    results.solo = av === 'live' && bv === 'live';
    results.details.solo = { room, macView: av, iphoneView: bv, macTimer: at, iphoneTimer: bt };
    await A.evaluate(() => document.getElementById('btn-end').click());
    await B.evaluate(() => document.getElementById('btn-end').click());
    await A.close(); await B.close();

    // ===== 测试 2：群聊（Mac 主机 + iPhone + 小米）=====
    log('\n=== 测试 2：群聊通话（Mac 主机 + iPhone 14 Pro + 小米 17）===');
    const G1 = await browser.newPage(); await setDev(G1, 'mac'); hook(G1, 'MacG');
    await nav(G1, BASE);
    await G1.click('#btn-group');
    await waitFor(async () => /^[A-Z0-9]{6}$/.test(await G1.evaluate(() => document.getElementById('room-code-g').textContent)), 20000, 'Mac 生成群聊房间号');
    const groot = await G1.evaluate(() => document.getElementById('room-code-g').textContent.trim());
    log('Mac 创建群聊房间号:', groot);

    const G2 = await browser.newPage(); await setDev(G2, 'iphone'); hook(G2, 'iPhoneG');
    await nav(G2, BASE + '?mode=group#' + groot);
    await G2.click('#btn-join');

    const G3 = await browser.newPage(); await setDev(G3, 'xiaomi'); hook(G3, 'XiaomiG');
    await nav(G3, BASE + '?mode=group#' + groot);
    await G3.click('#btn-join');

    await waitFor(async () => (await view(G1)) === 'glive' && (await view(G2)) === 'glive' && (await view(G3)) === 'glive', 90000, '群聊三方互连');
    await sleep(1500);
    const g1 = await view(G1), g2 = await view(G2), g3 = await view(G3);
    const c1 = await gcount(G1), c2 = await gcount(G2), c3 = await gcount(G3);
    log('Mac    群聊视图:', g1, '| 成员:', c1);
    log('iPhone 群聊视图:', g2, '| 成员:', c2);
    log('小米   群聊视图:', g3, '| 成员:', c3);
    results.group = g1 === 'glive' && g2 === 'glive' && g3 === 'glive' && c1 === '3 / 4' && c2 === '3 / 4' && c3 === '3 / 4';
    results.details.group = { room: groot, mac: { view: g1, count: c1 }, iphone: { view: g2, count: c2 }, xiaomi: { view: g3, count: c3 } };
    await G1.close(); await G2.close(); await G3.close();
  } catch (e) {
    results.error = e.message; log('测试异常:', e.message);
  } finally {
    await browser.close();
    server.close();
  }

  log('\n================ 结果 ================');
  log('一对一互连:', results.solo ? 'PASS' : 'FAIL');
  log('群聊互连  :', results.group ? 'PASS' : 'FAIL');
  log('控制台错误数:', consoleErrs.length);
  consoleErrs.slice(0, 15).forEach(e => log('  ·', e));
  fs.writeFileSync(path.resolve(__dirname, 'result.json'), JSON.stringify({ results, consoleErrs }, null, 2));
  clearTimeout(wd);
  process.exit(results.solo && results.group ? 0 : 1);
})();
