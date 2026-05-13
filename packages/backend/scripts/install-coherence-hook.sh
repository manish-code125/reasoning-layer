#!/bin/bash
# Install the Reasoning Layer coherence pre-commit hook into any git repo.
#
# Usage (run from the root of the repo you want to protect):
#   bash /path/to/reasoning-layer/packages/backend/scripts/install-coherence-hook.sh
#
# To enable block mode (prevents commits when drift is detected):
#   REASONING_LAYER_MODE=block bash /path/to/install-coherence-hook.sh
#
# To point at a different backend:
#   REASONING_LAYER_BACKEND=http://localhost:3002 bash /path/to/install-coherence-hook.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR=".githooks"

# Must be run from inside a git repo
if ! git rev-parse --show-toplevel &>/dev/null; then
  echo "Error: not inside a git repository."
  exit 1
fi

mkdir -p "$HOOKS_DIR"
cp "$SCRIPT_DIR/pre-commit" "$HOOKS_DIR/pre-commit"
chmod +x "$HOOKS_DIR/pre-commit"
git config core.hooksPath .githooks

echo "✅ Coherence hook installed at .githooks/pre-commit"
echo ""
echo "Mode: ${REASONING_LAYER_MODE:-warn}  (set REASONING_LAYER_MODE=block to prevent commits on drift)"
echo "Backend: ${REASONING_LAYER_BACKEND:-http://44.200.186.86/reasoning}"
echo ""
echo "To track files and link decisions, use:"
echo "  curl -s -X POST \"\$BACKEND/api/repos/\$REPO/artifacts\" -H 'Content-Type: application/json' \\"
echo "    -d '{\"file_path\": \"path/to/file\", \"description\": \"role of this file\"}'"
