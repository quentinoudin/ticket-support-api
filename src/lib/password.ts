import bcrypt from "bcrypt";

const SALT_ROUNDS = 12;

// Hash factice : permet de comparer en temps constant quand l'email est inconnu.
const DUMMY_HASH = bcrypt.hashSync("mot-de-passe-factice", SALT_ROUNDS);

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string | null): Promise<boolean> {
  const matches = await bcrypt.compare(password, hash ?? DUMMY_HASH);
  return hash !== null && matches;
}
