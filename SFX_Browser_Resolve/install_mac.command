#!/bin/bash
# Installs SFX Browser into DaVinci Resolve Studio (macOS). Double-click to run.
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins/SFX Browser"
SDK="/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Workflow Integrations/Examples/SamplePlugin/WorkflowIntegration.node"

echo "Installing SFX Browser to:"
echo "  $DEST"
echo "Administrator password may be required."
sudo mkdir -p "$DEST"
sudo rsync -a --delete --exclude test --exclude 'install_*' --exclude '.git*' "$SRC/" "$DEST/"
if [ ! -f "$DEST/WorkflowIntegration.node" ] && [ -f "$SDK" ]; then
  sudo cp "$SDK" "$DEST/"
fi
if [ ! -f "$DEST/WorkflowIntegration.node" ]; then
  echo "WARNING: WorkflowIntegration.node not found. See README.md."
fi
echo "Done. Restart DaVinci Resolve and open Workspace → Workflow Integrations → SFX Browser."
