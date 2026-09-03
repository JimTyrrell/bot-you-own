#!/bin/zsh
cd "$(dirname "$0")/../.."
export CLOUDFLARE_ACCOUNT_ID=<your-account-id>
for M in "@cf/meta/llama-3.3-70b-instruct-fp8-fast" "@cf/meta/llama-4-scout-17b-16e-instruct" "@cf/openai/gpt-oss-120b"; do
  SLUG=$(echo "$M" | sed 's|@cf/||; s|/|-|g')
  sed -i '' "s|^  model: \".*\",|  model: \"$M\",|" config.js
  npx wrangler dev --port 8787 > "tests/results/dev-$SLUG.log" 2>&1 &
  PID=$!
  for i in $(seq 1 60); do curl -s -m 2 http://localhost:8787/health | grep -q ok && break; sleep 1; done
  START=$(date +%s)
  node tests/break-it.mjs --passphrase sovereign-operator-2026 --out "tests/results/compare2-$SLUG.md" > "tests/results/compare2-$SLUG.log" 2>&1
  echo "exit=$? seconds=$(( $(date +%s) - START ))" >> "tests/results/compare2-$SLUG.log"
  kill $PID 2>/dev/null; pkill -f "wrangler dev --port 8787" 2>/dev/null; sleep 3
done
git checkout -- config.js
echo "ALLDONE" > tests/results/compare2-done.flag
