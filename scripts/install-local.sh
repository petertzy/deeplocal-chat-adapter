#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v code >/dev/null 2>&1; then
  echo "The 'code' command was not found."
  echo "In VS Code, run: Shell Command: Install 'code' command in PATH"
  exit 1
fi

npm install
npm run package:vsix

if code --list-extensions | grep -qx "local-dev.deeplocal"; then
  echo "Removing old local-dev.deeplocal extension..."
  code --uninstall-extension "local-dev.deeplocal"
fi

OBSOLETE_FILE="$HOME/.vscode/extensions/.obsolete"
if [[ -f "$OBSOLETE_FILE" ]]; then
  node -e '
const fs = require("fs");
const file = process.argv[1];
const obsolete = JSON.parse(fs.readFileSync(file, "utf8"));
delete obsolete["local-dev.deeplocal-0.1.0"];
delete obsolete["local-dev.deeplocal-chat-adapter-0.1.0"];
fs.writeFileSync(file, JSON.stringify(obsolete));
' "$OBSOLETE_FILE"
fi

code --install-extension "deeplocal-chat-adapter-0.1.0.vsix" --force

echo
echo "deeplocal-chat-adapter was installed into VS Code Extensions."
echo "Reload VS Code with: Developer: Reload Window"
echo "Then run: deeplocal-chat-adapter: Open"
