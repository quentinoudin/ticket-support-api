import { AsyncLocalStorage } from "node:async_hooks";

import type { RequestHandler } from "express";

// Contexte propre à chaque requête, lisible partout sans le passer de fonction en fonction.
// Il sert au journal d'audit pour savoir qui agit et depuis quelle adresse.
export interface RequestContext {
  ip?: string;
  userAgent?: string;
  actor?: { id: string; email: string };
}

const storage = new AsyncLocalStorage<RequestContext>();

export const requestContextMiddleware: RequestHandler = (request, _response, next) => {
  storage.run({ ip: request.ip, userAgent: request.get("user-agent")?.slice(0, 255) }, next);
};

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function setContextActor(actor: { id: string; email: string }) {
  const store = storage.getStore();

  if (store) {
    store.actor = actor;
  }
}
