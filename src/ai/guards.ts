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

// Données qui ne doivent jamais quitter l'application vers un fournisseur d'IA tiers : l'assistant n'en
// a pas besoin pour trier ou conseiller, et les utilisateurs en collent souvent dans leurs tickets.
const EMAIL_ANYWHERE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const FR_PHONE = /(?:\+33|0033|\b0)\s?[1-9](?:[\s.-]?\d{2}){4}\b/g;
const SECRET_WORD = /\b(mot de passe|mdp|password|passwd|pwd|code|token|jeton|clé|cle|secret)(\s*(?:est|:|=)?\s*)(\S+)/gi;
const LONG_SECRET = /\b[A-Za-z0-9_-]{32,}\b/g;
const CARD_NUMBER = /\b(?:\d[ -]?){13,19}\b/g;

export function redactSensitive(text: string): string {
  return text
    .replace(EMAIL_ANYWHERE, "[email masqué]")
    .replace(SECRET_WORD, (_all, word: string, sep: string) => `${word}${sep}[secret masqué]`)
    .replace(LONG_SECRET, "[secret masqué]")
    .replace(FR_PHONE, "[téléphone masqué]")
    .replace(CARD_NUMBER, "[numéro masqué]")
    .replace(IPV4, "[adresse IP masquée]");
}

export function neutralizeUntrusted(text: string, maxLength: number): string {
  return redactSensitive(text)
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
