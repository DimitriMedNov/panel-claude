#!/usr/bin/env bash
# Instala Panel Claude en tu usuario (sin sudo). Uso: ./install.sh   |   ./install.sh --quitar
set -euo pipefail
cd "$(dirname "$0")"

UUID="panel-claude@dimitrimednov.github.io"
EXT="$HOME/.local/share/gnome-shell/extensions/$UUID"
APP="$HOME/.local/share/panel-claude"
AJUSTES="$HOME/.claude/settings.json"

# Agrega (o quita) los hooks del panel en ~/.claude/settings.json sin tocar lo demás.
hooks() {
  python3 - "$AJUSTES" "$APP/reportero.py" "$1" <<'EOF'
import json, os, shutil, sys
ruta, reportero, accion = sys.argv[1:]
MARCA = "panel-claude/reportero.py"
comando = f"python3 -I {reportero} evento"
EVENTOS = {"SessionStart": None, "UserPromptSubmit": None, "Stop": None, "SessionEnd": None,
           "Notification": None, "PostToolUse": "*", "PreToolUse": "AskUserQuestion"}
try:
    with open(ruta, encoding="utf-8") as f:
        datos = json.load(f)
except FileNotFoundError:
    datos = {}
hooks = datos.setdefault("hooks", {})
# Primero se quitan los del panel (así reinstalar no los duplica).
for evento in list(hooks):
    grupos = []
    for g in hooks[evento]:
        g["hooks"] = [h for h in g.get("hooks", []) if MARCA not in h.get("command", "")]
        if g["hooks"]:
            grupos.append(g)
    if grupos:
        hooks[evento] = grupos
    else:
        del hooks[evento]
if accion == "poner":
    for evento, filtro in EVENTOS.items():
        grupo = {"hooks": [{"type": "command", "command": comando, "timeout": 5}]}
        if filtro:
            grupo = {"matcher": filtro, **grupo}
        hooks.setdefault(evento, []).append(grupo)
if not hooks:
    datos.pop("hooks", None)
if os.path.exists(ruta):
    shutil.copy2(ruta, ruta + ".antes-de-panel-claude")
os.makedirs(os.path.dirname(ruta), exist_ok=True)
with open(ruta + ".tmp", "w", encoding="utf-8") as f:
    json.dump(datos, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.replace(ruta + ".tmp", ruta)
EOF
}

if [ "${1:-}" = "--quitar" ]; then
  gnome-extensions disable "$UUID" 2>/dev/null || true
  hooks quitar
  rm -rf "$EXT" "$APP"
  echo "Panel Claude quitado. Si agregaste la línea del reportero a tu barra de estado, bórrala a mano."
  exit 0
fi

mkdir -p "$EXT" "$APP"
cp extension/extension.js extension/metadata.json extension/stylesheet*.css "$EXT/"
cp reportero/reportero.py "$APP/"
hooks poner
gnome-extensions enable "$UUID" 2>/dev/null || true

cat <<EOF
Panel Claude instalado.

Falta un paso para ver tus límites (5 horas y semana):
  - Si NO tienes barra de estado propia en Claude Code, agrega esto a $AJUSTES:
      "statusLine": {"type": "command", "command": "python3 -I $APP/reportero.py uso", "refreshInterval": 5}
  - Si ya tienes un script de barra de estado, agrégale esta línea al principio
    (después de leer la entrada en \$input):
      printf '%s' "\$input" | python3 -I $APP/reportero.py uso

Después cierra sesión y vuelve a entrar para que GNOME cargue la extensión.
EOF
