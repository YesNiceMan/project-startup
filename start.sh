#!/bin/sh
# ============================================================
# LaunchPad · 项目启动面板 — macOS / Linux 后台启动
# 用法:  sh start.sh      （后台启动，日志写入 data/panel.log）
# 停止:  sh stop.sh
# 首次使用:  chmod +x start.sh start.command stop.sh
# ============================================================
cd "$(dirname "$0")" || exit 1

# node 路径兜底：非交互 shell 的 PATH 可能不含 Homebrew / nvm 安装的 node
if ! command -v node >/dev/null 2>&1; then
  for p in /usr/local/bin /opt/homebrew/bin "$HOME/.nvm/versions/node"/*/bin; do
    if [ -x "$p/node" ]; then
      PATH="$p:$PATH"
      export PATH
      break
    fi
  done
fi

BASE=http://127.0.0.1:7788
# 已在运行？只打开浏览器，不重复启动（与 Windows start.bat 行为一致）
if curl -s -o /dev/null --max-time 2 "$BASE/"; then
  echo "[LaunchPad] 面板已在运行，正在打开浏览器…"
  open "$BASE" 2>/dev/null || xdg-open "$BASE" 2>/dev/null || true
  exit 0
fi

mkdir -p data
# LP_OPEN=1：服务就绪后由 server 自行调用系统浏览器打开面板
LP_OPEN=1 nohup node server.js >> data/panel.log 2>&1 &
echo $! > data/panel.pid
echo "[LaunchPad] 面板后台启动中 (PID $(cat data/panel.pid))，浏览器将自动打开。"
echo "  日志: data/panel.log · 停止: sh stop.sh"
