// Panel Claude: muestra en la barra de GNOME tus límites de Claude Code y qué hace cada sesión.
// Los datos los escribe reportero.py (llamado por Claude Code) en $XDG_RUNTIME_DIR/panel-claude/.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const CARPETA = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'panel-claude']);
const REVISAR_CADA = 30; // segundos: refresca los "hace X min" y quita sesiones cerradas
const ESPERA_ANTES_DE_LEER = 250; // ms: junta varios cambios seguidos en una sola lectura
const SIN_PROCESO_CADUCA = 6 * 3600; // s: sesión sin proceso conocido y sin noticias, se borra
const AVISAR_TERMINO_SI_TRABAJO = 20; // s: no avisa "terminó" en respuestas rápidas
const UMBRALES = [80, 95]; // % de uso de un límite que dispara un aviso
// Sonido de cada aviso, por nombre del tema de sonidos (/usr/share/sounds/freedesktop/stereo).
const SONIDOS = {
    espera: 'message-new-instant', // te pide permiso o te hizo una pregunta
    termino: 'complete',
    limite: 'dialog-warning',
};
const NIVELES = [70, 90]; // % desde el que la barra y el texto pasan a amarillo y a rojo
const ANCHO_BARRA = 260; // px

const ESTADOS = {
    permiso: {texto: 'Te pide permiso', clase: 'pc-espera', orden: 0},
    pregunta: {texto: 'Te hizo una pregunta', clase: 'pc-espera', orden: 0},
    trabajando: {texto: 'Trabajando', clase: 'pc-trabaja', orden: 1},
    'terminó': {texto: 'Terminó, te toca', clase: 'pc-listo', orden: 2},
    lista: {texto: 'Esperando tu mensaje', clase: 'pc-quieto', orden: 3},
};

const LIMITES = [
    // conFecha: el reinicio se muestra como día y hora ("mañana 08:30") en vez de "en 15h 06m".
    {clave: 'five_hour', titulo: 'Sesión de 5 horas', corto: '5h', conFecha: false},
    {clave: 'seven_day', titulo: 'Semana', corto: 'Sem', conFecha: true},
];

const decodificador = new TextDecoder();

function leerJson(ruta) {
    try {
        const [, bytes] = GLib.file_get_contents(ruta);
        const datos = JSON.parse(decodificador.decode(bytes));
        return datos && typeof datos === 'object' ? datos : null;
    } catch {
        return null; // no existe, se está escribiendo o está dañado: se ignora
    }
}

function leerTexto(ruta) {
    try {
        return decodificador.decode(GLib.file_get_contents(ruta)[1]);
    } catch {
        return null;
    }
}

function ahora() {
    return Date.now() / 1000;
}

function faltan(epoch) {
    const d = Math.floor(epoch - ahora());
    if (d <= 0)
        return 'ya';
    if (d >= 86400)
        return `${Math.floor(d / 86400)}d ${Math.floor(d % 86400 / 3600)}h`;
    if (d >= 3600)
        return `${Math.floor(d / 3600)}h ${String(Math.floor(d % 3600 / 60)).padStart(2, '0')}m`;
    return `${Math.max(1, Math.floor(d / 60))}m`;
}

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** Día y hora local de un momento futuro: "hoy 18:40", "mañana 08:30", "jueves 08:30". */
function cuando(epoch) {
    const fecha = GLib.DateTime.new_from_unix_local(Math.floor(epoch));
    const hoy = GLib.DateTime.new_now_local();
    const inicioHoy = GLib.DateTime.new_local(hoy.get_year(), hoy.get_month(), hoy.get_day_of_month(), 0, 0, 0);
    const dias = Math.floor(fecha.difference(inicioHoy) / GLib.TIME_SPAN_DAY);
    const hora = fecha.format('%H:%M');
    if (dias <= 0)
        return `hoy ${hora}`;
    if (dias === 1)
        return `mañana ${hora}`;
    return `${DIAS[fecha.get_day_of_week() % 7]} ${hora}`;
}

function hace(epoch) {
    const d = ahora() - epoch;
    if (d < 60)
        return 'hace un momento';
    if (d < 3600)
        return `hace ${Math.floor(d / 60)} min`;
    if (d < 86400)
        return `hace ${Math.floor(d / 3600)} h`;
    return `hace ${Math.floor(d / 86400)} d`;
}

function nivel(pct) {
    if (pct >= NIVELES[1])
        return 'pc-critico';
    if (pct >= NIVELES[0])
        return 'pc-alto';
    return null;
}

/** ¿Sigue vivo el proceso de Claude Code con ese número? */
function claudeVivo(pid) {
    return Number.isInteger(pid) && leerTexto(`/proc/${pid}/comm`)?.trim() === 'claude';
}

function padreDe(pid) {
    const stat = leerTexto(`/proc/${pid}/stat`);
    if (!stat)
        return null;
    const ppid = parseInt(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    return Number.isInteger(ppid) && ppid > 1 ? ppid : null;
}

/** Busca la ventana de la terminal donde corre esa sesión. */
function ventanaDeLaSesion(pid, proyecto) {
    const ventanas = global.display.list_all_windows();
    for (let p = pid, i = 0; p && i < 8; p = padreDe(p), i++) {
        const suyas = ventanas.filter(w => w.get_pid() === p);
        if (suyas.length === 0)
            continue;
        // Una terminal de una sola instancia tiene varias ventanas con el mismo proceso:
        // se prefiere la que menciona el proyecto en el título, y si no, la más reciente.
        return suyas.find(w => (w.get_title() ?? '').includes(proyecto)) ??
            suyas.sort((a, b) => b.get_user_time() - a.get_user_time())[0];
    }
    return null;
}

function etiqueta(texto, clase = null, params = {}) {
    const l = new St.Label({text: texto, y_align: Clutter.ActorAlign.CENTER, ...params});
    if (clase)
        l.style_class = clase; // puede llevar varias clases separadas por espacio
    return l;
}

function filaFija() {
    return new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
}

/** Separador con título cuya línea llega hasta el mismo borde que las barras. */
function filaSeparador(texto) {
    const fila = filaFija();
    const caja = new St.BoxLayout({x_expand: true});
    caja.add_child(etiqueta(texto, 'pc-seccion'));
    caja.add_child(new St.Widget({style_class: 'pc-linea', x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
    fila.add_child(caja);
    return fila;
}

const Indicador = GObject.registerClass(
class Indicador extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Panel Claude');
        this._extension = extension;
        this._sesiones = [];
        this._limites = null;
        this._previos = new Map(); // id de sesión → {estado, inicioTrabajo}
        this._avisados = new Set(); // umbrales de límite ya avisados
        this._primeraLectura = true;
        this._firma = '';
        this._fuenteAvisos = null;

        const caja = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._punto = etiqueta('●', 'pc-punto');
        this._texto = etiqueta('Claude');
        caja.add_child(this._punto);
        caja.add_child(this._texto);
        this.add_child(caja);

        this._seccionLimites = new PopupMenu.PopupMenuSection();
        this._seccionSesiones = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._seccionLimites);
        this.menu.addMenuItem(filaSeparador('Sesiones'));
        this.menu.addMenuItem(this._seccionSesiones);
        // Al abrir el menú se recalculan los tiempos ("hace 3 min", "reinicia en 20m").
        this.menu.connect('open-state-changed', (_m, abierto) => {
            if (abierto)
                this._leer(true);
        });

        GLib.mkdir_with_parents(CARPETA, 0o700);
        this._monitor = Gio.File.new_for_path(CARPETA).monitor_directory(Gio.FileMonitorFlags.NONE, null);
        this._monitor.connect('changed', () => this._programarLectura());
        this._temporizador = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REVISAR_CADA, () => {
            this._leer(false);
            return GLib.SOURCE_CONTINUE;
        });
        this._pendiente = 0;
        this._leer(false);
    }

    _programarLectura() {
        if (this._pendiente)
            return;
        this._pendiente = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ESPERA_ANTES_DE_LEER, () => {
            this._pendiente = 0;
            this._leer(false);
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---------- Lectura ----------

    _leer(forzar) {
        const porId = new Map();
        let enumerador;
        try {
            enumerador = Gio.File.new_for_path(CARPETA).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        } catch {
            return;
        }
        let info;
        while ((info = enumerador.next_file(null))) {
            const nombre = info.get_name();
            const m = nombre.match(/^(.+)\.(uso|evento)\.json$/);
            if (!m)
                continue;
            const datos = leerJson(GLib.build_filenamev([CARPETA, nombre]));
            if (!datos)
                continue;
            if (!porId.has(m[1]))
                porId.set(m[1], {id: m[1]});
            porId.get(m[1])[m[2]] = datos;
        }
        enumerador.close(null);

        const sesiones = [];
        for (const s of porId.values()) {
            const pid = s.evento?.pid ?? s.uso?.pid ?? null;
            const ultimo = Math.max(s.evento?.momento ?? 0, s.uso?.momento ?? 0);
            const cerrada = pid ? !claudeVivo(pid) : ahora() - ultimo > SIN_PROCESO_CADUCA;
            if (cerrada) {
                this._borrar(s.id);
                continue;
            }
            const carpeta = s.evento?.carpeta ?? s.uso?.carpeta ?? '';
            sesiones.push({
                id: s.id,
                pid,
                proyecto: GLib.path_get_basename(carpeta || '?'),
                estado: ESTADOS[s.evento?.estado] ? s.evento.estado : 'lista',
                desde: s.evento?.momento ?? ultimo,
                mensaje: s.evento?.mensaje ?? null,
                modelo: s.uso?.modelo ?? null,
                contexto: s.uso?.contexto ?? null,
                agregadas: s.uso?.lineas_agregadas ?? null,
                quitadas: s.uso?.lineas_quitadas ?? null,
            });
        }
        sesiones.sort((a, b) => ESTADOS[a.estado].orden - ESTADOS[b.estado].orden || b.desde - a.desde);
        this._sesiones = sesiones;
        this._limites = leerJson(GLib.build_filenamev([CARPETA, 'limites.json']));

        this._revisarAvisos();
        this._primeraLectura = false;
        this._pintarBarra();
        this._pintarMenu(forzar);
    }

    _borrar(id) {
        for (const sufijo of ['uso', 'evento']) {
            try {
                Gio.File.new_for_path(GLib.build_filenamev([CARPETA, `${id}.${sufijo}.json`])).delete(null);
            } catch {
                // ya no estaba
            }
        }
        this._previos.delete(id);
    }

    // ---------- Avisos ----------

    _revisarAvisos() {
        for (const s of this._sesiones) {
            const previo = this._previos.get(s.id);
            const inicioTrabajo = s.estado === 'trabajando'
                ? (previo?.estado === 'trabajando' ? previo.inicioTrabajo : s.desde)
                : null;
            if (previo && !this._primeraLectura && previo.estado !== s.estado) {
                if (s.estado === 'permiso')
                    this._avisar(`${s.proyecto}: te pide permiso`, s.mensaje ?? 'Claude Code espera tu aprobación.', SONIDOS.espera);
                else if (s.estado === 'pregunta')
                    this._avisar(`${s.proyecto}: te hizo una pregunta`, 'Claude Code espera tu respuesta.', SONIDOS.espera);
                else if (s.estado === 'terminó' && previo.estado === 'trabajando' &&
                         s.desde - previo.inicioTrabajo >= AVISAR_TERMINO_SI_TRABAJO)
                    this._avisar(`${s.proyecto}: terminó`, 'Claude Code acabó y espera tu siguiente mensaje.', SONIDOS.termino);
            }
            this._previos.set(s.id, {estado: s.estado, inicioTrabajo});
        }

        for (const {clave, titulo} of LIMITES) {
            const lim = this._limites?.limites?.[clave];
            if (!lim || typeof lim.used_percentage !== 'number')
                continue;
            for (const umbral of UMBRALES) {
                const llave = `${clave}:${lim.resets_at}:${umbral}`;
                if (lim.used_percentage < umbral || this._avisados.has(llave))
                    continue;
                this._avisados.add(llave);
                if (!this._primeraLectura) {
                    this._avisar(`${titulo}: llevas ${Math.round(lim.used_percentage)}%`,
                        lim.resets_at ? `Se reinicia en ${faltan(lim.resets_at)}.` : null, SONIDOS.limite);
                }
            }
        }
    }

    _avisar(titulo, cuerpo, sonido) {
        if (!this._fuenteAvisos) {
            this._fuenteAvisos = new MessageTray.Source({title: 'Panel Claude', iconName: 'utilities-terminal-symbolic'});
            this._fuenteAvisos.connect('destroy', () => {
                this._fuenteAvisos = null;
            });
            Main.messageTray.add(this._fuenteAvisos);
        }
        const aviso = new MessageTray.Notification({
            source: this._fuenteAvisos,
            title: titulo,
            body: cuerpo,
            sound: sonido ? new MessageTray.Sound(null, sonido) : null,
        });
        this._fuenteAvisos.addNotification(aviso);
    }

    // ---------- Barra de arriba ----------

    _pintarBarra() {
        const masUrgente = this._sesiones[0];
        for (const e of Object.values(ESTADOS))
            this._punto.remove_style_class_name(e.clase);
        this._punto.add_style_class_name(masUrgente ? ESTADOS[masUrgente.estado].clase : 'pc-quieto');

        const partes = [];
        let peor = 0;
        for (const {clave, corto} of LIMITES) {
            const pct = this._limites?.limites?.[clave]?.used_percentage;
            if (typeof pct === 'number') {
                partes.push(`${corto} ${Math.round(pct)}%`);
                peor = Math.max(peor, pct);
            }
        }
        this._texto.text = partes.length ? partes.join(' · ') : 'Claude';
        this._texto.remove_style_class_name('pc-alto');
        this._texto.remove_style_class_name('pc-critico');
        if (nivel(peor))
            this._texto.add_style_class_name(nivel(peor));
    }

    // ---------- Menú ----------

    _pintarMenu(forzar) {
        // Solo se reconstruye si cambió algo visible: así el menú abierto no parpadea.
        const firma = JSON.stringify([this._limites, this._sesiones.map(s => [s.id, s.estado, s.modelo,
            Math.round(s.contexto ?? -1), s.agregadas, s.quitadas, hace(s.desde)])]);
        if (!forzar && firma === this._firma)
            return;
        this._firma = firma;

        this._seccionLimites.removeAll();
        const limites = this._limites?.limites;
        if (!limites) {
            const fila = filaFija();
            fila.add_child(etiqueta('Aún no hay datos. Abre Claude Code y aparecerán aquí.'));
            this._seccionLimites.addMenuItem(fila);
        } else {
            for (const def of LIMITES) {
                if (limites[def.clave])
                    this._seccionLimites.addMenuItem(this._filaLimite(def, limites[def.clave]));
            }
            if (ahora() - this._limites.momento > 120) {
                const fila = filaFija();
                fila.add_child(etiqueta(`Último dato ${hace(this._limites.momento)}`, 'pc-detalle'));
                this._seccionLimites.addMenuItem(fila);
            }
        }

        this._seccionSesiones.removeAll();
        if (this._sesiones.length === 0) {
            const fila = filaFija();
            fila.add_child(etiqueta('No hay sesiones de Claude Code abiertas.', 'pc-detalle'));
            this._seccionSesiones.addMenuItem(fila);
        }
        for (const s of this._sesiones)
            this._seccionSesiones.addMenuItem(this._filaSesion(s));
    }

    _filaLimite({titulo, conFecha}, lim) {
        const pct = Math.max(0, Math.min(100, lim.used_percentage ?? 0));
        const fila = filaFija();
        const columna = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});

        const arriba = new St.BoxLayout({x_expand: true});
        arriba.add_child(etiqueta(titulo, 'pc-titulo', {x_expand: true}));
        arriba.add_child(etiqueta(`${Math.round(pct)}%`, nivel(pct) ?? 'pc-titulo'));
        columna.add_child(arriba);

        const barra = new St.Widget({style_class: 'pc-barra', width: ANCHO_BARRA});
        const relleno = new St.Widget({style_class: 'pc-relleno', width: Math.round(ANCHO_BARRA * pct / 100)});
        if (nivel(pct))
            relleno.add_style_class_name(`${nivel(pct)}-fondo`);
        barra.add_child(relleno);
        columna.add_child(barra);

        if (lim.resets_at)
            columna.add_child(etiqueta(conFecha ? `Se reinicia ${cuando(lim.resets_at)}` : `Se reinicia en ${faltan(lim.resets_at)}`, 'pc-detalle'));
        fila.add_child(columna);
        return fila;
    }

    _filaSesion(s) {
        const fila = new PopupMenu.PopupBaseMenuItem();
        const estado = ESTADOS[s.estado];
        fila.add_child(etiqueta('●', `pc-punto ${estado.clase}`, {y_align: Clutter.ActorAlign.START}));

        const columna = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        const arriba = new St.BoxLayout({x_expand: true});
        arriba.add_child(etiqueta(s.proyecto, 'pc-proyecto', {x_expand: true}));
        arriba.add_child(etiqueta(estado.texto, estado.clase));
        columna.add_child(arriba);

        const detalles = [hace(s.desde)];
        if (s.modelo)
            detalles.push(s.modelo);
        if (typeof s.contexto === 'number')
            detalles.push(`contexto ${Math.round(s.contexto)}%`);
        if (s.agregadas || s.quitadas)
            detalles.push(`+${s.agregadas ?? 0} −${s.quitadas ?? 0} líneas`);
        columna.add_child(etiqueta(detalles.join(' · '), 'pc-detalle'));
        fila.add_child(columna);

        // Clic: lleva a la ventana de la terminal donde está esa sesión.
        fila.connect('activate', () => {
            const ventana = s.pid ? ventanaDeLaSesion(s.pid, s.proyecto) : null;
            if (ventana)
                Main.activateWindow(ventana);
        });
        return fila;
    }

    destroy() {
        if (this._temporizador)
            GLib.source_remove(this._temporizador);
        if (this._pendiente)
            GLib.source_remove(this._pendiente);
        this._temporizador = this._pendiente = 0;
        this._monitor?.cancel();
        this._monitor = null;
        this._fuenteAvisos?.destroy();
        this._fuenteAvisos = null;
        super.destroy();
    }
});

export default class PanelClaude extends Extension {
    enable() {
        this._indicador = new Indicador(this);
        Main.panel.addToStatusArea(this.uuid, this._indicador);
    }

    disable() {
        this._indicador?.destroy();
        this._indicador = null;
    }
}
