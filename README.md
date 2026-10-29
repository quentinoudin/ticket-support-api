# API de tickets de support

API REST backend de gestion de tickets de support, sans authentification et sans frontend.

**Stack :** Node.js (>= 22), Express 5, TypeScript, PostgreSQL, Prisma 7, Zod.

## Démarrage rapide

```bash
npm install
cp .env.example .env
docker compose up -d
npx prisma generate
npx prisma migrate deploy
npm run dev
```

L'API est disponible sur http://localhost:3000.

Le fichier `.env` contient :

```text
PORT=3000
DATABASE_URL="postgresql://ticket_user:ticket_password@localhost:5433/ticket_support?schema=public"
```

PostgreSQL tourne dans Docker et est exposé sur le port **5433** (pour ne pas entrer en conflit avec une instance locale sur 5432).

## Scripts

| Commande | Rôle |
| --- | --- |
| `npm run dev` | Lance l'API en mode watch (`tsx`) |
| `npm run build` | Compile TypeScript vers `dist/` |
| `npm start` | Lance la version compilée |
| `npm run typecheck` | Vérifie les types sans compiler |
| `npm run prisma:generate` | Génère le client Prisma dans `src/generated/prisma` |
| `npm run prisma:migrate` | Crée/applique une migration en développement |
| `npm run prisma:studio` | Ouvre l'interface web de consultation de la base |

## Le ticket

| Champ | Type | Règle |
| --- | --- | --- |
| `id` | UUID | Généré automatiquement |
| `title` | texte | Obligatoire, 200 caractères maximum |
| `description` | texte | Obligatoire |
| `status` | `OPEN`, `IN_PROGRESS`, `CLOSED` | `OPEN` par défaut à la création |
| `priority` | `LOW`, `MEDIUM`, `HIGH`, `URGENT` | `MEDIUM` par défaut à la création |
| `createdAt` | date | Automatique |
| `updatedAt` | date | Automatique |

## Routes

| Méthode | Route | Comportement |
| --- | --- | --- |
| `GET` | `/health` | Vérifie Express et la connexion PostgreSQL |
| `POST` | `/tickets` | Crée un ticket |
| `GET` | `/tickets` | Liste paginée et filtrée |
| `GET` | `/tickets/:id` | Récupère un ticket par UUID |
| `PUT` | `/tickets/:id` | Remplace les 4 champs modifiables (tous obligatoires) |
| `PATCH` | `/tickets/:id` | Modifie un ou plusieurs champs (au moins un) |
| `DELETE` | `/tickets/:id` | Supprime le ticket (`204`) |

### Liste : pagination et filtres

```text
GET /tickets?page=1&limit=10&status=OPEN&priority=HIGH
```

- `page` : défaut `1`
- `limit` : défaut `10`, maximum `100`
- `status`, `priority` : filtres facultatifs
- Tri : du plus récent au plus ancien

Réponse :

```json
{
  "data": [],
  "pagination": { "page": 1, "limit": 10, "total": 0, "totalPages": 0 }
}
```

## Exemples

Création :

```bash
curl -X POST http://localhost:3000/tickets \
  -H "Content-Type: application/json" \
  -d '{"title":"Imprimante en panne","description":"Le service comptabilité n a plus d impression.","priority":"HIGH"}'
```

Modification partielle :

```bash
curl -X PATCH http://localhost:3000/tickets/<id> \
  -H "Content-Type: application/json" \
  -d '{"status":"CLOSED"}'
```

> Sous Windows (Git Bash), `curl` n'envoie pas toujours de l'UTF-8 : les accents peuvent être altérés. Préférez Postman, Insomnia ou PowerShell avec un corps encodé en UTF-8.

## Erreurs

| Code | Cas |
| --- | --- |
| `400` | Données invalides (détail par champ) ou JSON mal formé |
| `404` | Route ou ticket introuvable |
| `409` | Conflit de ressource Prisma |
| `500` | Erreur interne inattendue |
| `503` | PostgreSQL indisponible (sur `/health`) |

Exemple de `400` :

```json
{
  "error": "Données invalides",
  "details": [{ "field": "title", "message": "Le titre est obligatoire" }]
}
```

## Structure

```text
├── docker-compose.yml
├── prisma.config.ts
├── prisma/
│   ├── schema.prisma
│   └── migrations/
└── src/
    ├── app.ts            # application Express, /health
    ├── server.ts         # démarrage et arrêt propre
    ├── routes/           # définition des routes
    ├── controllers/      # validation Zod + réponses HTTP
    ├── services/         # accès aux données via Prisma
    ├── schemas/          # schémas Zod
    ├── middlewares/      # 404 et gestion centralisée des erreurs
    ├── errors/           # AppError
    ├── lib/prisma.ts     # client Prisma (adaptateur pg)
    └── generated/        # client Prisma généré (ignoré par git)
```

## Tester

Avec Postman, Insomnia ou `curl` : importez les URL ci-dessus. Pour parcourir la base directement, lancez `npm run prisma:studio`.
