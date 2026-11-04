#!/usr/bin/env bash
# Node 20 交付冒烟驱动脚本（CI 的 node20-smoke job 调用；本机亦可复现）。
#
# 前置：当前 Node（>=24，用于 pnpm 构建）已在 PATH；期望验证的 Node 20 二进制
# 通过 BOTD_NODE20_BIN 指定，未指定时优先用 setup-node 缓存的 20.0.0，
# 最后回退下载官方 20.0.0（这验证的是最早支持的版本）。
#
# 流程：构建 protocol + node -> pnpm pack 出两个 tarball -> 注入环境变量 ->
# 用当前 Node 跑 tests/node20-distribution.test.ts（真实执行部分全部由
# BOTD_NODE20_BIN 指定的 Node 20 完成）。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

: "${BOTD_NODE20_VERSION:=20.0.0}"
NODE20_DIR="${BOTD_NODE20_DIR:-$REPO_ROOT/.node20}"
NODE20_BIN="${BOTD_NODE20_BIN:-}"

if [[ -z "$NODE20_BIN" ]]; then
  # 统一下载官方二进制到缓存目录，版本默认为最早支持的 20.0.0：
  # 这能抓住只到 20.3+ 才可用的 API/语法。
  if [[ ! -x "$NODE20_DIR/bin/node" ]]; then
    echo "Downloading Node v$BOTD_NODE20_VERSION to $NODE20_DIR ..."
    TMP_EXTRACT="$(mktemp -d)"
    curl -fsSL "https://nodejs.org/dist/v$BOTD_NODE20_VERSION/node-v$BOTD_NODE20_VERSION-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m).tar.gz" \
      | tar -xz -C "$TMP_EXTRACT"
    rm -rf "$NODE20_DIR"
    mv "$TMP_EXTRACT"/node-v"$BOTD_NODE20_VERSION"-* "$NODE20_DIR"
  fi
  NODE20_BIN="$NODE20_DIR/bin/node"
fi

echo "Node 20 runtime: $($NODE20_BIN --version) ($NODE20_BIN)"
echo "Driver node:     $(node --version)"

# 1) 构建 + 打包（用工作区要求的当前 Node >=24）
pnpm install --frozen-lockfile
pnpm --filter @botd/protocol --filter @botd/node build

PROTOCOL_DIR="$REPO_ROOT/packages/protocol"
NODE_PKG_DIR="$REPO_ROOT/apps/node"
rm -f "$PROTOCOL_DIR"/*.tgz "$NODE_PKG_DIR"/*.tgz
(cd "$PROTOCOL_DIR" && pnpm pack >/dev/null)
(cd "$NODE_PKG_DIR" && pnpm pack >/dev/null)

export BOTD_NODE20_BIN="$NODE20_BIN"
export BOTD_PROTOCOL_TARBALL="$(ls "$PROTOCOL_DIR"/botd-protocol-*.tgz | head -n1)"
export BOTD_NODE_TARBALL="$(ls "$NODE_PKG_DIR"/botd-node-*.tgz | head -n1)"
echo "protocol tarball: $BOTD_PROTOCOL_TARBALL"
echo "node tarball:     $BOTD_NODE_TARBALL"

# 2) 行为冒烟：engines/依赖校验 + dist 语法检查 + Node 20 真实安装执行
exec node --import tsx --test "$REPO_ROOT/tests/node20-distribution.test.ts"
