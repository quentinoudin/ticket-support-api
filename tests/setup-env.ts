import "dotenv/config";

const testUrl = process.env.DATABASE_URL_TEST;

if (!testUrl) {
  throw new Error("DATABASE_URL_TEST est obligatoire pour lancer les tests");
}

// Les tests ne doivent jamais toucher la base de développement.
process.env.DATABASE_URL = testUrl;
process.env.NODE_ENV = "test";

// Les tests n'appellent JAMAIS le vrai fournisseur d'IA : la clé du .env est écrasée par une
// valeur factice, et l'adresse pointe vers un port fermé en filet de sécurité. Les tests de
// l'assistant injectent un faux client à la place.
process.env.AI_ENABLED = "false";
process.env.DEEPSEEK_API_KEY = "cle-factice-pour-les-tests";
process.env.DEEPSEEK_BASE_URL = "http://127.0.0.1:9";
