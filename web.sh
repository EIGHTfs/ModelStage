#!/bin/bash
# 应用启停脚本（src/web 前端 + src/server 服务端）
# 用法: web.sh [start|stop|restart|status]   (默认 restart；未启动时 restart 相当于 start)
#
# 架构：单进程。由 src/server/serve.mjs 同时提供
#   · 静态前端（src/web）
#   · /api 接口、/files 资源、/icons 图标、/live2d-lib 运行时
#   · 服务端解包、插件宿主
# 因此不存在"另起一个静态服务再反代"的分层。
#
# PID 与日志：model-stage-web.*（日志目录 runtime/）
# 端口与数据根都可用环境变量覆盖：
#   PORT=8804 bash web.sh restart
#   PORT=8899 MODELSTAGE_DATA_ROOT=runtime/test-instance bash web.sh restart   # 独立实例（测试用）

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
# 数据根：MODELSTAGE_DATA_ROOT 覆盖（缺省 = 项目根 ⇒ 行为完全不变）。
#   它决定 config/ data/ runtime/ 三处；PID 与日志必须跟着走，
#   否则两个实例会抢同一个 pid 文件、日志也会混在一起（排障时看不出是谁写的）。
DATA_ROOT="${MODELSTAGE_DATA_ROOT:-$PROJECT_ROOT}"
RUNTIME_DIR="$DATA_ROOT/runtime"
mkdir -p "$RUNTIME_DIR"
# PID 与日志都放 <数据根>/runtime/，**不是项目根**。
#   为什么与 skill「pid-file-at-project-root」的建议不同（有意偏离，不是遗漏）：
#     本项目允许"同一份代码 + 两个数据根"并行跑（例如主实例 8804 与验证实例 8899 共用代码目录）。
#     PID 若放项目根，两个实例会抢同一个 pid 文件 —— 后启动的覆盖前一个，
#     于是 stop 会停错进程、status 会报错实例。跟着数据根走就天然隔离。
PID_FILE="$RUNTIME_DIR/model-stage-web.pid"
LOG_FILE="$RUNTIME_DIR/model-stage-web.log"

# 日志滚动阈值 5 MB。
#   为什么是这个数：日志只用于排障，正常运行时（启动信息 + 少量探测日志）一天不过几 MB，
#   5 MB 已能覆盖相当长的历史；超过它通常意味着"异常刷屏"（探测循环 / 请求风暴），
#   那时更需要的是"上一份完整日志"，而不是无限增长的单文件。
#   为什么只留 1 份（.1）：家用 NAS 预览器没必要多份轮转，多份反而占空间且难找。
LOG_MAX_BYTES=$((5 * 1024 * 1024))

# 启动前检查并轮转旧日志。
#   **必须在进程已停的前提下调用**：进程开着文件句柄时 mv 文件，写入会继续落到旧 inode，
#   表面上看"轮转了"，实际新日志文件永远空着 —— 这是最容易踩且最难发现的一类。
#   调用点只有 start（它前面已确认未运行），restart 也是先 stop 再 start ⇒ 安全。
rotate_log_if_needed() {
  [ -f "$LOG_FILE" ] || return 0
  size=$(wc -c < "$LOG_FILE" 2>/dev/null | tr -d ' ')
  [ -n "${size:-}" ] || return 0
  if [ "$size" -gt "$LOG_MAX_BYTES" ]; then
    mv -f "$LOG_FILE" "$LOG_FILE.1"
    echo "已轮转旧日志（$((size / 1024 / 1024)) MB → $(basename "$LOG_FILE").1）"
  fi
}
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
    # 此处进程已确认未运行（上面刚检查过）⇒ 可以安全轮转
    rotate_log_if_needed
    # 只有调用方显式设了 MODELSTAGE_DATA_ROOT 才透传：不设时与历史行为完全一致
    if [ -n "${MODELSTAGE_DATA_ROOT:-}" ]; then export MODELSTAGE_DATA_ROOT="$DATA_ROOT"; fi
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
      # 优先用 /api/health：一次拿到版本/运行时长/数据根/插件数，比"首页 HTTP 码"信息量大得多。
      #   旧实例没有该端点（返回 404 或非 JSON）⇒ 回落到首页探测，保证 status 对旧版本也能用。
      health="$(curl -s --max-time 5 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)"
      if printf '%s' "$health" | grep -q '"ok":true'; then
        printf '  健康 %s\n' "$health"
      else
        curl -s -o /dev/null -w "  首页 HTTP %{http_code}（无 /api/health，回落到首页探测）\n" --max-time 5 "http://127.0.0.1:$PORT/" || true
      fi
    else
      echo "未运行"
    fi
    ;;
  *)
    echo "用法: $0 [start|stop|restart|status]"; exit 2
    ;;
esac
