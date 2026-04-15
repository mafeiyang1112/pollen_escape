#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
server_dir="$script_dir/server"
venv_dir="$server_dir/.venv"
activate_script="$venv_dir/bin/activate"

cd "$server_dir"

if [[ ! -x "$venv_dir/bin/python" || ! -f "$activate_script" ]]; then
  echo "[INFO] Rebuilding virtual environment..."
  rm -rf "$venv_dir"
  python3 -m venv "$venv_dir"
fi

. "$activate_script"

echo "[INFO] Installing or refreshing dependencies..."
pip install -r requirements.txt

echo "[INFO] Starting Pollen Escape backend..."
exec python app.py