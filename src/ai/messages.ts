// Textes fixes écrits par nous : l'IA ne les génère jamais, donc une injection de prompt
// ne peut pas les modifier.

export const OFF_TOPIC_REFUSAL = [
  "Bonjour,",
  "",
  "Ce service est réservé au support informatique (ordinateurs, logiciels, réseau, comptes, messagerie, impression, sécurité).",
  "Votre demande ne semble pas en relever, c'est pourquoi ce ticket a été fermé.",
  "",
  "Si c'est une erreur, répondez simplement à ce message : un membre de l'équipe examinera votre demande.",
].join("\n");

export const ESCALATION_NOTICE =
  "Je ne suis pas en mesure de résoudre ce problème moi-même. J'ai transmis votre ticket à l'équipe support, qui vous répondra.";
