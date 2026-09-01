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
code --install-extension "deeplocal-chat-adapter-0.1.0.vsix" --force

echo
echo "deeplocal-chat-adapter was installed into VS Code Extensions."
echo "Reload VS Code with: Developer: Reload Window"
echo "Then run: deeplocal-chat-adapter: Open"
