#!/usr/bin/env bash
# Use the shared Devin launcher for the CDP port and direct network settings.
set -euo pipefail
exec bash "$(dirname "${BASH_SOURCE[0]}")/../ubuntu_start/start-agents.sh" devin
