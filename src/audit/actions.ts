// Actions enregistrées dans le journal d'audit.
export const auditActions = [
  // Connexion et mot de passe
  "LOGIN_SUCCESS",
  "LOGIN_FAILED",
  "ACCOUNT_LOCKED",
  "PASSWORD_RESET_REQUESTED",
  "PASSWORD_RESET_COMPLETED",
  "INVITE_ACCEPTED",
  // Gestion des comptes
  "USER_INVITED",
  "USER_INVITE_RESENT",
  "USER_UPDATED",
  "USER_ROLE_CHANGED",
  "USER_DISABLED",
  "USER_ENABLED",
  "USER_DELETED",
  // Tickets
  "TICKET_CREATED",
  "TICKET_UPDATED",
  "TICKET_REPLACED",
  "TICKET_DELETED",
  "TICKET_MESSAGE_ADDED",
  // Assistant IA (acteur : « ai-assistant »)
  "AI_REPLIED",
  "AI_PRIORITY_CHANGED",
  "AI_ESCALATED",
  "AI_OFF_TOPIC_CLOSED",
] as const;

export type AuditAction = (typeof auditActions)[number];
