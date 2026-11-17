# Audit de sécurité — ticket-support-api

Date : 2026-11-17 · Branche : `feature/assistant-ia` · Périmètre : code (`src/`, `prisma/`, `scripts/`, `tests/`), `docker-compose.yml`, CI, historique git (28 commits).

## Méthode et outils

| Outil | Résultat |
|---|---|
| **gitleaks 8.30.1** (historique git + répertoire de travail, binaire vérifié par SHA-256) | 12 alertes dans l'historique, 15 dans le répertoire. **Aucune n'est un vrai secret commité** : ce sont des mots de passe de fixtures de test (`tests/*.test.ts`) et la clé factice `sk-cle-secrete-de-test-…`. Les vrais secrets sont dans `.env`, ignoré par git et absent de l'historique. |
| **SkillSpector** (NVIDIA, mode statique `--no-llm`) | Outil conçu pour auditer des *skills d'agents IA*, pas des API. Score 100/CRITICAL sans valeur ici : faux positifs (README, tests, `npx prisma`, versions `^`). Les avis « CVE » (SC4) portent sur des versions anciennes ; `npm audit` = **0 vulnérabilité** sur les versions installées. Couverture partielle (82 %). |
| **Strix** | Installé (`strix-agent`), **non exécuté** : exige une clé LLM et envoie le code à un fournisseur tiers. Voir « Suite ». |
| `npm audit` | 0 vulnérabilité (dev + prod). |
| Revue manuelle + PoC dynamiques | API lancée sur une base jetable (supprimée ensuite), IA désactivée, aucune clé réelle utilisée. Scripts : `poc1.mjs`, `poc2.mjs`, `poc3.mjs`. |

## Ce qui a été testé et qui est SOLIDE (non exploitable)

IDOR sur tickets/messages/feedback (404) · élévation de rôle via PATCH (403) · mass assignment (`.strict()` → 400) · JWT `alg=none` et payload modifié (401) · injection SQL / `sortBy` (Prisma + enums Zod) · contournement du rate-limit par `X-Forwarded-For` (ignoré) · accès `/audit-logs`, `/users`, `/ai/status` par rôles insuffisants (403) · hash des jetons en base, rotation des refresh tokens avec détection de réutilisation · JWT secret de 96 caractères.

---

## Fiches de vulnérabilités

### VULN-001 — Mot de passe Super Admin codé en dur dans un script non ignoré
- **Où** : `scripts/test-deepseek.ts:18` (fichier *untracked*, absent de `.gitignore`).
- **Criticité** : **Élevée** (devient **Critique** s'il est commité/poussé).
- **Exploitation** : le fallback `process.env.SUPER_ADMIN_PASSWORD ?? "<mot de passe>"` contient le mot de passe réel (**vérifié identique à celui de `.env`**). Un `git add .` / `git add -A` suffit à le publier ; quiconque lit le dépôt se connecte via `POST /auth/login` en Super Admin (lecture du journal d'audit, gestion de tous les comptes).
- **Preuve** : comparaison programmatique `.env` ↔ script = identiques ; `git status` → `?? scripts/test-deepseek.ts`, `git check-ignore` → non ignoré. (gitleaks ne l'a pas détecté.)
- **Correction** : supprimer le fallback (`const ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD; if (!ADMIN_PASSWORD) throw …`), ajouter `scripts/test-*.ts` à `.gitignore` ou supprimer le script, **changer le mot de passe Super Admin**, activer `gitleaks` en pre-commit/CI.
- **Impact utilisateurs** : si publié, prise de contrôle de tous les comptes et lecture des tickets/emails.
- **Impact entreprise** : compromission totale de l'application, fuite de données, incident à notifier (RGPD, 72 h), perte de confiance.

### VULN-002 — PostgreSQL et Mailpit exposés sur toutes les interfaces avec identifiants par défaut
- **Où** : `docker-compose.yml` (`ports: "5433:5432"`, `"8026:8025"`, `"1026:1025"`, `ticket_user/ticket_password`).
- **Criticité** : **Élevée** en développement (Critique si ce compose sert ailleurs qu'en local).
- **Exploitation** : toute machine du même réseau (Wi-Fi public, VPN, LAN) se connecte à la base avec `ticket_user/ticket_password`, ou ouvre l'interface Mailpit **sans authentification** : elle contient les e-mails d'invitation/réinitialisation → un attaquant prend le jeton et active/réinitialise le compte (y compris un ADMIN invité).
- **Preuve** (`poc3.mjs`, `netstat` : `0.0.0.0:5433`, `0.0.0.0:8026`) : depuis l'adresse non-loopback `192.168.56.1` → Mailpit HTTP 200 (jetons lisibles) ; `pg` avec `ticket_user/ticket_password` → `SELECT` sur `User` réussi, lecture des hash bcrypt. (Adresse = carte hôte VirtualBox ; la liaison `0.0.0.0` l'expose sur toutes les interfaces.)
- **Correction** : `"127.0.0.1:5433:5432"`, `"127.0.0.1:8026:8025"`, `"127.0.0.1:1026:1025"` ; mot de passe via `${POSTGRES_PASSWORD}` (fichier `.env` non commité) ; figer la version de `axllent/mailpit`.
- **Impact utilisateurs** : vol de données personnelles et de comptes.
- **Impact entreprise** : fuite de base complète, prise de contrôle de comptes privilégiés ; si répliqué en production, compromission totale.

### VULN-003 — Verrouillage de compte exploitable pour un déni de service ciblé
- **Où** : `src/services/auth.service.ts` (`registerFailedLogin`, `login`), `LOGIN_MAX_ATTEMPTS=5`, `LOGIN_LOCK_MINUTES=15`.
- **Criticité** : **Moyenne**.
- **Exploitation** : l'attaquant envoie 5 mauvais mots de passe pour l'e-mail d'une victime (ex. le Super Admin) ; le compte est verrouillé 15 min, **même avec le bon mot de passe**. Il répète toutes les 15 min → blocage permanent d'un compte clé, avec 5 requêtes.
- **Preuve** (`poc2.mjs known`) : 5× `401`, puis connexion **avec le bon mot de passe** → `429 "Compte temporairement verrouillé…"`.
- **Correction** : verrouiller par couple (compte + IP) ou appliquer un délai progressif/CAPTCHA plutôt qu'un blocage dur ; ne pas bloquer le bon mot de passe d'un appareil déjà connu ; alerter l'utilisateur ; garder le limiteur IP.
- **Impact utilisateurs** : impossible de se connecter / d'ouvrir un ticket urgent.
- **Impact entreprise** : indisponibilité du support, comptes admin bloqués pendant un incident.

### VULN-004 — Énumération de comptes via la réponse de verrouillage
- **Où** : `src/services/auth.service.ts` (`login`, lignes 61-63).
- **Criticité** : **Moyenne** (Faible isolée ; facilite VULN-003 et le phishing ciblé).
- **Exploitation** : après 5 échecs, un e-mail **existant** renvoie `429` alors qu'un e-mail inexistant renvoie toujours `401`. L'attaquant teste une liste d'e-mails (5 essais chacun) et sait lesquels sont des comptes.
- **Preuve** (`poc2.mjs`) : existant → 5×`401` puis `429` ; inexistant → 6×`401`.
- **Correction** : appliquer le même compteur/verrou aux e-mails inconnus (compteur par e-mail en cache/table) pour répondre identiquement, ou renvoyer `401` générique avec `Retry-After` uniforme.
- **Impact utilisateurs** : exposition de l'existence de leur compte, spear-phishing.
- **Impact entreprise** : cartographie des employés/rôles, étape préparatoire d'une attaque.

### VULN-005 — Énumération de comptes par temps de réponse de `/auth/forgot-password`
- **Où** : `src/services/auth.service.ts` `forgotPassword` (retour immédiat si inconnu ; écriture DB + envoi d'e-mail sinon).
- **Criticité** : **Faible**.
- **Exploitation** : mesurer la latence : compte existant ≈ 80 ms (≈ plus en prod avec l'appel HTTP Brevo), inexistant ≈ 5 ms.
- **Preuve** (`poc2.mjs`) : médiane **84 ms** (existant) vs **5 ms** (inexistant), 5 mesures chacun (limite 5/15 min/IP).
- **Correction** : traiter l'envoi en tâche de fond (file/`setImmediate`) et répondre aussitôt dans tous les cas, ou égaliser le temps.
- **Impact utilisateurs** : divulgation d'existence de compte. **Entreprise** : même base que VULN-004.

### VULN-006 — Jetons d'accès toujours valides après déconnexion / réinitialisation de mot de passe
- **Où** : `src/services/token.service.ts`, `src/middlewares/authenticate.ts` (JWT sans révocation, TTL 15 min).
- **Criticité** : **Faible**.
- **Exploitation** : un jeton volé reste utilisable jusqu'à 15 min après `logout` ou `reset-password`.
- **Preuve** (`poc1.mjs` A1/A2) : `POST /auth/logout` → 204, puis `GET /auth/me` avec l'ancien jeton → **200**.
- **Correction** : ajouter `tokenVersion` (ou `passwordChangedAt`) dans le JWT et le comparer dans `authenticate` ; l'incrémenter au logout/reset/changement de rôle.
- **Impact utilisateurs** : session volée non coupée immédiatement. **Entreprise** : fenêtre d'abus courte après incident.

### VULN-007 — Contenu des tickets envoyé à un LLM tiers (RGPD) et influence de l'utilisateur sur la priorité
- **Où** : `src/ai/prompts/triage.ts`, `src/ai/prompts/reply.ts`, `src/ai/guards.ts` (`neutralizeUntrusted`), `deepseek-client.ts`.
- **Criticité** : **Moyenne** (conformité) ; injection de prompt : **Faible**.
- **Exploitation** : le titre/description libres (souvent mots de passe, IP, noms de serveurs, données personnelles collés par les utilisateurs) partent chez DeepSeek sans masquage. Par ailleurs, une injection ne peut pas fermer d'autres tickets ni publier de lien (filtre + texte de refus fixe), mais peut pousser la priorité à `URGENT` pour passer devant la file.
- **Preuve** : revue de code (`buildTriageMessages` n'envoie ni e-mail ni identifiant, mais aucun masquage du texte libre). **Non exploité dynamiquement** : IA désactivée dans mon instance pour ne pas utiliser votre clé ni envoyer de données.
- **Correction** : masquer secrets/e-mails/IP/numéros avant envoi, informer les utilisateurs, DPA/hébergement UE ou modèle auto-hébergé, journaliser sans contenu (déjà fait), bornes `priority` dépendantes d'un humain pour `URGENT`.
- **Impact utilisateurs** : données personnelles/identifiants hors UE. **Entreprise** : non-conformité RGPD (transferts), risque CNIL.

### VULN-008 — Champs internes de l'IA exposés aux utilisateurs finaux
- **Où** : `src/controllers/ticket.controller.ts` / `ticket.service.ts` (le `Ticket` complet est renvoyé).
- **Criticité** : **Faible**.
- **Preuve** (`poc1.mjs`) : un `USER` reçoit `createdById`, `requestedPriority`, `priorityLockedByHuman`, `aiPriorityReason`, `aiEscalationReason`.
- **Exploitation** : étude du fonctionnement interne (seuils, verrou de priorité) pour affiner une injection de prompt.
- **Correction** : DTO de sortie (`toPublicTicket`) pour les `USER`, champs internes réservés à l'équipe support.
- **Impact** : fuite d'informations internes, faible ; aide à l'abus de l'IA.

### VULN-009 — Rate-limit par IP : `TRUST_PROXY=0` par défaut derrière un reverse proxy
- **Où** : `src/app.ts:20`, `src/config/env.ts` (`TRUST_PROXY`), `src/middlewares/rate-limit.ts`.
- **Criticité** : **Moyenne** (risque de déploiement).
- **Exploitation** : derrière nginx/Cloudflare/Vercel, tous les clients partagent l'IP du proxy : 10 connexions / 15 min pour **toute l'entreprise** → déni de service par un seul attaquant ; à l'inverse, un `TRUST_PROXY` trop large permettrait d'usurper l'IP. Limiteur en mémoire : non partagé entre instances.
- **Preuve** : `poc2.mjs xff` : l'usurpation `X-Forwarded-For` **ne** contourne **pas** le limiteur (config actuelle sûre en direct) ; le défaut devient problématique derrière un proxy (revue de code).
- **Correction** : documenter/imposer `TRUST_PROXY=<nb de proxys>` en production, store Redis pour `express-rate-limit`, limiteur par compte en plus de l'IP.
- **Impact utilisateurs** : impossibilité de se connecter. **Entreprise** : indisponibilité en production.

### VULN-010 — Création de tickets sans limite dédiée ni plafond de description
- **Où** : `src/routes/ticket.routes.ts` (`POST /`), `src/schemas/ticket.schema.ts` (description sans `.max()`, plafond seulement 100 Ko via `express.json`).
- **Criticité** : **Faible**.
- **Exploitation** : un compte `USER` crée jusqu'à 300 tickets/15 min de ~95 Ko (≈ 28 Mo/15 min ≈ 2,7 Go/jour) et déclenche des appels LLM payants (budget global 200 000 jetons/jour partagé → l'IA se désactive pour tous).
- **Preuve** : ticket de 95 Ko accepté (`201`) (`poc1.mjs` D1).
- **Correction** : `.max(4000)` sur la description (cohérent avec `limits.description`), `ticketCreateLimiter` par utilisateur, quota de tickets ouverts par utilisateur.
- **Impact** : lenteur, base gonflée ; **Entreprise** : coût d'hébergement et facture API.

### VULN-011 — Documentation de l'API publique sans authentification
- **Où** : `GET /docs`, `GET /openapi.json`, `GET /health`.
- **Criticité** : **Faible / informative**.
- **Preuve** : `200` sans jeton (`poc1.mjs` I1/I2).
- **Correction** : protéger `/docs` en production (auth ou désactivation selon `NODE_ENV`) ; `/health` sans détail de la base.
- **Impact** : cartographie de la surface d'attaque pour un attaquant.

### VULN-012 — Hygiène CI/CD et mots de passe
- **Où** : `.github/workflows/ci.yml` (actions par tag `@v4`, pas de `npm audit`, pas de gitleaks) ; `src/schemas/auth.schema.ts` (mot de passe : 10 caractères, 1 lettre + 1 chiffre, pas de vérification de fuite, pas de MFA).
- **Criticité** : **Faible**.
- **Correction** : épingler les actions par SHA, ajouter `npm audit --omit=dev` et `gitleaks/gitleaks-action`, activer Dependabot ; viser 12+ caractères / liste de mots de passe compromis (zxcvbn, HIBP k-anonymity), MFA pour ADMIN/SUPER_ADMIN.
- **Impact** : risque supply-chain et comptes faibles, probabilité basse.

---

## Actions immédiates (ordre de priorité)
1. Supprimer/corriger `scripts/test-deepseek.ts` **avant tout commit** ; changer le mot de passe Super Admin.
2. Lier les ports Docker à `127.0.0.1` et changer le mot de passe Postgres.
3. **Régénérer les clés Brevo** (exposées pendant une session précédente) et surveiller la clé DeepSeek.
4. Corriger VULN-003/004 (verrouillage) et VULN-009 (proxy) avant la mise en production.

## Suite
Les corrections (code avant/après) et les **retests** exigés par le cahier des charges n'ont pas encore été appliqués : je n'ai pas modifié le code. Strix reste à lancer sur l'instance locale une fois une clé LLM choisie.
