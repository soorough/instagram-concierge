#!/usr/bin/env bash
#
# The demo, one beat at a time.
#
# Run `npm start` in another terminal and open http://localhost:8787/ first.
# Watch the browser and the server terminal — this window only fires events.
#
#   ./scripts/demo.sh              pause between beats, wait for a keypress
#   ./scripts/demo.sh auto         no keypresses, just paced (for a recording)
#   ./scripts/demo.sh reset        wipe the conversations and stop
#
# Every beat posts a signed Delivery at the real webhook endpoint. Nothing here
# reaches inside the system.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

MODE="${1:-step}"
PORT="${PORT:-8787}"
API="http://127.0.0.1:$PORT/api/simulate"

[[ -f .env ]] || { echo "no .env — copy .env.example and fill it in"; exit 1; }
# shellcheck disable=SC1091
set -a; . ./.env; set +a

if [[ "$MODE" == "reset" ]]; then
  read -rp "Delete all conversations? [y/N] " ok
  [[ "$ok" =~ ^[Yy] ]] || { echo "left alone"; exit 0; }
  rm -f data/concierge.db data/concierge.db-shm data/concierge.db-wal
  echo "Cleared. Restart the server to pick up the empty database."
  exit 0
fi

if ! curl -s -o /dev/null --max-time 3 "http://127.0.0.1:$PORT/api/threads"; then
  echo "nothing is listening on :$PORT — run 'npm start' in another terminal first"
  exit 1
fi

if [[ -z "${IG_MEDIA_ID:-}" ]]; then
  echo "warning: IG_MEDIA_ID is unset — the opener will not know which post it is answering"
fi

# The handle appears on screen and in the opener, so it must name a real
# account. A hardcoded fallback here is how a demo ends up showing a person who
# does not exist — so this refuses rather than inventing one.
if [[ -z "${IG_TESTER_HANDLE:-}" ]]; then
  echo "IG_TESTER_HANDLE is not set. Add your real second Instagram account to .env:"
  echo "  IG_TESTER_HANDLE=<handle>   IG_TESTER_ID=<any stable string>"
  exit 1
fi
CUSTOMER="$IG_TESTER_HANDLE"
HANDLE="$IG_TESTER_HANDLE"

bold() { printf '\n\033[1m%s\033[0m\n' "$1"; }
dim()  { printf '\033[2m  %s\033[0m\n' "$1"; }

# A Turn takes 4–10 seconds. Firing the next event early makes the log
# unreadable and, worse, means the next Turn reads history before this reply
# lands — so it answers as if the exchange never happened.
beat() {
  local title="$1" why="$2" payload="$3" wait="${4:-30}"
  bold "▸ $title"
  dim "$why"
  # No escaped quotes: the script is single-quoted for the shell, so double
  # quotes inside it are already literal. Escaping them hands Python a
  # backslash it cannot parse — a mistake made three times before this comment.
  curl -s -X POST "$API" -H 'content-type: application/json' -d "$payload" \
    | python3 -c 'import sys, json
try:
    d = json.load(sys.stdin)
    print("  ->", d.get("status"), d.get("body") or d.get("error") or "")
except Exception:
    print("  -> could not read the response")'

  if [[ "$MODE" == "step" ]]; then
    read -rp $'\033[2m  press enter when the reply has landed…\033[0m'
  else
    sleep "$wait"
  fi
}

bold "════ Milestone 3 · comment → personalised DM ════"

beat "A real comment on the post" \
     "The opener names the product from the post's own caption. Watch the rail: the profile fetch is attempted and refused — consent-gated." \
     "{\"kind\":\"comment\",\"text\":\"obsessed with this red blend 😍 is it good with steak?\",\"customerId\":\"$CUSTOMER\",\"username\":\"$HANDLE\"}"

beat "A comment that has not earned a message" \
     "One DM per comment, ever. This one is withheld in ~1ms, without touching the model, and the reason is recorded." \
     "{\"kind\":\"comment\",\"text\":\"🔥🔥🔥\",\"customerId\":\"passerby\"}" 5

bold "════ Milestone 1 · the agent loop, and Milestone 2 · Shopify over MCP ════"

beat "She replies — the same thread continues" \
     "Conversation state persists. The price comes from the live store, never from the model." \
     "{\"kind\":\"message\",\"text\":\"yes! how much is it?\",\"customerId\":\"$CUSTOMER\",\"eventId\":\"demo-price\"}"

beat "She buys" \
     "The store prices the cart and applies its own discount. The checkout link is real — open it." \
     "{\"kind\":\"message\",\"text\":\"add two bottles please\",\"customerId\":\"$CUSTOMER\",\"eventId\":\"demo-cart\"}" 36

beat "A policy question" \
     "Answered from the brand's own pages. Ask about something they do not publish and it says so rather than inventing." \
     "{\"kind\":\"message\",\"text\":\"what is your return policy?\",\"customerId\":\"$CUSTOMER\",\"eventId\":\"demo-policy\"}"

bold "════ Milestone 1 · the trust boundary ════"

beat "Meta redelivers the last event" \
     "Same event id. One reply, no second bubble — and still HTTP 200, so Meta stops retrying." \
     "{\"kind\":\"message\",\"text\":\"add two bottles please\",\"customerId\":\"$CUSTOMER\",\"eventId\":\"demo-cart\"}" 4

beat "A forged signature" \
     "Rejected at the boundary. No Turn runs, and the rail shows why." \
     '{"kind":"forged"}' 4

bold "Done."
dim "Two conversations, one withheld opener, one rejected delivery."
dim "The trace beside each reply is what the concierge actually did."
