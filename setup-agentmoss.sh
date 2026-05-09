#!/usr/bin/env bash
set -euo pipefail

# =========================================================================
# setup-agentmoss.sh — 一键配置 OpenClaw 接入 AgentMoss 安全引擎
# =========================================================================
# 用法:
#   chmod +x setup-agentmoss.sh
#   ./setup-agentmoss.sh                          # 默认端口 19877
#   ./setup-agentmoss.sh -p 19876                 # 自定义端口
#   ./setup-agentmoss.sh -u http://10.0.0.5:19877 # 自定义完整地址
#   ./setup-agentmoss.sh --dry-run                # 预览变更，不写文件
#   ./setup-agentmoss.sh --audit-only             # 仅审计模式（不阻断）
# =========================================================================

MONITOR_URL="http://127.0.0.1:19877"
FAIL_CLOSED="true"
OBSERVE_HOOKS="true"
AUDIT_ONLY="false"
DRY_RUN="false"
PLUGIN_DIR_DEFAULT=""

# 颜色
BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

usage() {
  cat <<EOF
用法: $0 [选项]

选项:
  -p, --port PORT         AgentMoss 端口 (默认 19877)
  -u, --url URL           完整 monitorUrl，如 http://10.0.0.5:19877
  --fail-open             监控不可用时放行 (默认 fail-closed，阻断)
  --no-observe            不采集观察事件
  --audit-only            纯审计模式，不阻断
  --dry-run               预览变更，不修改文件
  -h, --help              显示帮助

示例:
  $0                                    # 使用默认配置
  $0 -p 19876                           # 指定端口
  $0 -u http://192.168.1.100:19877      # 远程监控地址
  $0 --dry-run                          # 预览
EOF
  exit 0
}

# =========================================================================
# 解析参数
# =========================================================================
while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--port)
      MONITOR_URL="http://127.0.0.1:${2}"
      shift 2
      ;;
    -u|--url)
      MONITOR_URL="$2"
      shift 2
      ;;
    --fail-open)
      FAIL_CLOSED="false"
      shift
      ;;
    --no-observe)
      OBSERVE_HOOKS="false"
      shift
      ;;
    --audit-only)
      AUDIT_ONLY="true"
      shift
      ;;
    --dry-run)
      DRY_RUN="true"
      shift
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "❌ 未知选项: $1"
      usage
      ;;
  esac
done

# =========================================================================
# 检查依赖
# =========================================================================
if ! command -v jq &>/dev/null; then
  echo "❌ 需要 jq 工具，请先安装: brew install jq  (或 apt/yum install jq)"
  exit 1
fi

# =========================================================================
# 定位 openclaw.json
# =========================================================================
OPENCLAW_JSON="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"

if [[ ! -f "$OPENCLAW_JSON" ]]; then
  echo "❌ 未找到 openclaw.json: $OPENCLAW_JSON"
  echo "   可通过环境变量指定: OPENCLAW_CONFIG=/path/to/openclaw.json $0"
  exit 1
fi

echo ""
echo -e "${BOLD}🌿 AgentMoss 一键配置工具${NC}"
echo -e "   配置文件: ${CYAN}${OPENCLAW_JSON}${NC}"
echo -e "   监控地址: ${CYAN}${MONITOR_URL}${NC}"
echo -e "   超时时间: ${CYAN}80ms${NC}"
echo -e "   Fail-Closed: ${CYAN}${FAIL_CLOSED}${NC}"
echo -e "   数据采集: ${CYAN}${OBSERVE_HOOKS}${NC}"
echo -e "   审计模式: ${CYAN}${AUDIT_ONLY}${NC}"
echo ""

# =========================================================================
# 生成 merge JSON
# =========================================================================
MERGE_JSON=$(cat <<EOJ
{
  "plugins": {
    "entries": {
      "agentmoss": {
        "enabled": true,
        "config": {
          "monitorUrl": "${MONITOR_URL}",
          "timeoutMs": 80,
          "failClosedOnError": ${FAIL_CLOSED},
          "observeHooks": ${OBSERVE_HOOKS},
          "auditOnly": ${AUDIT_ONLY}
        }
      }
    }
  }
}
EOJ
)

# =========================================================================
# 使用 jq 合并: 深度合并 entries + 追加 load.paths + allow
# 使用递归合并策略，保留已有配置
# =========================================================================
NEW_JSON=$(jq --argjson merge "${MERGE_JSON}" \
  --arg agentmoss_dir "$(pwd)" \
  '
  # 1. 深度合并 plugins.entries（保留已有条目，新增/覆盖 agentmoss）
  .plugins.entries = (
    ((.plugins.entries // {}) + ($merge.plugins.entries // {}))
  )
  |
  # 2. 追加 load.paths（去重）
  .plugins.load.paths = (
    ((.plugins.load.paths // []) + [$agentmoss_dir] | unique)
  )
  |
  # 3. 追加 allow 列表（去重）
  .plugins.allow = (
    ((.plugins.allow // []) + ["agentmoss"] | unique)
  )
  ' "$OPENCLAW_JSON")

# 显示变更预览
echo -e "${BOLD}📋 变更预览 (plugins 段):${NC}"
echo "$NEW_JSON" | jq '{plugins: .plugins}'
echo ""

if [[ "$DRY_RUN" == "true" ]]; then
  echo -e "${YELLOW}🔍 --dry-run 模式，未修改文件。${NC}"
  exit 0
fi

# =========================================================================
# 备份 & 写入
# =========================================================================
BACKUP="${OPENCLAW_JSON}.backup.$(date +%Y%m%d_%H%M%S)"
cp "$OPENCLAW_JSON" "$BACKUP"
echo -e "📦 已备份至: ${CYAN}${BACKUP}${NC}"

echo "$NEW_JSON" > "$OPENCLAW_JSON"

echo ""
echo -e "${GREEN}${BOLD}✅ 配置完成！${NC}"
echo ""
echo "   AgentMoss 安全引擎已注册到 OpenClaw。"
echo "   重启 OpenClaw 或发送 SIGHUP 信号使配置生效。"
echo ""
echo "   验证方式:"
echo "     curl ${MONITOR_URL}/about"
echo ""