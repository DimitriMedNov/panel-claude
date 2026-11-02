#!/usr/bin/env python3
"""Puente entre Claude Code y el panel de GNOME.

Claude Code lo llama de dos formas y le pasa un JSON por la entrada estándar:
  reportero.py uso     desde la barra de estado (cada pocos segundos): modelo, contexto y límites.
  reportero.py evento  desde los hooks (avisos de Claude Code en cada paso): qué está haciendo.

Escribe un archivo por sesión en $XDG_RUNTIME_DIR/panel-claude/, que el panel lee.
Nunca falla hacia Claude Code: cualquier error se ignora para no estorbar la sesión.
"""
import json
import os
import sys
import time

CARPETA = os.path.join(os.environ.get("XDG_RUNTIME_DIR") or f"/tmp/panel-claude-{os.getuid()}", "panel-claude")

# Evento de Claude Code → estado que muestra el panel.
ESTADO_POR_EVENTO = {
    "SessionStart": "lista",
    "UserPromptSubmit": "trabajando",
    "PostToolUse": "trabajando",
    "Stop": "terminó",
}
# Avisos (hook Notification) que significan que Claude te está esperando.
ESTADO_POR_AVISO = {
    "permission_prompt": "permiso",
    "elicitation_dialog": "pregunta",
}


def pid_de_claude() -> int | None:
    """Sube por los procesos padre hasta encontrar el de Claude Code."""
    pid = os.getppid()
    for _ in range(8):
        try:
            with open(f"/proc/{pid}/comm", encoding="utf-8") as f:
                if f.read().strip() == "claude":
                    return pid
            with open(f"/proc/{pid}/stat", encoding="utf-8") as f:
                pid = int(f.read().rsplit(")", 1)[1].split()[1])
        except (OSError, ValueError, IndexError):
            return None
        if pid <= 1:
            return None
    return None


def escribir(nombre: str, datos: dict) -> None:
    os.makedirs(CARPETA, mode=0o700, exist_ok=True)
    ruta = os.path.join(CARPETA, nombre)
    temporal = f"{ruta}.{os.getpid()}.tmp"
    with open(temporal, "w", encoding="utf-8") as f:
        json.dump(datos, f, ensure_ascii=False)
    os.replace(temporal, ruta)  # el panel nunca ve un archivo a medias


def sesion_valida(sid: object) -> str | None:
    # El id sale en un nombre de archivo: solo letras, números y guiones.
    if isinstance(sid, str) and sid and all(c.isalnum() or c in "-_" for c in sid):
        return sid
    return None


def uso(d: dict) -> None:
    sid = sesion_valida(d.get("session_id"))
    if not sid:
        return
    modelo = d.get("model") or {}
    contexto = d.get("context_window") or {}
    costo = d.get("cost") or {}
    escribir(f"{sid}.uso.json", {
        "momento": time.time(),
        "pid": pid_de_claude(),
        "carpeta": d.get("cwd") or (d.get("workspace") or {}).get("current_dir"),
        "modelo": modelo.get("display_name"),
        "contexto": contexto.get("used_percentage"),
        "limites": d.get("rate_limits"),
        "lineas_agregadas": costo.get("total_lines_added"),
        "lineas_quitadas": costo.get("total_lines_removed"),
    })
    # Los límites son de la cuenta, no de la sesión: se guardan aparte para seguir mostrándolos
    # aunque cierres todas las sesiones.
    if d.get("rate_limits"):
        escribir("limites.json", {"momento": time.time(), "limites": d["rate_limits"]})


def evento(d: dict) -> None:
    sid = sesion_valida(d.get("session_id"))
    if not sid:
        return
    nombre = d.get("hook_event_name")
    if nombre == "SessionEnd":
        for sufijo in ("uso", "evento"):
            try:
                os.remove(os.path.join(CARPETA, f"{sid}.{sufijo}.json"))
            except OSError:
                pass
        return
    if nombre == "Notification":
        estado = ESTADO_POR_AVISO.get(d.get("notification_type"))
    elif nombre == "PreToolUse" and d.get("tool_name") == "AskUserQuestion":
        estado = "pregunta"
    else:
        estado = ESTADO_POR_EVENTO.get(nombre)
    if not estado:
        return
    escribir(f"{sid}.evento.json", {
        "momento": time.time(),
        "pid": pid_de_claude(),
        "carpeta": d.get("cwd"),
        "estado": estado,
        "mensaje": d.get("message") if nombre == "Notification" else None,
    })


def main() -> int:
    try:
        datos = json.load(sys.stdin)
        if isinstance(datos, dict):
            {"uso": uso, "evento": evento}.get(sys.argv[1] if len(sys.argv) > 1 else "", lambda _d: None)(datos)
    except Exception:  # noqa: BLE001 - nunca romper la sesión de Claude Code
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
