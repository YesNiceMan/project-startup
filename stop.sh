#!/bin/sh
# ============================================================
# LaunchPad · 项目启动面板 — 停止后台实例
# 用法:  sh stop.sh
# 仅停止面板自身；运行中的项目进程独立存活，下次启动面板自动接管。
# ============================================================
cd "$(dirname "$0")" || exit 1

PID=""
if [ -f data/panel.pid ]; then
  PID=$(cat data/panel.pid 2>/dev/null)
fi

# pid 文件失效则按端口兜底探测
if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then
  PID=$(lsof -ti :7788 -sTCP:LISTEN 2>/dev/null | head -n 1)
fi

if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  kill "$PID" && echo "[LaunchPad] 面板已停止 (PID $PID)。运行中的项目不受影响。"
else
  echo "[LaunchPad] 未发现运行中的面板。"
fi
rm -f data/panel.pid
