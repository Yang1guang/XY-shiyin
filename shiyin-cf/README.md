# 拾音 · 免注册即时语音通话（Cloudflare 原生版）

复刻自 GhostCall（免注册、挂断即消的网页语音通话），中文界面、浅色商业主题，
**信令与 ICE 全部跑在 Cloudflare**：一个 Worker + 一个 Durable Object + 静态资源，
前端用**原生 WebRTC**（不再依赖 PeerJS 公共云）。

---

## 一、目录结构

```
shiyin-cf/
├── wrangler.toml          # Cloudflare 部署配置（Worker / DO / 静态资源 / 变量）
├── package.json
├── deploy.sh              # 一键部署脚本
├── README.md
├── src/
│   ├── worker.js          # Worker 入口：静态资源 + /ws 信令 + /api/turn + /api/config
│   ├── signaling.js       # Durable Object：每个房间码一个实例
│   ├── room-core.js       # 房间核心（Node 测试与 DO 共用，保证语义一致）
│   └── turn.js            # ICE 服务器下发（STUN / CF 托管 TURN / 自建 coturn）
├── public/
│   └── index.html         # 前端单页（原生 WebRTC + WebSocket，11 个状态视图）
└── test/
    ├── run_cf.mjs         # 本地端到端测试（Node WS 信令 + puppeteer 三设备）
    └── result.json        # 测试结果（运行后生成）
```

---

## 二、工作方式（原理）

```
浏览器A ──┐                                   ┌── 浏览器B
          │  ① WebSocket /ws?room=CODE        │
          ├────────────► Worker ─► Durable Object（SignalingRoom）
          │                        （每个房间码一个实例）
          │  ② 交换 SDP / ICE candidate（点对点透传）
          │◄───────────────┘                   │
          │                                   │
          └──────► WebRTC 音频（P2P 直连，P2P 失败自动走 TURN 中继）◄──┘
```

- **信令（Signaling）**：只负责“牵线”——交换双方的 SDP 与 ICE 候选。本方案用
  Cloudflare Worker 的 WebSocket 路由到 Durable Object，房间状态由 DO 天然隔离与保活。
- **媒体（Media）**：音频流走 WebRTC **点对点**；打洞失败时通过 TURN 中继。
- **STUN/TURN**：`/api/turn` 下发。STUN 用于发现公网地址，TURN 用于中继兜底。
- **挂断即消**：房主（第一个加入者）断开时，服务端立即关闭整间并通知所有成员，
  不落任何通话记录。

### 信令协议（JSON）

| 方向 | 消息 | 说明 |
|------|------|------|
| C→S | `{t:"sig",to:<id>,data:{sdp\|candidate}}` | 转发给指定成员 |
| S→C | `{t:"joined",id,host,peers:[...]}` | 加入成功 + 现有成员名单 |
| S→C | `{t:"peer-joined",id}` | 有新成员加入 |
| S→C | `{t:"peer-left",id}` | 某成员离开 |
| S→C | `{t:"sig",from,data}` | 收到某成员的信令 |
| S→C | `{t:"full"}` | 房间已满 |
| S→C | `{t:"closed"}` | 房间已关闭（房主挂断 / 已失效） |

> 确定性协商：`peerId` 字典序较小的一方发起 offer，避免双方同时 offer 冲突。

---

## 三、部署步骤

### 0. 准备
- Node.js ≥ 18
- 一个 Cloudflare 账号（免费版即可）

```bash
npm install -g wrangler      # 或直接用 npx wrangler
wrangler login               # 浏览器授权登录
```

### 1. 本地预览
```bash
cd shiyin-cf
npx wrangler dev
# 打开 http://localhost:8787
```

### 2. 一键部署
```bash
bash deploy.sh
# 或：npx wrangler deploy
```
部署完成后会输出形如 `https://shiyin.<你的子域>.workers.dev` 的地址，直接访问即可。

### 3. （可选）绑定自有域名
在 Cloudflare Dashboard → Workers → shiyin → Settings → Domains & Routes 添加自定义域名。

---

## 四、配置 TURN（跨运营商 / 严格 NAT 场景建议）

默认只下发 STUN，同一局域网或大多数家用网络可直接 P2P 通话。
若需跨运营商稳定通话，二选一：

### 方案 A：Cloudflare Calls 托管 TURN（推荐，免运维）
1. Dashboard → Realtime（Calls）→ 创建 TURN Key，得到 `Key ID` 与 `API Token`。
2. 用 secret 保存（**不要写进 wrangler.toml**）：
```bash
npx wrangler secret put CF_TURN_KEY_ID
npx wrangler secret put CF_TURN_API_TOKEN
```
服务端会自动用 Token 换取短期凭证并随 `/api/turn` 下发，前端不接触长期密钥。

### 方案 B：自建 coturn
在 `wrangler.toml` 的 `[vars]` 段填写：
```toml
TURN_URL      = "turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:5349?transport=tcp"
TURN_USERNAME = "shiyin"
TURN_CREDENTIAL = "change-me"
```
> 生产环境建议改用 coturn 的 REST API 动态凭证（`use-auth-secret`），
> 把生成逻辑放进 `src/turn.js` 的 `buildIceServers()` 即可。

---

## 五、环境变量一览（wrangler.toml `[vars]` / secret）

| 变量 | 作用 | 默认 |
|------|------|------|
| `STUN_URLS` | 逗号分隔的 STUN 列表 | Cloudflare + Google + 小米 + QQ |
| `MAX_GROUP` | 群聊人数上限 | `4` |
| `PREFIX` | 前端标识前缀 | `shiyin` |
| `RECONNECT_SECONDS` | 掉线重连倒计时 | `60` |
| `TURN_TTL` | CF 托管 TURN 凭证有效期（秒） | `86400` |
| `CF_TURN_KEY_ID` / `CF_TURN_API_TOKEN` | CF 托管 TURN（secret） | 未设置 |
| `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` | 自建 TURN | 未设置 |

---

## 六、本地测试

```bash
npm install
npm test          # = node test/run_cf.mjs
```
测试会在本机起一个 Node 服务器（静态资源 + `/ws` + `/api/turn`），
复用与 Durable Object **同一份** `room-core.js` 作为信令核心，
然后用 puppeteer 模拟 **Mac / iPhone 14 Pro / 小米 17** 三个设备，
分别验证一对一与三方群聊互连。全部通过时退出码为 0。

> 注意：这是功能隔离测试，使用本机假麦克风与本地信令，不触及任何线上生产资源。

---

## 七、注意事项

- **麦克风**：浏览器要求在 https（或 localhost）下才能采集麦克风，请用部署后的 https 地址。
- **页面保活**：通话期间需保持页面打开；已实现屏幕常亮（Wake Lock）与静音振荡器保活。
- **房间上限**：一对一 2 人，群聊 4 人（可在 `wrangler.toml` 调整 `MAX_GROUP`）。
- **合规**：仅供学习与自托管演示，请勿用于骚扰、诈骗等违法用途。
