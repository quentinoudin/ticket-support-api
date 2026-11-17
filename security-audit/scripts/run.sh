#!/usr/bin/env bash
# Usage : bash security-audit/scripts/run.sh <before|after> <001 002 ...>
# Lance une instance jetable de l'API (base ticket_support_audit), rejoue chaque scénario et enregistre la sortie.
set -u
PHASE="$1"; shift
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/security-audit/evidence/$PHASE"
export DATABASE_URL="postgresql://ticket_user:ticket_password@localhost:5433/ticket_support_audit?schema=public"
export JWT_ACCESS_SECRET="audit-only-0123456789abcdef0123456789abcdef"
export APP_URL="http://localhost:3999" SMTP_HOST=localhost SMTP_PORT=1026 SMTP_USER= SMTP_PASSWORD= BREVO_API_KEY=
export AI_ENABLED=false DEEPSEEK_API_KEY= SUPER_ADMIN_EMAIL=root@audit.local SUPER_ADMIN_PASSWORD='Audit-Root-2026x'
mkdir -p "$OUT"

stop_port() { for pid in $(netstat -ano | grep ":$1 " | grep LISTENING | awk '{print $5}' | sort -u); do taskkill //PID "$pid" //F >/dev/null 2>&1; done; sleep 1; }
start_api() { # $1 = port, $2 = fichier de log ; variables d'environnement déjà exportées
  stop_port "$1"
  (cd "$ROOT" && PORT="$1" nohup npx tsx src/server.ts > "$2" 2>&1 &)
  for i in $(seq 1 40); do sleep 1; curl -s "localhost:$1/health" >/dev/null && return 0; done
  echo "API non démarrée"; cat "$2"; return 1
}

init_db() {
  docker exec ticket-support-postgres psql -U ticket_user -d postgres -tc "select 1 from pg_database where datname='ticket_support_audit'" | grep -q 1 \
    || { docker exec ticket-support-postgres psql -U ticket_user -d postgres -c "CREATE DATABASE ticket_support_audit;" >/dev/null
         (cd "$ROOT" && npx prisma migrate deploy >/dev/null && npx tsx prisma/seed-super-admin.ts >/dev/null); }
}
init_db

for ID in "$@"; do
  LOG="$OUT/.server-$ID.log"
  export TRUST_PROXY=1; unset NODE_ENV
  [ "$ID" = "011" ] && export NODE_ENV=production
  if [ "$ID" = "009" ]; then
    [ "$PHASE" = "before" ] && export TRUST_PROXY=0 || export TRUST_PROXY=1
    # instance « production » séparée pour montrer l'avertissement de démarrage avec TRUST_PROXY=0
    ( export NODE_ENV=production TRUST_PROXY=0; start_api 3998 "$OUT/.prod-009.log"; sleep 1; stop_port 3998 ) >/dev/null 2>&1
    export PROD_LOG="$OUT/.prod-009.log"
    stop_port 4000; (cd "$ROOT/security-audit/scripts" && nohup node proxy.mjs > /dev/null 2>&1 &); sleep 1
  fi
  docker exec ticket-support-postgres psql -U ticket_user -d ticket_support_audit -qc "UPDATE \"User\" SET \"failedLoginCount\"=0, \"lockedUntil\"=NULL;" >/dev/null 2>&1
  start_api 3999 "$LOG" || continue
  if [ "$ID" = "002" ]; then : ; fi
  ( cd "$ROOT/security-audit/scripts" && node scenarios.mjs "$ID" ) 2>&1 | tee "$OUT/VULN-$ID.txt"
  stop_port 3999; [ "$ID" = "009" ] && stop_port 4000
  unset NODE_ENV PROD_LOG
done
