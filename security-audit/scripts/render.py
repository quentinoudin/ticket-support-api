"""Transforme les sorties réelles enregistrées (evidence/*.txt) en captures PNG façon terminal.
Les textes ne sont jamais modifiés : seule la mise en forme (couleurs) est ajoutée. Rendu par Edge headless."""
import html, os, re, subprocess, sys, glob

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
EVID = os.path.join(ROOT, "security-audit", "evidence")
OUT = os.path.join(ROOT, "security-audit", "captures")
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
os.makedirs(OUT, exist_ok=True)
TMP = os.path.join(OUT, ".html")
os.makedirs(TMP, exist_ok=True)

def color(line):
    e = html.escape(line)
    if line.startswith("==="):
        return f'<span class="h">{e}</span>'
    if line.startswith("$ "):
        return f'<span class="c">{e}</span>'
    if line.startswith("> "):
        return f'<span class="q">{e}</span>'
    m = re.match(r"< (\d{3})", line)
    if m:
        k = "ok" if m.group(1)[0] == "2" else "ko"
        return f'<span class="{k}">{e}</span>'
    if re.search(r"CONNECTÉ|IDENTIQUE|add '|Priorité finale du ticket\s+: URGENT|exposés : [a-zA-Z]", line):
        return f'<span class="bad">{e}</span>'
    if re.search(r"REFUSÉ|ÉCHEC de connexion|aucun mot de passe en dur|Priorité finale du ticket\s+: HIGH|\[sécurité\]|ignoré|\.gitignore:", line):
        return f'<span class="good">{e}</span>'
    return e

def wrap_lines(text, width=150):
    out = []
    for l in text.splitlines():
        while len(l) > width:
            out.append(l[:width]); l = "    " + l[width:]
        out.append(l)
    return out

def render(txt_path, png_name, caption, badge):
    text = open(txt_path, encoding="utf-8").read().replace("\x1b", "")
    lines = [l for l in wrap_lines(text) if l.strip() != "" and not l.startswith("===")]
    body = "\n".join(color(l) for l in lines)
    height = 34 + 20 * len(lines)
    page = f"""<!doctype html><meta charset="utf-8"><style>
body{{margin:0;background:#0d1117;font:13px/20px Consolas,'Cascadia Mono',monospace;color:#c9d1d9}}
.bar{{background:#161b22;padding:10px 16px;border-bottom:1px solid #30363d;display:flex;justify-content:space-between;font:600 13px 'Segoe UI',sans-serif}}
.badge{{padding:2px 10px;border-radius:10px;color:#fff;background:{'#b62324' if badge=='AVANT' else '#1a7f37'}}}
pre{{margin:0;padding:12px 16px;white-space:pre}}
.h{{color:#ffa657;font-weight:bold}} .c{{color:#79c0ff}} .q{{color:#d2a8ff}} .ok{{color:#7ee787}} .ko{{color:#ffa198}}
.bad{{color:#ff7b72;font-weight:bold}} .good{{color:#56d364;font-weight:bold}}
</style><pre>{body}</pre>"""
    hp = os.path.join(TMP, png_name + ".html")
    open(hp, "w", encoding="utf-8").write(page)
    subprocess.run([EDGE, "--headless=new", "--disable-gpu", "--hide-scrollbars", f"--screenshot={os.path.join(OUT, png_name)}.png",
                    f"--window-size=1250,{height}", "file:///" + hp.replace("\\", "/")], capture_output=True, timeout=60)

for phase, badge in (("before", "AVANT"), ("after", "APRÈS")):
    for p in sorted(glob.glob(os.path.join(EVID, phase, "VULN-*.txt"))):
        vid = os.path.basename(p)[:-4]
        render(p, f"{vid}-{'avant' if phase=='before' else 'apres'}", f"{vid} · scénario d'exploitation rejoué {'sur le code initial' if phase=='before' else 'après correction'}", badge)

for p in sorted(glob.glob(os.path.join(EVID, "tools", "*.txt"))):
    n = os.path.basename(p)[:-4]
    render(p, f"outil-{n}", f"Sortie de l'outil : {n}", "APRÈS" if n == "tests" else "AVANT")
print(len(glob.glob(os.path.join(OUT, "*.png"))), "captures")
