// Scénarios d'exploitation / de retest. Usage : node scenarios.mjs <001..012>
// Les mêmes scénarios sont rejoués AVANT et APRÈS correction ; seule la sortie change.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { createRequire } from "node:module";
import { API, MAIL, PWD, cmd, ensureUser, http, mailTokenFor, median, rootToken, sleep, title } from "./lib.mjs";

const PROJECT = process.env.PROJECT_DIR ?? "C:/Users/quent/ticket-support-api";
const sh = (c) => { try { return execSync(c, { cwd: PROJECT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd(); } catch (e) { return ((e.stdout ?? "") + (e.stderr ?? "")).trimEnd() || `(code ${e.status})`; } };
const show = (c, transform = (s) => s) => { cmd(c); console.log(transform(sh(c))); };
const ATTACKER = "203.0.113.5";
const VICTIM_IP = "198.51.100.7";

const scenarios = {
  // ---------------------------------------------------------------------------------------------
  async "001"() {
    title("VULN-001 : mot de passe Super Admin dans un script non ignoré");
    const maskPwd = (s) => s.replace(/\?\? "[^"]+"/g, '?? "********"');
    show("git status --short scripts/", (s) => s);
    show('git check-ignore -v scripts/test-deepseek.ts || echo "(fichier NON ignore par .gitignore)"');
    show('grep -n "SUPER_ADMIN_PASSWORD" scripts/test-deepseek.ts', maskPwd);
    show("git add -A --dry-run scripts/");
    const env = Object.fromEntries(readFileSync(PROJECT + "/.env", "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
    const src = readFileSync(PROJECT + "/scripts/test-deepseek.ts", "utf8");
    const fallback = /SUPER_ADMIN_PASSWORD \?\? "([^"]+)"/.exec(src)?.[1];
    cmd("comparer la valeur en dur avec SUPER_ADMIN_PASSWORD de .env (sans l'afficher)");
    console.log(fallback ? `mot de passe en dur trouvé : ${fallback === env.SUPER_ADMIN_PASSWORD ? "IDENTIQUE à celui de .env" : "différent de .env"}` : "aucun mot de passe en dur dans le script");
  },

  // ---------------------------------------------------------------------------------------------
  async "002"() {
    title("VULN-002 : PostgreSQL et Mailpit exposés sur le réseau avec les identifiants par défaut");
    const require = createRequire(PROJECT + "/package.json");
    const pg = require("pg");
    await ensureUser("victim@audit.local", "USER");
    await http("POST", "/auth/forgot-password", { body: { email: "victim@audit.local" }, ip: "10.9.9.9", quiet: true });
    await sleep(800);
    const lan = Object.values(networkInterfaces()).flat().find((i) => i.family === "IPv4" && !i.internal && /^192\.168\./.test(i.address))?.address ?? "127.0.0.1";
    show('docker ps --format "{{.Names}}  {{.Ports}}"');
    cmd(`curl http://${lan}:8026/api/v1/messages   # interface Mailpit, adresse réseau ${lan}`);
    try {
      const r = await fetch(`http://${lan}:8026/api/v1/search?query=${encodeURIComponent("to:victim@audit.local")}`, { signal: AbortSignal.timeout(4000) });
      const j = await r.json();
      console.log(`HTTP ${r.status} : ${j.messages.length} e-mail(s) lisible(s) sans authentification`);
      const full = await (await fetch(`http://${lan}:8026/api/v1/message/${j.messages[0].ID}`)).json();
      console.log(`Objet : ${full.Subject}`);
      console.log(full.Text.split("\n").filter((l) => l.includes("token")).map((l) => l.replace(/("token": "|token=)([\w-]{5})[\w-]+/g, "$1$2…[masqué]")).join("\n"));
    } catch (e) { console.log(`ÉCHEC de connexion : ${e.cause?.code ?? e.name}`); }
    for (const host of [lan, "127.0.0.1"]) {
      cmd(`psql postgresql://ticket_user:ticket_password@${host}:5433/ticket_support_audit   # mot de passe par défaut`);
      const c = new pg.Client({ host, port: 5433, user: "ticket_user", password: "ticket_password", database: "ticket_support_audit", connectionTimeoutMillis: 4000 });
      try {
        await c.connect();
        const r = await c.query('select current_user as utilisateur, (select count(*) from "User") as comptes');
        const h = await c.query('select email, role, left("passwordHash",7) as debut_hash from "User" order by "createdAt" limit 2');
        console.log(`CONNECTÉ : ${JSON.stringify(r.rows[0])}`);
        console.log(`Lecture : ${JSON.stringify(h.rows)}`);
        await c.end();
      } catch (e) { console.log(`REFUSÉ : ${e.code ?? e.message}`); }
    }
  },

  // ---------------------------------------------------------------------------------------------
  async "003"() {
    title("VULN-003 : blocage d'un compte par un tiers (déni de service ciblé)");
    await ensureUser("victim@audit.local", "USER");
    console.log(`L'attaquant (${ATTACKER}) ne connaît que l'e-mail de la victime.`);
    for (let i = 1; i <= 5; i++) await http("POST", "/auth/login", { body: { email: "victim@audit.local", password: "devine-" + i }, ip: ATTACKER, label: `attaquant, essai ${i}` });
    console.log(`\nLa victime légitime (${VICTIM_IP}) se connecte avec son BON mot de passe :`);
    await http("POST", "/auth/login", { body: { email: "victim@audit.local", password: PWD("USER") }, ip: VICTIM_IP, label: "victime, bon mot de passe" });
  },

  // ---------------------------------------------------------------------------------------------
  async "004"() {
    title("VULN-004 : énumération de comptes via la réponse de verrouillage");
    await ensureUser("victim@audit.local", "USER");
    for (const [label, email, ip] of [["compte EXISTANT", "victim@audit.local", "203.0.113.5"], ["compte INEXISTANT", "fantome@audit.local", "203.0.113.6"]]) {
      console.log(`
--- ${label} (${email}), 6 tentatives depuis ${ip} ---`);
      for (let i = 1; i <= 6; i++) await http("POST", "/auth/login", { body: { email, password: "devine-" + i }, ip, label: `essai ${i}` });
    }
  },

  // ---------------------------------------------------------------------------------------------
  async "005"() {
    title("VULN-005 : énumération par temps de réponse de /auth/forgot-password");
    await ensureUser("mallory@audit.local", "USER");
    const run = async (label, mk) => {
      console.log(`\n--- ${label} ---`);
      const t = [];
      for (let i = 0; i < 5; i++) { const r = await http("POST", "/auth/forgot-password", { body: { email: mk(i) }, ip: `198.51.100.${20 + i + (label.startsWith("compte EX") ? 0 : 50)}` }); t.push(r.ms); }
      console.log(`médiane : ${median(t)} ms`);
      return median(t);
    };
    const a = await run("compte EXISTANT", () => "mallory@audit.local");
    const b = await run("compte INEXISTANT", (i) => `fantome${i}@audit.local`);
    console.log(`\nÉcart : ${a} ms contre ${b} ms  (rapport ×${(a / Math.max(b, 1)).toFixed(1)})`);
  },

  // ---------------------------------------------------------------------------------------------
  async "006"() {
    title("VULN-006 : jetons d'accès encore valides après déconnexion / réinitialisation");
    const u = await ensureUser("victim@audit.local", "USER", "198.51.100.30");
    console.log("Cas 1 : déconnexion");
    await http("GET", "/auth/me", { token: u.token, ip: "198.51.100.30", label: "avant logout" });
    await http("POST", "/auth/logout", { body: { refreshToken: u.refresh }, ip: "198.51.100.30" });
    await http("GET", "/auth/me", { token: u.token, ip: "198.51.100.30", label: "ancien jeton, après logout" });
    console.log("\nCas 2 : réinitialisation du mot de passe (le voleur garde son jeton)");
    const v = await ensureUser("reset@audit.local", "USER", "198.51.100.31");
    await http("POST", "/auth/forgot-password", { body: { email: "reset@audit.local" }, ip: "198.51.100.31" });
    const t = await mailTokenFor("reset@audit.local", "Réinit");
    await http("POST", "/auth/reset-password", { body: { token: t, password: PWD("USER") + "x" }, ip: "198.51.100.31", label: "le propriétaire change son mot de passe" });
    await http("GET", "/auth/me", { token: v.token, ip: "198.51.100.31", label: "jeton volé, après reset" });
    await http("POST", "/auth/login", { body: { email: "reset@audit.local", password: PWD("USER") + "x" }, ip: "198.51.100.31", quiet: true });
  },

  // ---------------------------------------------------------------------------------------------
  async "007"() {
    title("VULN-007 : données personnelles envoyées au LLM et priorité forcée par l'utilisateur");
    cmd("npx tsx security-audit/scripts/s007.ts");
    console.log(sh("npx tsx security-audit/scripts/s007.ts"));
  },

  // ---------------------------------------------------------------------------------------------
  async "008"() {
    title("VULN-008 : champs internes de l'IA visibles par l'utilisateur final");
    const u = await ensureUser("mallory@audit.local", "USER", "198.51.100.40");
    const c = await http("POST", "/tickets", { token: u.token, ip: "198.51.100.40", body: { title: "Écran noir", description: "Le PC ne démarre plus" }, quiet: true });
    const id = c.data.data.id;
    const r = await http("GET", `/tickets/${id}`, { token: u.token, ip: "198.51.100.40", quiet: true });
    console.log(`> GET /tickets/${id}   (rôle USER)`);
    console.log(`< ${r.status}`);
    console.log("Champs reçus : " + Object.keys(r.data.data).join(", "));
    const internes = ["createdById", "requestedPriority", "priorityLockedByHuman", "aiPriorityReason", "aiCategory", "aiHandling", "aiEscalationReason"].filter((k) => k in r.data.data);
    console.log("Champs internes exposés : " + (internes.length ? internes.join(", ") : "aucun"));
  },

  // ---------------------------------------------------------------------------------------------
  async "009"() {
    title("VULN-009 : limite de connexion partagée derrière un reverse proxy");
    const PROXY = process.env.PROXY ?? "http://localhost:4000";
    console.log("Chemin : client -> reverse proxy (:4000) -> API (:3999). Le proxy ajoute l'IP réelle du client dans X-Forwarded-For.");
    const call = (client, label, extra = {}) => http("POST", "/auth/login", { base: PROXY, body: { email: "nobody@audit.local", password: "x" }, headers: { "x-client-ip": client, ...extra }, label, quiet: true });
    let last;
    for (let i = 1; i <= 10; i++) last = await call("198.51.100.1");
    console.log(`Client A (198.51.100.1) : 10 tentatives envoyées, dernière réponse ${last.status}`);
    const a11 = await call("198.51.100.1");
    console.log(`Client A, 11e tentative : ${a11.status} ${a11.data?.error ?? ""}`);
    const b = await call("198.51.100.2");
    console.log(`Client B (198.51.100.2), 1re tentative, jamais vu : ${b.status} ${b.data?.error ?? ""}`);
    const spoof = await call("198.51.100.1", "", { "x-forwarded-for": "9.9.9.9" });
    console.log(`Client A avec un X-Forwarded-For forgé (9.9.9.9) : ${spoof.status} ${spoof.data?.error ?? ""}`);
    cmd("grep -i avertissement logs/serveur (démarrage en production, TRUST_PROXY=0)");
    console.log(sh(`grep -i "TRUST_PROXY" "${process.env.PROD_LOG ?? ""}" || echo "(aucun avertissement au démarrage)"`));
  },

  // ---------------------------------------------------------------------------------------------
  async "010"() {
    title("VULN-010 : description géante et création de tickets sans limite dédiée");
    const u = await ensureUser("mallory@audit.local", "USER", "198.51.100.50");
    const big = await http("POST", "/tickets", { token: u.token, ip: "198.51.100.50", body: { title: "gros ticket", description: "A".repeat(95_000) }, label: "description de 95 000 caractères" });
    console.log("\nCréation de 35 petits tickets à la suite :");
    const codes = {};
    for (let i = 1; i <= 35; i++) { const r = await http("POST", "/tickets", { token: u.token, ip: "198.51.100.50", body: { title: "t" + i, description: "d" }, quiet: true }); codes[r.status] = (codes[r.status] ?? 0) + 1; }
    console.log("Codes obtenus : " + Object.entries(codes).map(([k, v]) => `${v} × HTTP ${k}`).join(", "));
  },

  // ---------------------------------------------------------------------------------------------
  async "011"() {
    title("VULN-011 : documentation de l'API publique (instance lancée en NODE_ENV=production)");
    for (const p of ["/docs/", "/openapi.json", "/health"]) {
      const r = await fetch(API + p);
      console.log(`> GET ${p}  (sans authentification)\n< ${r.status}`);
    }
  },

  // ---------------------------------------------------------------------------------------------
  async "012"() {
    title("VULN-012 : mots de passe faibles acceptés et hygiène de la CI");
    const R = await rootToken();
    for (const [i, pw] of ["Abcdefgh12", "Password1234", "Azerty123456"].entries()) {
      const email = `faible${i}${Date.now() % 100000}@audit.local`;
      await http("POST", "/users", { token: R, body: { email, role: "USER" }, quiet: true });
      const t = await mailTokenFor(email, "Invitation");
      console.log(`mot de passe testé : ${pw} (${pw.length} caractères)`);
      await http("POST", "/auth/accept-invite", { body: { token: t, password: pw }, ip: "10.9.9.9" });
    }
    show('grep -nE "uses:|npm audit|gitleaks" .github/workflows/ci.yml');
  },
};

const id = process.argv[2];
if (!scenarios[id]) { console.error("scénario inconnu : " + id); process.exit(2); }
await scenarios[id]();
