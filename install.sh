#!/usr/bin/env bash
# pi-brain installer — project vs global (bash equivalent of install.bat)
set -e
SRC="$(cd "$(dirname "$0")/pi-brain" && pwd)"
if [ ! -f "$SRC/index.ts" ]; then echo "[error] Source not found: $SRC/index.ts"; exit 1; fi
echo "pi-brain installer"
echo "=================="
echo "Source: $SRC"
echo " [1] Project - .pi/extensions/pi-brain"
echo " [2] Global  - ~/.pi/agent/extensions/pi-brain"
echo " [3] Both"
read -p "Select [1/2/3]: " CHOICE
install_to() {
  local ED="$1" SD="$2"
  echo "Installing to:"
  echo "  Extension: $ED"
  echo "  Skill:     $SD"
  mkdir -p "$ED" "$SD"
  cp -f "$SRC/index.ts" "$ED/index.ts"
  [ -f "$SRC/docs.html" ] && cp -f "$SRC/docs.html" "$ED/docs.html" || true
  cp -f "$SRC/SKILL.md" "$SD/SKILL.md"
  rm -f "$ED/SKILL.md" 2>/dev/null || true
  echo " [ok] Installed."
}
case "$CHOICE" in
  1) install_to "$(pwd)/.pi/extensions/pi-brain" "$(pwd)/.pi/skills/pi-brain" ;;
  2) install_to "$HOME/.pi/agent/extensions/pi-brain" "$HOME/.pi/agent/skills/pi-brain" ;;
  3) install_to "$(pwd)/.pi/extensions/pi-brain" "$(pwd)/.pi/skills/pi-brain"
     install_to "$HOME/.pi/agent/extensions/pi-brain" "$HOME/.pi/agent/skills/pi-brain" ;;
  *) echo "Invalid choice"; exit 1 ;;
esac
echo "Done. Restart pi or run /reload"
