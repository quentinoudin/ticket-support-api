import nodemailer, { type Transporter } from "nodemailer";

import { env } from "../config/env.js";

type MailTransport = Pick<Transporter, "sendMail">;

let transport: MailTransport | undefined;

function getTransport(): MailTransport {
  if (!transport) {
    // En test, aucun email ne part vraiment : on garde le message en mémoire.
    transport =
      process.env.NODE_ENV === "test"
        ? nodemailer.createTransport({ jsonTransport: true })
        : nodemailer.createTransport({
            host: env.SMTP_HOST,
            port: env.SMTP_PORT,
            secure: env.SMTP_PORT === 465,
            ...(env.SMTP_USER && { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? "" } }),
          });
  }

  return transport;
}

// Permet aux tests de capturer les emails envoyés.
export function setMailTransport(next: MailTransport | undefined) {
  transport = next;
}

async function send(to: string, subject: string, text: string) {
  await getTransport().sendMail({ from: env.MAIL_FROM, to, subject, text });
}

export function buildInviteLink(token: string): string {
  return `${env.APP_URL}/auth/accept-invite?token=${encodeURIComponent(token)}`;
}

export function buildResetLink(token: string): string {
  return `${env.APP_URL}/auth/reset-password?token=${encodeURIComponent(token)}`;
}

export function sendInvitationEmail(to: string, token: string) {
  return send(
    to,
    "Invitation à rejoindre le support de tickets",
    [
      "Bonjour,",
      "",
      "Un compte vient d'être créé pour vous. Pour l'activer et choisir votre mot de passe,",
      "envoyez une requête POST avec le jeton ci-dessous :",
      "",
      `  POST ${env.APP_URL}/auth/accept-invite`,
      `  {"token": "${token}", "password": "<votre mot de passe>"}`,
      "",
      `Lien d'invitation : ${buildInviteLink(token)}`,
      `Ce lien est valable ${env.INVITE_TTL_HOURS} heures et ne peut servir qu'une seule fois.`,
    ].join("\n"),
  );
}

export function sendPasswordResetEmail(to: string, token: string) {
  return send(
    to,
    "Réinitialisation de votre mot de passe",
    [
      "Bonjour,",
      "",
      "Une réinitialisation de votre mot de passe a été demandée. Si ce n'est pas vous, ignorez cet email.",
      "Sinon, envoyez une requête POST avec le jeton ci-dessous :",
      "",
      `  POST ${env.APP_URL}/auth/reset-password`,
      `  {"token": "${token}", "password": "<nouveau mot de passe>"}`,
      "",
      `Lien de réinitialisation : ${buildResetLink(token)}`,
      `Ce lien est valable ${env.RESET_TTL_MINUTES} minutes et ne peut servir qu'une seule fois.`,
    ].join("\n"),
  );
}
