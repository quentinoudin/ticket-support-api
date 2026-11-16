import { execSync } from "node:child_process";

import "dotenv/config";

export default function setup() {
  const testUrl = process.env.DATABASE_URL_TEST;

  if (!testUrl) {
    throw new Error("DATABASE_URL_TEST est obligatoire pour lancer les tests");
  }

  execSync("npx prisma migrate deploy", {
    stdio: "ignore",
    env: { ...process.env, DATABASE_URL: testUrl },
  });
}
