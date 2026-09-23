#!/usr/bin/env bash
# =========================================================
# 拾音 · 一键部署到 Cloudflare Workers
# 用法： bash deploy.sh
# =========================================================
set -euo pipefail

cd "$(dirname "$0")"

echo "==> 检查环境"
if ! command -v node >/dev/null 2>&1; then
  echo "缺少 Node.js（>=18），请先安装：https://nodejs.org"; exit 1
fi
echo "    node $(node -v)"

echo "==> 安装依赖（wrangler）"
if [ ! -d node_modules ]; then
  npm install
else
  echo "    已存在 node_modules，跳过"
fi

echo "==> 登录 Cloudflare（若已登录会自动跳过）"
npx wrangler whoami || npx wrangler login

echo "==> 部署 Worker + Durable Object + 静态资源"
npx wrangler deploy

echo ""
echo "✅ 部署完成。访问上面的 workers.dev 地址即可使用。"
echo "   如需启用托管 TURN："
echo "     npx wrangler secret put CF_TURN_KEY_ID"
echo "     npx wrangler secret put CF_TURN_API_TOKEN"
