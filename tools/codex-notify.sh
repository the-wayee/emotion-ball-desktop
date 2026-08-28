#!/bin/bash
# ============================================================
# codex-notify.sh —— Codex notify 的分发包装
#
# Codex 的 config.toml 只能配一个 notify 程序，直接换成桌宠会顶掉
# 原有的通知程序。这个脚本先把参数原样转给原程序，再通知桌宠，
# 两边都不耽误。
#
#   notify = ["/绝对路径/tools/codex-notify.sh", "turn-ended"]
#
# Codex 会在参数末尾追加一段 JSON（type=agent-turn-complete 等），
# 这里取最后一个参数发给桌宠的 /agent。
# ============================================================
set -u

# 原来的通知程序；不需要就把这行留空
ORIGINAL="/Users/a123/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient"

# 先转发给原程序，失败也不影响后面
if [ -n "$ORIGINAL" ] && [ -x "$ORIGINAL" ]; then
  "$ORIGINAL" "$@" >/dev/null 2>&1 || true
fi

# 最后一个参数是 Codex 塞进来的 JSON
PAYLOAD="${!#:-}"
case "$PAYLOAD" in
  '{'*)  ;;                       # 看着像 JSON 才发
  *) PAYLOAD='{"type":"turn-ended"}' ;;
esac

# 桌宠没开时静默失败，绝不拖住 Codex
curl -s -m 2 -X POST http://127.0.0.1:17817/agent \
  -H 'Content-Type: application/json' \
  -d "$PAYLOAD" >/dev/null 2>&1 || true

exit 0
