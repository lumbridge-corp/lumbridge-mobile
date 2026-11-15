#!/usr/bin/env bash
# Picks ports for one run of the test suites, so it can run beside another on the same machine (two CI jobs,
# two sessions on one build machine). Prints, as lines a shell or $GITHUB_ENV takes:
#   LUMBRIDGE_TEST_PORT=<base>   a block of 50 ports, base..base+49, every one free right now on 127.0.0.1
#   LUMBRIDGE_PG_PORT=<base+40>  for the throwaway Postgres (scripts/ci-db.sh, scripts/dev-db.sh, the data tests)
# Blocks start at multiples of 50 in 20000-28950, below the kernel's ephemeral range (32768+), so two blocks never overlap and
# the OS doesn't hand out their ports to a client. Inside a block (tests/ports.mjs has each suite's offsets):
#   base+0..9 the scratch-core suites (e2e, push-e2e, client-regress)   base+10..19 infra-verify   base+20..29 the browser suites
#   base+40 Postgres
# "Free" is checked by binding each port (a listener on 0.0.0.0, or one ss would not show this user, counts), not by reading ss.
#   eval "$(scripts/test-ports.sh)"; node tests/e2e.mjs "$LUMBRIDGE_TEST_PORT"
set -euo pipefail
exec python3 -I - "$@" <<'PY'
import random, socket, sys
SPAN, LOW, HIGH = 50, 20000, 28950
def free(p):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", p))
        return True
    except OSError:
        return False
    finally:
        s.close()
bases = list(range(LOW, HIGH + 1, SPAN))
random.SystemRandom().shuffle(bases)
for base in bases[:60]:
    if all(free(p) for p in range(base, base + SPAN)):
        print(f"LUMBRIDGE_TEST_PORT={base}")
        print(f"LUMBRIDGE_PG_PORT={base + 40}")
        sys.exit(0)
print("test-ports: no free block of 50 ports in 20000-28999 after 60 tries", file=sys.stderr)
sys.exit(1)
PY
