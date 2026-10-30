#!/usr/bin/env bash
# Deploys ONLY the ops dashboard — always from the right folder, regardless
# of where this script is run from. Run as: ./deploy-ops-dashboard.sh
set -euo pipefail
cd "$(dirname "$0")/ops-dashboard"
echo "Deploying ops-dashboard from: $(pwd)"
netlify deploy --prod
