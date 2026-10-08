#!/bin/sh
# Builds a tiny repo with two classic bugs and reviews it with static checks only ($0).
#   1. charge() gains a required parameter; two callers in untouched files still pass two
#   2. a live-looking Stripe key is pasted into source
# Usage: sh examples/demo.sh [extra plumb flags]
set -e
PLUMB="$(cd "$(dirname "$0")/.." && pwd)/bin/plumb.js"
OUT="$(cd "$(dirname "$0")" && pwd)"
D=$(mktemp -d)
cd "$D"
git init -q -b main
git config user.email demo@example.com
git config user.name Demo
mkdir -p src/payments src/api src/auth

cat > src/payments/charge.ts <<'EOF'
export function charge(userId: string, cents: number) {
  return { userId, cents };
}
EOF
cat > src/api/checkout.ts <<'EOF'
import { charge } from '../payments/charge';
export function checkout(userId: string, cart: number[]) {
  const cents = cart.reduce((a, b) => a + b, 0);
  return charge(userId, cents);
}
EOF
cat > src/api/refund.ts <<'EOF'
import { charge } from '../payments/charge';
export const refund = (userId: string, cents: number) => charge(userId, -cents);
EOF
cat > src/auth/session.ts <<'EOF'
export function verify(token: string) {
  return token.length > 20;
}
EOF
git add -A && git commit -qm "init"
GIT_AUTHOR_NAME="Priya" GIT_AUTHOR_EMAIL=priya@example.com git commit -q --allow-empty -m "noop"
echo "// tighten" >> src/auth/session.ts
GIT_AUTHOR_NAME="Priya" GIT_AUTHOR_EMAIL=priya@example.com git commit -qam 'Revert "loosen session check"'

# A fake key, assembled at runtime so this script never contains a key-shaped string.
FAKE_KEY="sk_""live_51Hx9QaZr8Lm2Vn4Tb7Wc1Kd5Pe3"
cat > src/payments/charge.ts <<EOF
export function charge(userId: string, cents: number, idempotencyKey: string) {
  const stripeKey = "$FAKE_KEY";
  return { userId, cents, idempotencyKey, stripeKey };
}
EOF
cat > src/auth/session.ts <<'EOF'
export function verify(token: string) {
  return token.length > 0;
}
// tighten
EOF

node "$PLUMB" review --static --html "$OUT/demo-report.html" "$@"
echo "Demo repo: $D"
