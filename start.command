#!/bin/sh
# ============================================================
# LaunchPad · 项目启动面板 — macOS 双击启动入口
# 用法: 在 Finder 中双击本文件（首次使用先执行一次:
#       chmod +x start.command start.sh stop.sh
# ）。
# 前台运行：日志滚动显示，Ctrl+C 或关闭终端窗口即停止面板。
# 想后台常驻请用: sh start.sh（停止: sh stop.sh）
# ============================================================
cd "$(dirname "$0")" || exit 1

# 双击 .command 的默认 PATH 不含 Homebrew / nvm 安装的 node，做一次兜底
if ! command -v node >/dev/null 2>&1; then
  for p in /usr/local/bin /opt/homebrew/bin "$HOME/.nvm/versions/node"/*/bin; do
    if [ -x "$p/node" ]; then
      PATH="$p:$PATH"
      export PATH
      break
    fi
  done
fi

echo "[LaunchPad] 面板前台启动中…（Ctrl+C 或关闭窗口停止；项目进程不受影响，下次启动自动接管）"
# LP_OPEN=1：服务就绪后由 server 自行调用系统浏览器打开面板
LP_OPEN=1 exec node server.js
