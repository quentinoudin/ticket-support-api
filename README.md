# API de tickets de support

API REST backend de gestion de tickets de support, avec authentification, rôles et invitation par email. Sans frontend.

**Stack :** Node.js (>= 22), Express 5, TypeScript, PostgreSQL, Prisma 7, Zod, JWT, bcrypt, Nodemailer, Vitest.

## Démarrage rapide

```bash
npm install
cp .env.example .env          # puis remplacez JWT_ACCESS_SECRET et le mot de passe du Super Admin
docker compose up -d          # PostgreSQL (5433) + Mailpit (SMTP 1026, interface 8026)
npx prisma generate
npx prisma migrate deploy
npm run seed:super-admin      # crée le Super Admin depuis le .env
npm run dev
```

L'API est disponible sur http://localhost:3000. Les emails envoyés en développement se lisent sur http://localhost:8026 (Mailpit).

**Documentation interactive (Swagger) :** http://localhost:3000/docs. Le fichier OpenAPI brut est sur http://localhost:3000/openapi.json. Cliquez sur *Authorize*, collez l'`accessToken` obtenu par `POST /auth/login`, puis testez chaque route depuis le navigateur.

### Variables d'environnement

| Variable | Rôle | Défaut |
| --- | --- | --- |
| `DATABASE_URL` | Base de développement | obligatoire |
| `DATABASE_URL_TEST` | Base utilisée par les tests | obligatoire pour `npm test` |
| `JWT_ACCESS_SECRET` | Secret de signature des access tokens (32 caractères minimum) | obligatoire |
| `JWT_ACCESS_TTL` | Durée de l'access token | `15m` |
| `REFRESH_TTL_DAYS` | Durée du refresh token | `7` |
| `INVITE_TTL_HOURS` | Validité d'une invitation | `48` |
| `RESET_TTL_MINUTES` | Validité d'un lien de réinitialisation | `60` |
| `LOGIN_MAX_ATTEMPTS` | Échecs de connexion consécutifs avant verrouillage du compte | `5` |
| `LOGIN_LOCK_MINUTES` | Durée du verrouillage | `15` |
| `TRUST_PROXY` | Nombre de proxys de confiance devant l'API (0 = aucun). À régler derrière un reverse proxy, sinon toutes les requêtes semblent venir de la même adresse IP | `0` |
| `APP_URL` | Base des liens envoyés par email | `http://localhost:3000` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM` | Serveur d'envoi | Mailpit local |
| `BREVO_API_KEY` | Envoi par l'API HTTP de Brevo (port 443) au lieu du SMTP, utile si le réseau bloque le SMTP. Remplace le SMTP quand elle est renseignée. `MAIL_FROM` doit être un expéditeur vérifié dans Brevo | vide |
| `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD` | Compte créé par le seed | — |

La base de test doit exister une fois : `docker exec ticket-support-postgres createdb -U ticket_user ticket_support_test`. Les migrations y sont appliquées automatiquement avant les tests, qui ne touchent jamais la base de développement.

## Scripts

| Commande | Rôle |
| --- | --- |
| `npm run dev` | Lance l'API en mode watch |
| `npm run build` / `npm start` | Compile puis lance la version compilée |
| `npm run typecheck` | Vérifie les types |
| `npm test` | Tests unitaires et d'intégration (Vitest + Supertest), sur la base de test |
| `npm run seed:super-admin` | Crée le Super Admin s'il n'existe pas (idempotent) |
| `npm run prisma:migrate` / `prisma:generate` / `prisma:studio` | Outils Prisma |

## Authentification : le parcours

```text
Seed          .env -> npm run seed:super-admin -> SUPER_ADMIN actif

Invitation    Super Admin / Admin  POST /users {email, role}
                -> compte INVITED + email avec un lien à usage unique (48 h)
              Invité               POST /auth/accept-invite {token, password}
                -> compte ACTIF, il choisit lui-même son mot de passe

Connexion     POST /auth/login {email, password} -> accessToken (15 min) + refreshToken (7 j)
              Authorization: Bearer <accessToken> sur toutes les routes protégées
              POST /auth/refresh {refreshToken}  -> nouveau couple, l'ancien refresh est révoqué
              POST /auth/logout  {refreshToken}  -> refresh révoqué

Oubli         POST /auth/forgot-password {email}  -> toujours la même réponse
              POST /auth/reset-password {token, password} -> mot de passe changé, sessions révoquées
```

Il n'y a **aucune inscription publique**. États d'un compte : `INVITED` -> `ACTIVE` <-> `DISABLED`.

Les liens des emails contiennent le jeton, mais ils ne le consomment pas : on appelle l'endpoint `POST` correspondant avec le jeton (Postman, curl...). Cela évite qu'un aperçu de lien ou un antivirus utilise le jeton à la place de l'utilisateur.

## Routes

| Méthode | Route | Accès |
| --- | --- | --- |
| `GET` | `/health` | Public |
| `POST` | `/auth/login`, `/auth/refresh`, `/auth/logout` | Public |
| `POST` | `/auth/accept-invite`, `/auth/forgot-password`, `/auth/reset-password` | Public |
| `GET` | `/auth/me` | Connecté |
| `POST` | `/users` (inviter) | Admin, Super Admin |
| `GET` | `/users`, `/users/:id` | Admin, Super Admin |
| `PATCH` | `/users/:id` (email, rôle) | Admin, Super Admin |
| `POST` | `/users/:id/disable`, `/enable`, `/resend-invite` | Admin, Super Admin |
| `GET` | `/users/super-admin` | **Super Admin uniquement** |
| `DELETE` | `/users/:id` | Super Admin uniquement |
| `POST` `GET` | `/tickets`, `/tickets/:id` | Connecté (voir matrice) |
| `PUT` | `/tickets/:id` | Agent et au-dessus |
| `PATCH` | `/tickets/:id` | Connecté (voir matrice) |
| `DELETE` | `/tickets/:id` | Admin et au-dessus |
| `GET` | `/audit-logs` | **Super Admin uniquement** |
| `GET` | `/docs`, `/openapi.json` | Public (documentation) |

### Rôles

| Action | USER | AGENT | ADMIN | SUPER_ADMIN |
| --- | --- | --- | --- | --- |
| Créer un ticket | oui | oui | oui | oui |
| Lister / lire les tickets | les siens | tous | tous | tous |
| `PATCH` un ticket | titre et description des siens | tous les champs | tous | tous |
| `PUT` un ticket | non | oui | oui | oui |
| Supprimer un ticket | non | non | oui | oui |
| Gérer les comptes | non | non | AGENT et USER | ADMIN, AGENT et USER |

Un compte hors de la portée de l'acteur répond `404` (il n'est pas révélé). Le compte Super Admin n'apparaît jamais dans `GET /users` : seul `GET /users/super-admin` l'expose, uniquement au Super Admin. Personne ne peut le modifier, le désactiver ou le supprimer via l'API.

### Tickets

| Champ | Règle |
| --- | --- |
| `title` | Obligatoire, 200 caractères maximum |
| `description` | Obligatoire |
| `status` | `OPEN` (défaut), `IN_PROGRESS`, `CLOSED` |
| `priority` | `LOW`, `MEDIUM` (défaut), `HIGH`, `URGENT` |
| `createdById` | Rempli automatiquement avec l'auteur, jamais accepté du client |

Liste : `GET /tickets?page=1&limit=10&status=OPEN&priority=HIGH&sortBy=priority&order=desc`. La réponse contient `data` et `pagination`. Pagination, filtres et tri sont faits côté serveur.

| Paramètre | Règle |
| --- | --- |
| `page`, `limit` | `1` et `10` par défaut, `limit` maximum 100 |
| `status`, `priority` | Filtres facultatifs |
| `sortBy` | `createdAt` (défaut), `updatedAt`, `title`, `status`, `priority` |
| `order` | `desc` (défaut) ou `asc` |

La priorité se trie par gravité (`LOW` < `MEDIUM` < `HIGH` < `URGENT`), pas par ordre alphabétique. Un tri secondaire par identifiant garde la pagination stable.

### Comptes

`GET /users?page=1&limit=10&role=AGENT&status=ACTIVE&search=dupont&sortBy=email&order=asc` : filtres facultatifs, `search` porte sur l'email. Tri possible sur `createdAt`, `email`, `role`, `status` et `lastLoginAt`.

### Journal d'audit

`GET /audit-logs` (Super Admin) liste les actions sensibles, de la plus récente à la plus ancienne. Filtres : `action`, `actorId`, `targetType` (`User` ou `Ticket`), `targetId`, `from`, `to` (dates ISO), `order`, `page` et `limit`.

Actions enregistrées :

| Domaine | Actions |
| --- | --- |
| Connexion | `LOGIN_SUCCESS`, `LOGIN_FAILED`, `ACCOUNT_LOCKED` |
| Mot de passe | `PASSWORD_RESET_REQUESTED`, `PASSWORD_RESET_COMPLETED`, `INVITE_ACCEPTED` |
| Comptes | `USER_INVITED`, `USER_INVITE_RESENT`, `USER_UPDATED`, `USER_ROLE_CHANGED`, `USER_DISABLED`, `USER_ENABLED`, `USER_DELETED` |
| Tickets | `TICKET_CREATED`, `TICKET_UPDATED`, `TICKET_REPLACED`, `TICKET_DELETED` |

Chaque entrée garde l'acteur, la cible, l'adresse IP, le navigateur et la date. Un changement de rôle conserve l'ancienne et la nouvelle valeur. Le journal ne contient **jamais** de mot de passe, de jeton ni le contenu d'un ticket (seulement le nom des champs modifiés). Il n'a pas de clé étrangère vers les comptes : l'historique survit à la suppression d'un utilisateur. Si l'écriture du journal échoue, l'action est quand même effectuée et l'erreur est affichée dans les logs du serveur.

## Exemples

Connexion :

```bash
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"superadmin@ticket.local","password":"<mot de passe du .env>"}'
```

Inviter un agent :

```bash
curl -X POST http://localhost:3000/users \
  -H "Authorization: Bearer <accessToken>" -H "Content-Type: application/json" \
  -d '{"email":"agent@exemple.com","role":"AGENT"}'
```

La réponse contient `emailSent`. S'il vaut `false`, le compte existe mais l'email n'est pas parti : utilisez `POST /users/:id/resend-invite`.

> Sous Windows (Git Bash), `curl` n'envoie pas toujours de l'UTF-8 : les accents peuvent être altérés. Préférez Postman, Insomnia ou PowerShell.

## Erreurs

Toutes les erreurs ont la même forme, avec un `code` lisible par un programme :

```json
{
  "error": "Données invalides",
  "code": "VALIDATION_ERROR",
  "details": [{ "field": "title", "message": "Le titre est obligatoire" }]
}
```

`details` n'est présent que pour `VALIDATION_ERROR`. Les réponses de succès enveloppent leurs données dans `data` (avec `pagination` pour les listes).

| Statut | `code` | Cas |
| --- | --- | --- |
| `400` | `VALIDATION_ERROR` | Données invalides (détail par champ) |
| `400` | `INVALID_JSON` | Corps JSON mal formé |
| `400` | `BAD_REQUEST` | Lien invalide ou expiré |
| `401` | `UNAUTHORIZED` | Jeton absent, invalide ou expiré, identifiants incorrects |
| `403` | `FORBIDDEN` | Rôle insuffisant, compte désactivé |
| `404` | `NOT_FOUND` | Route, ticket ou utilisateur introuvable (ou hors de portée) |
| `409` | `CONFLICT` | Email déjà utilisé, invitation d'un compte déjà actif |
| `413` | `PAYLOAD_TOO_LARGE` | Corps de requête supérieur à 100 ko |
| `429` | `RATE_LIMITED` | Trop de requêtes, ou compte verrouillé |
| `500` | `INTERNAL_ERROR` | Erreur interne (le détail reste dans les logs, jamais dans la réponse) |
| `503` | — | PostgreSQL indisponible (sur `/health`) |

## Sécurité

- Mots de passe hachés avec bcrypt (coût 12), 10 à 72 caractères avec au moins une lettre et un chiffre.
- Refresh tokens, invitations et liens de réinitialisation : jetons aléatoires de 32 octets, **seul leur hash SHA-256 est stocké**. Ils sont à usage unique et consommés de façon atomique.
- Rotation des refresh tokens avec détection de réutilisation : un ancien jeton rejoué révoque toute la chaîne.
- Le compte est rechargé à chaque requête : un compte désactivé perd l'accès immédiatement, et ses refresh tokens sont révoqués.
- Même réponse pour un email inconnu ou un mauvais mot de passe, et pour `forgot-password` quel que soit l'email.
- Une réinitialisation de mot de passe révoque toutes les sessions ouvertes.
- `helmet` pose les en-têtes de sécurité (CSP, HSTS, `nosniff`) et l'API n'annonce pas Express.

### Protection contre les abus

| Protection | Réglage |
| --- | --- |
| Limite globale par adresse IP | 300 requêtes par 15 minutes (hors `/health` et `/docs`) |
| `POST /auth/login` | 10 requêtes par 15 minutes et par adresse IP |
| `forgot-password`, `reset-password` | 5 requêtes par 15 minutes et par adresse IP |
| `refresh`, `accept-invite` | 20 requêtes par 15 minutes et par adresse IP |
| Verrouillage du compte | 5 échecs consécutifs, puis 15 minutes (`LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCK_MINUTES`) |
| Taille du corps JSON | 100 ko maximum |

Un dépassement répond `429` avec un en-tête `Retry-After`. Un compte verrouillé refuse même le bon mot de passe jusqu'à la fin du délai, et une réinitialisation de mot de passe lève le verrou. Le verrouillage s'applique aux comptes existants : un email inconnu répond toujours `401`. Les limites par adresse IP exigent que `TRUST_PROXY` soit réglé derrière un reverse proxy.

### Injection SQL et validation

- Toutes les requêtes passent par Prisma, qui les paramètre : aucune donnée utilisateur n'est jamais concaténée dans du SQL.
- Chaque entrée (corps, paramètres d'adresse, filtres, tri) est validée par un schéma Zod strict : un champ inconnu, un mauvais type, un identifiant qui n'est pas un UUID ou un tri hors liste blanche est refusé en `400` avant toute requête.
- Les champs de tri sont une liste blanche : impossible de trier sur `passwordHash`.
- Les suites de tests injectent des payloads SQL, NoSQL et de pollution de prototype, et vérifient qu'ils sont stockés tels quels ou refusés, sans jamais altérer la base.

## Tests et intégration continue

```bash
npm test                  # tout lancer
npm test -- tests/unit    # seulement les tests unitaires (sans base de données)
```

- `tests/unit/` : permissions, hachage des mots de passe, jetons JWT (altérés, expirés, algorithme `none`), schémas de validation.
- `tests/*.test.ts` : tests d'intégration de l'API sur une base PostgreSQL dédiée, qui couvrent l'authentification, les rôles, l'accès aux tickets, l'invitation, la réinitialisation, le tri, les limites de requêtes, le verrouillage, le journal d'audit, la documentation OpenAPI et la sécurité.

Le workflow GitHub Actions `.github/workflows/ci.yml` lance à chaque push et chaque pull request : vérification des types, tests (avec un service PostgreSQL) et compilation. Les valeurs qu'il utilise (base jetable, secret JWT) ne servent qu'à la CI.

## Structure

```text
├── .github/workflows/ci.yml  # intégration continue
├── docker-compose.yml        # PostgreSQL + Mailpit
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed-super-admin.ts
├── tests/                    # intégration (Vitest + Supertest) et unit/
└── src/
    ├── app.ts, server.ts
    ├── config/env.ts         # variables d'environnement validées au démarrage
    ├── auth/permissions.ts   # hiérarchie des rôles et portée de gestion
    ├── audit/actions.ts      # liste des actions du journal d'audit
    ├── docs/openapi.ts       # spécification OpenAPI générée depuis les schémas Zod
    ├── routes/               # auth, users, tickets, audit
    ├── controllers/          # validation Zod + réponses HTTP
    ├── services/             # logique métier (auth, user, ticket, token, mail, audit)
    ├── middlewares/          # authenticate, authorize, rate-limit, erreurs
    ├── schemas/              # schémas Zod
    ├── lib/                  # client Prisma, bcrypt, contexte de requête
    └── generated/            # client Prisma généré (ignoré par git)
```
