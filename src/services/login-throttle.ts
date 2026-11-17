import { env } from "../config/env.js";

// Limite les échecs de connexion par couple (email, adresse IP), et non plus par compte seul :
// un attaquant qui rate 5 fois depuis son adresse n'empêche pas le vrai propriétaire de se connecter
// depuis la sienne. Le même compteur s'applique aux emails inconnus, donc la réponse ne révèle
// jamais si un compte existe. Stockage en mémoire : à remplacer par Redis si plusieurs instances.
interface Entry {
  count: number;
  lockedUntil: number;
  lastFailureAt: number;
}

const entries = new Map<string, Entry>();
const MAX_ENTRIES = 50_000;

const keyOf = (email: string, ip: string) => `${email}|${ip}`;
const lockMs = () => env.LOGIN_LOCK_MINUTES * 60 * 1000;

function prune(now: number) {
  if (entries.size < MAX_ENTRIES) {
    return;
  }

  for (const [key, entry] of entries) {
    if (entry.lockedUntil <= now && now - entry.lastFailureAt > lockMs()) {
      entries.delete(key);
    }
  }
}

export function isThrottled(email: string, ip: string, now = Date.now()): boolean {
  const entry = entries.get(keyOf(email, ip));
  return entry !== undefined && entry.lockedUntil > now;
}

// Enregistre un échec ; renvoie true quand cet échec vient de déclencher le blocage.
export function registerFailure(email: string, ip: string, now = Date.now()): boolean {
  prune(now);
  const key = keyOf(email, ip);
  const previous = entries.get(key);
  // Les échecs trop anciens ne comptent plus.
  const count = previous && now - previous.lastFailureAt <= lockMs() ? previous.count + 1 : 1;

  if (count >= env.LOGIN_MAX_ATTEMPTS) {
    entries.set(key, { count: 0, lockedUntil: now + lockMs(), lastFailureAt: now });
    return true;
  }

  entries.set(key, { count, lockedUntil: 0, lastFailureAt: now });
  return false;
}

export function clearFailures(email: string, ip: string) {
  entries.delete(keyOf(email, ip));
}

// Une réinitialisation de mot de passe réussie prouve que l'on contrôle la boîte mail : on lève les blocages de ce compte.
export function clearFailuresForEmail(email: string) {
  for (const key of entries.keys()) {
    if (key.startsWith(`${email}|`)) {
      entries.delete(key);
    }
  }
}

// Réservé aux tests.
export function resetThrottle() {
  entries.clear();
}
