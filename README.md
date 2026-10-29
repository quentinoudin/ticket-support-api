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
| `APP_URL` | Base des liens envoyés par email | `http://localhost:3000` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM` | Serveur d'envoi | Mailpit local |
| `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD` | Compte créé par le seed | — |

La base de test doit exister une fois : `docker exec ticket-support-postgres createdb -U ticket_user ticket_support_test`. Les migrations y sont appliquées automatiquement avant les tests, qui ne touchent jamais la base de développement.

## Scripts

| Commande | Rôle |
| --- | --- |
| `npm run dev` | Lance l'API en mode watch |
| `npm run build` / `npm start` | Compile puis lance la version compilée |
| `npm run typecheck` | Vérifie les types |
| `npm test` | Tests d'intégration (Vitest + Supertest) |
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

Liste : `GET /tickets?page=1&limit=10&status=OPEN&priority=HIGH` (`limit` maximum 100, tri du plus récent au plus ancien). La réponse contient `data` et `pagination`.

### Comptes

`GET /users?page=1&limit=10&role=AGENT&status=ACTIVE&search=dupont` : filtres facultatifs, `search` porte sur l'email.

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

| Code | Cas |
| --- | --- |
| `400` | Données invalides (détail par champ), JSON mal formé, lien invalide ou expiré |
| `401` | Jeton absent, invalide ou expiré, identifiants incorrects |
| `403` | Rôle insuffisant, compte désactivé |
| `404` | Route, ticket ou utilisateur introuvable (ou hors de portée) |
| `409` | Conflit (email déjà utilisé, invitation d'un compte déjà actif) |
| `429` | Trop de tentatives sur les routes d'authentification |
| `500` | Erreur interne inattendue |
| `503` | PostgreSQL indisponible (sur `/health`) |

## Sécurité

- Mots de passe hachés avec bcrypt (coût 12), 10 à 72 caractères avec au moins une lettre et un chiffre.
- Refresh tokens, invitations et liens de réinitialisation : jetons aléatoires de 32 octets, **seul leur hash SHA-256 est stocké**. Ils sont à usage unique et consommés de façon atomique.
- Rotation des refresh tokens avec détection de réutilisation : un ancien jeton rejoué révoque toute la chaîne.
- Le compte est rechargé à chaque requête : un compte désactivé perd l'accès immédiatement, et ses refresh tokens sont révoqués.
- Même réponse pour un email inconnu ou un mauvais mot de passe, et pour `forgot-password` quel que soit l'email.
- `helmet` et limitation de débit (20 requêtes par 15 minutes) sur les routes d'authentification.
- Une réinitialisation de mot de passe révoque toutes les sessions ouvertes.

## Structure

```text
├── docker-compose.yml        # PostgreSQL + Mailpit
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed-super-admin.ts
├── tests/                    # Vitest + Supertest
└── src/
    ├── app.ts, server.ts
    ├── config/env.ts         # variables d'environnement validées au démarrage
    ├── auth/permissions.ts   # hiérarchie des rôles et portée de gestion
    ├── routes/               # auth, users, tickets
    ├── controllers/          # validation Zod + réponses HTTP
    ├── services/             # logique métier (auth, user, ticket, token, mail)
    ├── middlewares/          # authenticate, authorize, rate-limit, erreurs
    ├── schemas/              # schémas Zod
    ├── lib/                  # client Prisma, bcrypt
    └── generated/            # client Prisma généré (ignoré par git)
```
