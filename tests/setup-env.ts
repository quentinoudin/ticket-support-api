import "dotenv/config";

const testUrl = process.env.DATABASE_URL_TEST;

if (!testUrl) {
  throw new Error("DATABASE_URL_TEST est obligatoire pour lancer les tests");
}

// Les tests ne doivent jamais toucher la base de développement.
process.env.DATABASE_URL = testUrl;
process.env.NODE_ENV = "test";
