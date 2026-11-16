// PostgreSQL ne peut pas stocker le caractère nul (U+0000) dans un texte : sans ce contrôle,
// une requête hostile provoquerait une erreur 500 au lieu d'un refus clair.
export const noNullCharacter = (value: string) => !value.includes("\u0000");

export const NULL_CHARACTER_MESSAGE = "Le texte contient un caractère interdit";
