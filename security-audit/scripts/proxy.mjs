// Mini reverse proxy de test (:4000 -> :3999). Il ajoute l'IP du client (en-tête x-client-ip) à X-Forwarded-For,
// comme le ferait nginx ou Cloudflare : il AJOUTE, il ne remplace pas.
import http from "node:http";

http
  .createServer((req, res) => {
    const headers = { ...req.headers };
    const client = headers["x-client-ip"] ?? req.socket.remoteAddress;
    delete headers["x-client-ip"];
    headers["x-forwarded-for"] = headers["x-forwarded-for"] ? `${headers["x-forwarded-for"]}, ${client}` : client;
    const up = http.request({ host: "127.0.0.1", port: 3999, path: req.url, method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  })
  .listen(4000, () => console.log("proxy :4000 -> :3999"));
