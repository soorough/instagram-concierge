#!/usr/bin/env bash
#
# Runs the eval suite against several real storefronts.
#
# Code that works against one store is a guess about the rest. Every shape this
# project handles — where prices live, where variants live, which tools exist —
# was learned from one catalog, and three defects were found only by pointing it
# at a second. So this runs the same suite across four industries and one store
# that offers policy search alone.
#
#   ./scripts/eval-stores.sh              all of them
#   ./scripts/eval-stores.sh cart         one case, every store
#
# Add your own: STORES="yourshop.com|Your Brand" ./scripts/eval-stores.sh

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

CASE="${1:-}"

# domain|brand. Ridge Wallet is deliberate: it serves only policy search, so the
# catalog cases skip rather than fail, and that path stays exercised.
DEFAULT_STORES="glossier.com|Glossier
onehopewine.com|ONEHOPE
jonesroadbeauty.com|Jones Road Beauty
wolftoothcomponents.com|Wolf Tooth
ridgewallet.com|Ridge Wallet"

STORES="${STORES:-$DEFAULT_STORES}"

pass=0
fail=0
summary=""

while IFS='|' read -r domain brand; do
  [[ -z "$domain" ]] && continue
  printf '\n\033[1m──── %s (%s) ────\033[0m\n' "$brand" "$domain"

  out=$(SHOPIFY_STORE_DOMAIN="$domain" BRAND_NAME="$brand" \
        npx tsx src/evals/run.ts ${CASE:+"$CASE"} 2>&1)
  echo "$out" | grep -E '^[✓✗⊘]|^    ✗'

  line=$(echo "$out" | grep -E '^[0-9]+ passed' | tail -1)
  summary+="  $(printf '%-22s' "$brand")${line:-no result}"$'\n'

  # A store failing is a result, not a reason to stop looking at the others.
  if echo "$line" | grep -q '0 failed'; then pass=$((pass + 1)); else fail=$((fail + 1)); fi
done <<< "$STORES"

printf '\n\033[1m──── summary ────\033[0m\n%s' "$summary"
printf '\n%d store(s) fully green, %d with failures\n\n' "$pass" "$fail"

# Non-zero when any store had a failing case, so this can gate a release.
[[ "$fail" -eq 0 ]]
