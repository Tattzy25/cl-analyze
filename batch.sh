#!/usr/bin/env bash
# Sequential batch with retry+skip+circuit-breaker.
# The service retries each image 3x internally. It returns:
#   200 = completed
#   422 = skipped (failed all 3 attempts) -> bad image, move on
#   else = hard error
# Circuit breaker: two SKIPS in a row -> halt the whole run (workflow problem, not bad images).
#
# Usage: ./batch.sh https://YOUR-APP.up.railway.app /path/to/images
set -uo pipefail
APP="${1:?pass your railway app url}"
DIR="${2:?pass image folder path}"
shopt -s nullglob nocaseglob

consec_skips=0
ok=0; skipped=0
out="batch-results.json"
echo "[" > "$out"
first=1

for f in "$DIR"/*.{png,jpg,jpeg,webp}; do
  case "$f" in
    *.png)  ct="image/png" ;;
    *.jpg|*.jpeg) ct="image/jpeg" ;;
    *.webp) ct="image/webp" ;;
    *) ct="image/png" ;;
  esac
  echo ">> $f"
  http=$(curl -s -o /tmp/resp.json -w "%{http_code}" -X POST "$APP/analyze" \
    -H "Content-Type: $ct" --data-binary "@$f")

  if [ "$http" = "200" ]; then
    consec_skips=0
    ok=$((ok+1))
    echo "   completed"
    # append image_url + prompt only
    url=$(grep -o '"IMAGE_URL":"[^"]*"' /tmp/resp.json | sed 's/"IMAGE_URL":"//;s/"$//')
    prm=$(python3 -c "import json,sys;print(json.dumps(json.load(open('/tmp/resp.json')).get('PROMPT','')))" 2>/dev/null || echo '""')
    [ $first -eq 0 ] && echo "," >> "$out"; first=0
    printf '  {"image_url": %s, "prompt": %s}' "\"$url\"" "$prm" >> "$out"

  elif [ "$http" = "422" ]; then
    consec_skips=$((consec_skips+1))
    skipped=$((skipped+1))
    echo "   SKIPPED (failed 3x): $(cat /tmp/resp.json)"
    if [ "$consec_skips" -ge 2 ]; then
      echo ""
      echo "!! HALTED: two images in a row failed all 3 attempts."
      echo "!! That points to a workflow problem (worker, model, token, or webhook) — not bad images."
      echo "!! Fix it, then re-run. Completed results saved to $out."
      break
    fi
  else
    echo "   HARD ERROR ($http): $(cat /tmp/resp.json)"
    echo "!! Stopping on hard error."
    break
  fi
done

echo "" >> "$out"
echo "]" >> "$out"
echo "Done. completed=$ok skipped=$skipped  -> results in $out"
