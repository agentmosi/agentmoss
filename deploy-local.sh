#!/usr/bin/env bash
# =============================================================================
# deploy-local.sh — AgentMoss 本地实验一键部署脚本
# =============================================================================
# 用法:
#   chmod +x deploy-local.sh
#   ./deploy-local.sh                  # 默认端口 19877，后台运行
#   ./deploy-local.sh -p 19876         # 自定义端口
#   ./deploy-local.sh --foreground     # 前台运行（方便 Ctrl+C 停止）
#   ./deploy-local.sh --kill           # 停止已运行的服务
#   ./deploy-local.sh --status         # 查看运行状态
# =============================================================================
set -euo pipefail

# ---------- 默认配置 ----------
PORT="19877"
FOREGROUND="false"
ACTION="deploy"
REPO_URL="git@github.com-agentmosi:agentmosi/agentmoss.git"
# 如果本地已有代码目录，直接使用；否则自动 clone
PROJECT_DIR="${AGENTMOSS_DIR:-}"
NODE_MIN_MAJOR="18"

# 颜色
BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

# ---------- 帮助 ----------
usage() {
  cat <<EOF
${BOLD}AgentMoss 本地实验部署脚本${NC}

用法: $0 [选项]

选项:
  -p, --port PORT         监听端口 (默认: ${PORT})
  -f, --foreground        前台运行 (Ctrl+C 停止)
  -d, --dir PATH          指定项目目录 (跳过 git clone)
  --kill                  停止所有 AgentMoss 进程
  --status                查看运行状态
  -h, --help              显示帮助

示例:
  $0                                # 后台部署，端口 19877
  $0 -p 3000 --foreground           # 前台运行，端口 3000
  $0 --kill                         # 停止服务
  $0 --status                       # 查看状态
EOF
  exit 0
}

# ---------- 解析参数 ----------
while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--port)
      PORT="$2"
      shift 2
      ;;
    -f|--foreground)
      FOREGROUND="true"
      shift
      ;;
    -d|--dir)
      PROJECT_DIR="$2"
      shift 2
      ;;
    --kill)
      ACTION="kill"
      shift
      ;;
    --status)
      ACTION="status"
      shift
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo -e "${RED}❌ 未知选项: $1${NC}"
      usage
      ;;
  esac
done

# ---------- 状态检查 ----------
show_status() {
  echo -e "${BOLD}📊 AgentMoss 运行状态${NC}"
  echo ""
  PIDS=$(pgrep -f "node.*src/server.ts" 2>/dev/null || true)
  if [[ -z "$PIDS" ]]; then
    echo -e "  状态: ${RED}● 未运行${NC}"
  else
    while IFS= read -r pid; do
      local port
      port=$(lsof -Pan -p "$pid" -i TCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $9}' | sed 's/.*://' | head -1)
      echo -e "  PID: ${GREEN}${pid}${NC}  端口: ${CYAN}${port:-未知}${NC}"
    done <<< "$PIDS"
  fi
  echo ""
}

# ---------- 停止服务 ----------
kill_service() {
  echo -e "${YELLOW}🛑 正在停止 AgentMoss 进程...${NC}"
  PIDS=$(pgrep -f "node.*src/server.ts" 2>/dev/null || true)
  if [[ -z "$PIDS" ]]; then
    echo -e "  没有运行中的 AgentMoss 进程。"
  else
    echo "$PIDS" | xargs kill 2>/dev/null || true
    sleep 1
    # 强制清理
    PIDS=$(pgrep -f "node.*src/server.ts" 2>/dev/null || true)
    if [[ -n "$PIDS" ]]; then
      echo "$PIDS" | xargs kill -9 2>/dev/null || true
    fi
    echo -e "${GREEN}✅ 已停止所有 AgentMoss 进程。${NC}"
  fi
  exit 0
}

# ---------- 处理 action ----------
case "$ACTION" in
  status)  show_status; exit 0 ;;
  kill)    kill_service ;;
esac

# ---------- 前置检查 ----------
echo ""
echo -e "${BOLD}🌿 AgentMoss 本地实验部署${NC}"
echo -e "   端口: ${CYAN}${PORT}${NC}"
echo -e "   模式: ${CYAN}$([ "$FOREGROUND" == "true" ] && echo "前台" || echo "后台")${NC}"
echo ""

# 1. 检查 Node.js
if ! command -v node &>/dev/null; then
  echo -e "${RED}❌ 未检测到 Node.js，请先安装 Node.js >= ${NODE_MIN_MAJOR}${NC}"
  echo "   推荐: brew install node  (macOS)"
  exit 1
fi

NODE_MAJOR=$(node -e "console.log(process.version.match(/v(\d+)\./)[1])")
if [[ "$NODE_MAJOR" -lt "$NODE_MIN_MAJOR" ]]; then
  echo -e "${RED}❌ Node.js 版本过低: v$(node -v)，需要 >= v${NODE_MIN_MAJOR}${NC}"
  exit 1
fi
echo -e "   ✅ Node.js $(node -v)"

# 2. 确认项目目录
if [[ -z "$PROJECT_DIR" ]]; then
  # 尝试常见位置
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  if [[ -f "$SCRIPT_DIR/package.json" ]] && grep -q '"agentmoss"' "$SCRIPT_DIR/package.json" 2>/dev/null; then
    PROJECT_DIR="$SCRIPT_DIR"
    echo -e "   📂 项目目录 (脚本所在): ${CYAN}${PROJECT_DIR}${NC}"
  else
    # clone 到 ~/agentmoss
    PROJECT_DIR="$HOME/agentmoss"
    if [[ ! -d "$PROJECT_DIR" ]]; then
      echo -e "   📥 克隆仓库: ${CYAN}${REPO_URL}${NC}"
      git clone "$REPO_URL" "$PROJECT_DIR"
      echo -e "   ✅ 克隆完成"
    else
      echo -e "   📂 项目目录已存在: ${CYAN}${PROJECT_DIR}${NC}"
      cd "$PROJECT_DIR"
      echo -e "   🔄 git pull..."
      git pull origin main 2>/dev/null || echo -e "   ${YELLOW}⚠️  git pull 失败，使用现有代码${NC}"
    fi
  fi
fi

if [[ ! -f "$PROJECT_DIR/package.json" ]]; then
  echo -e "${RED}❌ 项目目录无效，未找到 package.json: ${PROJECT_DIR}${NC}"
  exit 1
fi

cd "$PROJECT_DIR"

# 3. 安装依赖
if [[ ! -d "node_modules" ]]; then
  echo -e "   📦 安装依赖 (npm install)..."
  npm install --silent
  echo -e "   ✅ 依赖安装完成"
else
  echo -e "   ✅ node_modules 已存在，跳过安装"
fi

# 4. 检查安全规则文件
if [[ ! -f "policy/safety-rules.json" ]]; then
  echo -e "${RED}❌ 安全规则文件缺失: policy/safety-rules.json${NC}"
  exit 1
fi
echo -e "   ✅ 安全规则已就绪 ($(jq '.rules | length' policy/safety-rules.json 2>/dev/null || echo '?') 条)"

# 5. 检查端口占用
if lsof -Pi :"$PORT" -sTCP:LISTEN -t &>/dev/null; then
  echo -e "${YELLOW}⚠️  端口 ${PORT} 已被占用，尝试查找 AgentMoss 进程...${NC}"
  EXISTING=$(pgrep -f "node.*src/server.ts" 2>/dev/null || true)
  if [[ -n "$EXISTING" ]]; then
    echo -e "   🔄 AgentMoss 已在运行 (PID: ${EXISTING})，重启中..."
    echo "$EXISTING" | xargs kill 2>/dev/null || true
    sleep 1
  else
    echo -e "${RED}❌ 端口 ${PORT} 被其他进程占用，请更换端口或停止该进程。${NC}"
    exit 1
  fi
fi

# 6. 启动服务
echo ""
echo -e "${GREEN}${BOLD}🚀 启动 AgentMoss 安全引擎...${NC}"
echo -e "   地址: ${CYAN}http://127.0.0.1:${PORT}${NC}"
echo ""

if [[ "$FOREGROUND" == "true" ]]; then
  # 前台运行
  echo -e "   ${YELLOW}(前台模式 — 按 Ctrl+C 停止)${NC}"
  echo ""
  PORT="$PORT" node --experimental-strip-types src/server.ts
else
  # 后台运行
  PORT="$PORT" nohup node --experimental-strip-types src/server.ts > /tmp/agentmoss.log 2>&1 &
  AGENTMOSS_PID=$!
  sleep 2

  # 验证启动
  if kill -0 "$AGENTMOSS_PID" 2>/dev/null; then
    echo -e "   PID: ${GREEN}${AGENTMOSS_PID}${NC}"
    echo -e "   日志: ${CYAN}/tmp/agentmoss.log${NC}"
    echo ""
    echo -e "${GREEN}${BOLD}✅ AgentMoss 已启动！${NC}"
    echo ""
    echo "   验证:  curl http://127.0.0.1:${PORT}/about"
    echo "   规则数: $(curl -s http://127.0.0.1:${PORT}/ | jq -r '.numRules' 2>/dev/null || echo '?') 条"
    echo "   停止:  $0 --kill"
    echo "   查看日志: tail -f /tmp/agentmoss.log"
    echo ""
  else
    echo -e "${RED}❌ 启动失败，请查看日志: cat /tmp/agentmoss.log${NC}"
    exit 1
  fi
fi