#!/usr/bin/env bash
# Deploys ONLY the customer storefront (thegoodpapaya.com) — always from the
# right folder, regardless of where this script is run from.
# Run as: ./deploy-storefront.sh
set -euo pipefail
cd "$(dirname "$0")/storefront"
echo "Deploying storefront from: $(pwd)"
netlify deploy --prod
