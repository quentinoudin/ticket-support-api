// Outils communs aux scénarios d'audit. Cible : instance locale jetable (jamais la vraie base).
export const API = process.env.API ?? "http://localhost:3999";
export const MAIL = "http://localhost:8026/api/v1";

const short = (v, n = 230) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return mask(s.length > n ? s.slice(0, n) + "…" : s);
};
function mask(s) { return maskImpl(s); }
const maskImpl = (s) => s.replace(/(eyJ[\w-]{6})[\w.-]+/g, "$1…[jeton masqué]").replace(/([A-Za-z0-9_-]{4})[A-Za-z0-9_-]{30,}/g, "$1…[masqué]");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const title = (t) => console.log(`\n=== ${t} ===`);
export const cmd = (c) => console.log(`$ ${c}`);

// Requête HTTP affichée comme un échange lisible ; `ip` simule l'adresse du client (X-Forwarded-For).
export async function http(method, path, { token, body, ip, headers, quiet, base = API, label } = {}) {
  const h = { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }), ...(ip && { "x-forwarded-for": ip }), ...headers };
  const t0 = performance.now();
  const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const ms = Math.round(performance.now() - t0);
  let data = null;
  try { data = await res.json(); } catch {}
  if (!quiet) {
    const extra = ip ? `   [client ${ip}]` : "";
    console.log(`> ${method} ${path}${body ? " " + short(body, 120) : ""}${extra}${label ? "   (" + label + ")" : ""}`);
    console.log(`< ${res.status} ${mask(short(data ?? "", 200))}  (${ms} ms)`);
  }
  return { status: res.status, data, ms, headers: res.headers };
}

export async function mailTokenFor(email, subjectStart) {
  for (let i = 0; i < 25; i++) {
    const list = await (await fetch(`${MAIL}/search?query=${encodeURIComponent("to:" + email)}&limit=50`)).json();
    const m = list.messages?.find((x) => !subjectStart || x.Subject.startsWith(subjectStart));
    if (m) {
      const full = await (await fetch(`${MAIL}/message/${m.ID}`)).json();
      const t = /"token": "([^"]+)"/.exec(full.Text)?.[1];
      if (t) return t;
    }
    await sleep(300);
  }
  throw new Error("e-mail introuvable pour " + email);
}

const ROOT = { email: "root@audit.local", password: "Audit-Root-2026x" };
export const PWD = (role) => `Passw0rd-${role}1`;

export async function rootToken() {
  const r = await http("POST", "/auth/login", { body: ROOT, ip: "10.9.9.9", quiet: true });
  return r.data.data.accessToken;
}

// Crée (si besoin) un compte actif et renvoie son jeton d'accès. Silencieux : la mise en place n'est pas la preuve.
export async function ensureUser(email, role, ip = "10.9.9.9") {
  const R = await rootToken();
  const c = await http("POST", "/users", { token: R, body: { email, role }, quiet: true });
  if (c.status === 201) {
    const t = await mailTokenFor(email, "Invitation");
    await http("POST", "/auth/accept-invite", { body: { token: t, password: PWD(role) }, quiet: true });
  }
  let l = await http("POST", "/auth/login", { body: { email, password: PWD(role) }, ip, quiet: true });
  if (l.status !== 200) l = await http("POST", "/auth/login", { body: { email, password: PWD(role) + "x" }, ip, quiet: true });
  return { token: l.data?.data?.accessToken, refresh: l.data?.data?.refreshToken, status: l.status };
}

export const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
