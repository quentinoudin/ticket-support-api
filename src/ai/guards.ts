// Garde-fous appliqués au texte qui entre dans les prompts et à celui qui en sort.

const URL_PATTERN = /\b(?:https?|ftp):\/\/\S+|\bwww\.\S+/i;
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const MARKDOWN_LINK_PATTERN = /\]\(/;
// Nom de domaine « nu » (support.exemple.com) : on refuse aussi, un lien piégé n'a pas besoin de http.
const BARE_DOMAIN_PATTERN =
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|fr|io|co|me|ru|cn|info|biz|xyz|top|app|dev|gov|edu|eu|uk|de|es|it|ly|tk|cc|ws|click|link|site|online)\b/i;

// Une réponse de l'IA ne doit contenir ni lien, ni adresse web, ni email : c'est la porte d'entrée
// classique d'une injection de prompt qui cherche à faire cliquer ou écrire à l'utilisateur.
export function containsForbiddenContent(text: string): boolean {
  return (
    URL_PATTERN.test(text) ||
    EMAIL_PATTERN.test(text) ||
    MARKDOWN_LINK_PATTERN.test(text) ||
    BARE_DOMAIN_PATTERN.test(text)
  );
}

// Les balises qui délimitent les données dans nos prompts : un texte hostile ne doit pas pouvoir
// les fermer ou les rouvrir pour faire passer ses phrases pour des instructions.
const OUR_TAGS = /<\s*\/?\s*(?:ticket|conversation|message|system|instruction|instructions)[^>]*>/gi;

export function neutralizeUntrusted(text: string, maxLength: number): string {
  return text
    .replace(/\u0000/g, "")
    .replace(OUR_TAGS, "[balise retirée]")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxLength);
}

export const limits = {
  title: 200,
  description: 4000,
  message: 2000,
  // Nombre de messages de la conversation transmis à l'IA (les plus récents).
  conversationMessages: 10,
} as const;
