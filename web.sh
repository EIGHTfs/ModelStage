#!/bin/bash
# 新前端（src/web）启停脚本
# 用法: web.sh [start|stop|restart|status]   (默认 restart；未启动时 restart 相当于 start)
#
# 与 server.sh 的关系：
#   - server.sh 跑既有实现前端（dist/index.html，默认 8803），PID/日志为 spine-multi-viewer.*
#   - 本脚本跑重写版前端（src/web，默认 8804），PID/日志为 model-stage-web.*，两者互不干扰
#   - 新前端由 src/server/serve.mjs 独立提供（静态 + /api + /files + /icons + /live2d-lib），**不再反代 8803**
#
# 端口与上游都可用环境变量覆盖：
#   PORT=8804 bash web.sh restart

set -u
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 自身绝对路径：restart 分支要用它自调用（"$0" 在 `bash web.sh` 下只是相对名，直接执行会 command not found）
SELF="$PROJECT_ROOT/$(basename "${BASH_SOURCE[0]}")"
# 源码权限预检：服务端读不到模块时，日志里只有 404/空页面，很难联想到"文件权限"。
#   这里是**启动前**的最后一道提醒（不阻止启动，只把原因直接打出来，省掉一轮瞎查）。
if command -v node >/dev/null 2>&1; then
  PERM_MSG="$(node "$PROJECT_ROOT/tool/lib/check-perms.mjs" "$PROJECT_ROOT" 2>&1)" || {
    echo "[web.sh] ⚠️  源码权限预检警告：" >&2
    echo "$PERM_MSG" >&2
  }
fi

PORT="${PORT:-8804}"
RUNTIME_DIR="$PROJECT_ROOT/runtime"
mkdir -p "$RUNTIME_DIR"
PID_FILE="$RUNTIME_DIR/model-stage-web.pid"
LOG_FILE="$RUNTIME_DIR/model-stage-web.log"
ENTRY="$PROJECT_ROOT/src/server/serve.mjs"

# node 路径按实际环境探测（NAS 重启后 /var/packages 路径可能失效，不能写死）
probe_bin() {
  for p in "$(command -v node 2>/dev/null)" /usr/local/bin/node /usr/bin/node \
           /var/packages/DeepSeekHarness-NAS/target/.local/bin/node; do
    [ -n "${p:-}" ] && [ -x "$p" ] && { printf '%s' "$p"; return 0; }
  done
  return 1
}
NODE="$(probe_bin)" || { echo "错误: 找不到 node"; exit 1; }

running_pid() {
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null && { printf '%s' "$pid"; return 0; }
  return 1
}

case "${1:-restart}" in
  start)
    if pid="$(running_pid)"; then echo "已在运行 (PID $pid, 端口 $PORT)"; exit 0; fi
    [ -f "$ENTRY" ] || { echo "错误: 缺少 $ENTRY"; exit 1; }
    PORT="$PORT" nohup "$NODE" "$ENTRY" >"$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    sleep 1.5
    if pid="$(running_pid)"; then
      echo "已启动 (PID $pid, 端口 $PORT, 独立服务, 日志 $LOG_FILE)"
    else
      echo "启动失败，日志最后几行："; tail -8 "$LOG_FILE" 2>/dev/null
      rm -f "$PID_FILE"; exit 1
    fi
    ;;
  stop)
    if pid="$(running_pid)"; then
      kill -TERM "$pid" 2>/dev/null && sleep 1
      kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null
      echo "已停止 (原 PID $pid)"
    else
      echo "未运行"
    fi
    rm -f "$PID_FILE"
    ;;
  restart)
    # 用绝对路径自调用：`bash web.sh restart` 时 "$0" 只是相对名 "web.sh"，
    # 直接执行会报 command not found（实测踩到），所以这里统一走 SELF。
    bash "$SELF" stop; sleep 0.5; bash "$SELF" start
    ;;
  status)
    if pid="$(running_pid)"; then
      echo "运行中 (PID $pid, 端口 $PORT, 独立服务)"
      curl -s -o /dev/null -w "  首页 HTTP %{http_code}\n" --max-time 5 "http://127.0.0.1:$PORT/" || true
    else
      echo "未运行"
    fi
    ;;
  *)
    echo "用法: $0 [start|stop|restart|status]"; exit 2
    ;;
esac
