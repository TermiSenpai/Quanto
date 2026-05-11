// ============================================================
// PackPrice - Proceso principal Electron
// ============================================================
// Responsabilidades:
//   - Crear y gestionar la ventana
//   - Acceso al filesystem (lectura/escritura del config)
//   - Persistencia de settings locales (%APPDATA%)
//   - IPC para que el renderer pida operaciones de filesystem
//
// Buenas prácticas de seguridad activadas:
//   - contextIsolation: true
//   - nodeIntegration: false
//   - sandbox: true (no se puede por preload con require, pero limitamos exposición)
//   - El renderer NO tiene acceso a fs/path/etc. directamente.
// ============================================================

'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { buildDefaultConfig } = require('./config.default');
const {
  extraerJsonDeConfig,
  validarFormaConfig,
  stripAdminClave,
  reinyectarAdminClave,
  serializarConfig
} = require('./lib/config-parser');
const { validateConfigSchema } = require('./lib/config-schema');
const { configureLogger, readLastLines, getLogPath, logger } = require('./lib/logger');
const { diffObjects } = require('./lib/diff');
const { appendAuditEntry, readRecentEntries } = require('./lib/audit');
const {
  saveQuote: saveQuoteToHistory,
  listQuotes,
  searchQuotes,
  deleteQuote,
  getQuote
} = require('./lib/history');
const { renderQuoteHtml } = require('./lib/pdf-template');

// --- Configuración de paths ---
const SETTINGS_DIR = path.join(app.getPath('userData'));
const SETTINGS_PATH = path.join(SETTINGS_DIR, 'settings.json');
const LOG_DIR = path.join(SETTINGS_DIR, 'logs');

// Ruta por defecto donde la app espera (y si hace falta crea) el config.js
// compartido en el NAS. Se puede cambiar en "Ajustes" en cada PC y queda
// persistido en el settings.json local.
//
// Se prueban en orden hasta encontrar una que sea escribible. La primera
// existente o accesible se usa como ruta inicial; si ninguna existe se
// crea en la primera viable.
const RUTAS_CONFIG_CANDIDATAS = [
  '\\\\172.26.0.154\\Paep\\Packs\\config.js',
  'Z:\\Packs\\config.js'
];

let mainWindow = null;

// ============================================================
// Funciones auxiliares de filesystem
// ============================================================

/**
 * Lee y parsea config.js sin ejecutarlo como JavaScript.
 *
 * Históricamente esto usaba `vm.runInNewContext`, pero la doc de
 * Node deja claro que `vm` no es una frontera de seguridad: un
 * config malicioso puede escapar con `this.constructor.constructor(...)`
 * y obtener RCE. Como el archivo vive en el NAS y el usuario puede
 * seleccionar cualquier .js desde el diálogo, era una superficie real.
 *
 * Ahora extraemos el JSON con un escáner de llaves y `JSON.parse`,
 * que es estrictamente declarativo.
 */
function leerConfigDesdeArchivo(rutaArchivo) {
  if (!fs.existsSync(rutaArchivo)) {
    throw new Error(`No existe el archivo: ${rutaArchivo}`);
  }
  const contenido = fs.readFileSync(rutaArchivo, 'utf-8');
  return extraerJsonDeConfig(contenido);
}

/**
 * Devuelve mtime + hash sha256 del archivo, para detectar conflictos.
 */
function obtenerInfoArchivo(rutaArchivo) {
  if (!fs.existsSync(rutaArchivo)) return null;
  const stat = fs.statSync(rutaArchivo);
  const contenido = fs.readFileSync(rutaArchivo);
  const hash = crypto.createHash('sha256').update(contenido).digest('hex');
  return {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    hash
  };
}

/**
 * Crea backup automático antes de sobrescribir el config.
 * Lo guarda en una carpeta hermana 'backups/' con timestamp.
 */
function crearBackup(rutaConfig) {
  if (!fs.existsSync(rutaConfig)) return null;

  const dir = path.dirname(rutaConfig);
  const backupsDir = path.join(dir, 'backups');

  try {
    if (!fs.existsSync(backupsDir)) {
      fs.mkdirSync(backupsDir, { recursive: true });
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupPath = path.join(backupsDir, `config-${ts}.js`);
    fs.copyFileSync(rutaConfig, backupPath);
    return backupPath;
  } catch (err) {
    // No bloqueante: si falla el backup, avisamos pero seguimos.
    logger.warn('backup failed (non-blocking)', { ruta: rutaConfig, error: err.message });
    return null;
  }
}

/**
 * Comprueba si una ruta es escribible. Sin efectos secundarios:
 * NO crea directorios, solo lee permisos del archivo o del padre.
 *
 * IMPORTANTE: esta función puede bloquear si la ruta apunta a un NAS
 * inaccesible (Windows tarda en agotar el timeout SMB). Llamarla solo
 * en respuesta a una acción explícita del usuario.
 */
function rutaEscribible(rutaArchivo) {
  try {
    if (fs.existsSync(rutaArchivo)) {
      fs.accessSync(rutaArchivo, fs.constants.W_OK);
      return true;
    }
    const dir = path.dirname(rutaArchivo);
    if (fs.existsSync(dir)) {
      fs.accessSync(dir, fs.constants.W_OK);
      return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

/**
 * Devuelve una ruta candidata SIN probar el filesystem. Es solo una
 * sugerencia para mostrar al usuario en la pantalla de bienvenida.
 * La existencia y escribibilidad reales se verifican cuando el usuario
 * pulsa "Empezar" (en `config:exists` y `config:create-default`).
 *
 * No hacemos `fs.existsSync` aquí porque sobre rutas UNC inaccesibles
 * Windows puede tardar decenas de segundos, y eso bloquearía el
 * arranque de la app.
 */
function sugerirRutaCandidata() {
  return RUTAS_CONFIG_CANDIDATAS[0];
}

/**
 * Crea el archivo config.js con valores por defecto en la ruta indicada.
 * No sobrescribe si ya existe.
 *
 * @param {string} rutaArchivo
 * @param {object} [meta] - { modificado_por }
 * @returns {object} { creado: boolean, config, ruta, motivo? }
 */
function crearConfigPorDefecto(rutaArchivo, meta = {}) {
  if (fs.existsSync(rutaArchivo)) {
    return { creado: false, motivo: 'ya_existe', ruta: rutaArchivo };
  }

  const dir = path.dirname(rutaArchivo);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const config = buildDefaultConfig(meta);
  const contenido = serializarConfig(config);
  fs.writeFileSync(rutaArchivo, contenido, 'utf-8');
  return { creado: true, config, ruta: rutaArchivo };
}

/**
 * Carga settings locales de %APPDATA%.
 * Devuelve null si no existen (primer arranque).
 */
function leerSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) return null;
  try {
    const contenido = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    return JSON.parse(contenido);
  } catch (err) {
    logger.warn('corrupt settings.json, ignored', { error: err.message });
    return null;
  }
}

function guardarSettings(settings) {
  if (!fs.existsSync(SETTINGS_DIR)) {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  }
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
}

// ============================================================
// Ventana principal
// ============================================================

function crearVentana() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 820,
    minHeight: 600,
    title: 'PackPrice · Calculadora de packs',
    backgroundColor: '#E8ECF1',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false  // necesario porque preload.js usa require
    }
  });

  // Menú simplificado (oculto por defecto, accesible con Alt)
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Archivo',
      submenu: [
        { role: 'reload', label: 'Recargar' },
        { type: 'separator' },
        { role: 'quit', label: 'Salir' }
      ]
    },
    {
      label: 'Ver',
      submenu: [
        { role: 'zoomIn',   label: 'Aumentar zoom' },
        { role: 'zoomOut',  label: 'Reducir zoom' },
        { role: 'resetZoom', label: 'Zoom 100%' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: 'Herramientas de desarrollo' }
      ]
    }
  ]));

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ============================================================
// IPC handlers
// ============================================================

// --- Settings ---

ipcMain.handle('settings:read', () => {
  return leerSettings();
});

ipcMain.handle('settings:write', (event, settings) => {
  try {
    guardarSettings(settings);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- Ruta candidata por defecto (NAS) ---

ipcMain.handle('config:default-path', () => {
  // Devolución instantánea: sugerencia sin probar filesystem para no
  // bloquear el arranque cuando el NAS está inaccesible.
  return {
    candidatas: RUTAS_CONFIG_CANDIDATAS.slice(),
    sugerida:   sugerirRutaCandidata()
  };
});

// --- Comprobación de existencia ---

ipcMain.handle('config:exists', (event, ruta) => {
  try {
    return { existe: fs.existsSync(ruta), escribible: rutaEscribible(ruta) };
  } catch (err) {
    return { existe: false, escribible: false, error: err.message };
  }
});

// --- Creación del config con defaults ---

ipcMain.handle('config:create-default', (event, { ruta, modificadoPor }) => {
  try {
    const r = crearConfigPorDefecto(ruta, { modificado_por: modificadoPor });
    if (!r.creado) {
      return { ok: false, motivo: r.motivo, error: 'El archivo ya existe en esa ruta' };
    }
    const info = obtenerInfoArchivo(r.ruta);
    return { ok: true, config: stripAdminClave(r.config), info, ruta: r.ruta };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- Diálogo de selección de archivo config ---

ipcMain.handle('dialog:select-config', async () => {
  // No pasamos `defaultPath` apuntando al NAS: si la ruta UNC está
  // inaccesible, Windows se cuelga intentando resolverla antes de
  // mostrar el diálogo. Usamos la carpeta del usuario como punto de
  // partida (siempre instantánea); el explorador recuerda la última
  // ubicación visitada en posteriores aperturas.
  const resultado = await dialog.showOpenDialog(mainWindow, {
    title: 'Selecciona el archivo de configuración',
    filters: [
      { name: 'Configuración JS', extensions: ['js'] },
      { name: 'Todos los archivos', extensions: ['*'] }
    ],
    properties: ['openFile'],
    defaultPath: app.getPath('home')
  });

  if (resultado.canceled || resultado.filePaths.length === 0) {
    return { cancelado: true };
  }
  return { cancelado: false, ruta: resultado.filePaths[0] };
});

// --- Lectura de config ---

ipcMain.handle('config:read', (event, ruta) => {
  try {
    const config = leerConfigDesdeArchivo(ruta);
    // Strict schema validation: fail-fast with a precise message so
    // the admin sees exactly which field is broken instead of getting
    // NaNs deep in the calculator.
    validateConfigSchema(config);
    const info = obtenerInfoArchivo(ruta);
    return { ok: true, config: stripAdminClave(config), info };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- Escritura de config (con detección de conflictos) ---
//
// Recibe:
//   - ruta: la ruta del archivo
//   - configNuevo: el objeto de configuración a guardar
//   - infoEsperada: { mtimeMs, hash } que el renderer leyó al abrir admin
//                    (null si es la primera escritura o no se quiere comprobar)
//
// Devuelve:
//   - { ok: true, info } si se guardó
//   - { ok: false, conflicto: true, infoActual } si hubo conflicto
//   - { ok: false, error } si error genérico
//
/**
 * Reinyecta la clave admin en un config recibido del renderer
 * (que la recibe stripped). Si el archivo en disco no se puede
 * leer (caso degradado), usamos la clave por defecto en vez de
 * dejar el config sin admin.clave válido.
 */
function fusionarConClaveActual(ruta, configDelRenderer) {
  let claveActual = null;
  try {
    const cfgDisco = leerConfigDesdeArchivo(ruta);
    claveActual = (cfgDisco.admin && cfgDisco.admin.clave) || null;
  } catch (_) {
    // Archivo nuevo o ilegible: fallback a la default. No silenciamos
    // por costumbre; lo hacemos porque es la única recuperación posible
    // sin romper la edición admin en curso.
    claveActual = buildDefaultConfig().admin.clave;
  }
  return reinyectarAdminClave(configDelRenderer, claveActual);
}

ipcMain.handle('config:write', (event, { ruta, configNuevo, infoEsperada }) => {
  try {
    // Detección de conflicto: ¿cambió el archivo desde que el admin lo leyó?
    if (infoEsperada) {
      const infoActual = obtenerInfoArchivo(ruta);
      if (infoActual) {
        const cambio = (infoActual.hash !== infoEsperada.hash);
        if (cambio) {
          // Intentar leer el config actual para mostrar quién lo modificó
          let modificadoPor = 'desconocido';
          let fechaActualizacion = '';
          try {
            const cfgActual = leerConfigDesdeArchivo(ruta);
            modificadoPor = cfgActual.modificado_por || 'desconocido';
            fechaActualizacion = cfgActual.fecha_actualizacion || '';
          } catch (_) {}

          logger.warn('config:write conflict detected', {
            ruta, modificadoPor, fechaActualizacion
          });
          return {
            ok: false,
            conflicto: true,
            infoActual,
            modificadoPor,
            fechaActualizacion
          };
        }
      }
    }

    // Snapshot del config previo en disco para calcular el diff
    // antes de sobrescribir. Si no se puede leer (primer arranque,
    // archivo corrupto), seguimos: el audit log saldrá con kind:'add'
    // en cada campo nuevo, lo cual es correcto.
    let configPrevio = null;
    try { configPrevio = leerConfigDesdeArchivo(ruta); } catch (_) {}

    const configCompleto = fusionarConClaveActual(ruta, configNuevo);
    validarFormaConfig(configCompleto);
    validateConfigSchema(configCompleto);
    const contenido = serializarConfig(configCompleto);

    // Backup antes de sobrescribir
    const backupPath = crearBackup(ruta);

    // Escribir
    fs.writeFileSync(ruta, contenido, 'utf-8');

    // Audit AFTER successful write (orden: backup → write → audit).
    // Si esto falla, no rompemos al usuario: el cambio está hecho y
    // existe el backup. Solo logueamos.
    try {
      const cambios = configPrevio ? diffObjects(configPrevio, configCompleto) : [];
      appendAuditEntry(ruta, {
        usuario: configCompleto.modificado_por || 'desconocido',
        app_version: app.getVersion(),
        cambios
      });
      logger.info('config:write success', {
        ruta, usuario: configCompleto.modificado_por, cambios: cambios.length, backupPath
      });
    } catch (auditErr) {
      logger.warn('audit append failed (non-blocking)', { error: auditErr.message });
    }

    // Devolver nueva info
    const infoNueva = obtenerInfoArchivo(ruta);
    return { ok: true, info: infoNueva, backupPath };
  } catch (err) {
    logger.error('config:write failed', { ruta, error: err.message });
    return { ok: false, error: err.message };
  }
});

// --- Forzar escritura (sobrescribir conflicto) ---
ipcMain.handle('config:force-write', (event, { ruta, configNuevo }) => {
  try {
    let configPrevio = null;
    try { configPrevio = leerConfigDesdeArchivo(ruta); } catch (_) {}

    const configCompleto = fusionarConClaveActual(ruta, configNuevo);
    validarFormaConfig(configCompleto);
    validateConfigSchema(configCompleto);
    const contenido = serializarConfig(configCompleto);
    const backupPath = crearBackup(ruta);
    fs.writeFileSync(ruta, contenido, 'utf-8');

    try {
      const cambios = configPrevio ? diffObjects(configPrevio, configCompleto) : [];
      appendAuditEntry(ruta, {
        usuario: configCompleto.modificado_por || 'desconocido',
        app_version: app.getVersion(),
        cambios
      });
      logger.info('config:force-write success', {
        ruta, usuario: configCompleto.modificado_por, cambios: cambios.length, backupPath
      });
    } catch (auditErr) {
      logger.warn('audit append failed (non-blocking)', { error: auditErr.message });
    }

    const infoNueva = obtenerInfoArchivo(ruta);
    return { ok: true, info: infoNueva };
  } catch (err) {
    logger.error('config:force-write failed', { ruta, error: err.message });
    return { ok: false, error: err.message };
  }
});

// --- Audit log ---
//
// `audit:list` returns the last N entries of <NAS>/audit.log (oldest
// to newest within the slice). `audit:diff-preview` is a pure helper
// the renderer can use to compute the diff between the current admin
// draft and the on-disk config, used by the "review changes" modal.
ipcMain.handle('audit:list', (event, { ruta, limit }) => {
  try {
    const lim = Number.isFinite(limit) ? Math.min(Math.max(1, limit), 5000) : 200;
    return { ok: true, entries: readRecentEntries(ruta, lim) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('audit:diff-preview', (event, { ruta, configNuevo }) => {
  try {
    let configPrevio = null;
    try { configPrevio = leerConfigDesdeArchivo(ruta); } catch (_) {}
    const configCompleto = fusionarConClaveActual(ruta, configNuevo);
    const cambios = configPrevio ? diffObjects(configPrevio, configCompleto) : [];
    return { ok: true, cambios };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- Verificación de la clave admin (en main, no en renderer) ---
//
// El renderer recibe el config sin `admin.clave`, así que la
// comparación de la clave debe ocurrir aquí. Usamos
// `crypto.timingSafeEqual` para no filtrar por tiempo. Si las
// longitudes difieren, devolvemos `false` directamente: el
// timing sigue ligado a la longitud del candidato, no a su
// contenido, lo cual es aceptable para un "anti-clic-accidental".
ipcMain.handle('auth:verify-admin', (event, { ruta, clave }) => {
  try {
    if (typeof clave !== 'string' || typeof ruta !== 'string') {
      return { ok: false, error: 'Parámetros inválidos' };
    }
    const cfg = leerConfigDesdeArchivo(ruta);
    const claveActual = (cfg.admin && cfg.admin.clave) || '';
    const aBuf = Buffer.from(clave, 'utf-8');
    const bBuf = Buffer.from(claveActual, 'utf-8');
    if (aBuf.length !== bBuf.length) {
      return { ok: true, valida: false };
    }
    const valida = crypto.timingSafeEqual(aBuf, bBuf);
    return { ok: true, valida };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- Info del archivo (para detectar cambios externos) ---
ipcMain.handle('config:info', (event, ruta) => {
  try {
    return obtenerInfoArchivo(ruta);
  } catch (err) {
    return null;
  }
});

// --- Diálogo de confirmación nativa ---
ipcMain.handle('dialog:confirmar-conflicto', async (event, datos) => {
  const { modificadoPor, fechaActualizacion } = datos;
  const respuesta = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Conflicto al guardar',
    message: 'El archivo fue modificado mientras editabas',
    detail: `Otro usuario (${modificadoPor || 'desconocido'}) modificó el config el ${fechaActualizacion || 'sin fecha'}. ¿Cómo quieres proceder?`,
    buttons: [
      'Sobrescribir (mis cambios ganan)',
      'Descartar mis cambios (recargar)',
      'Cancelar'
    ],
    defaultId: 2,
    cancelId: 2
  });
  return respuesta.response; // 0, 1 o 2
});

ipcMain.handle('dialog:confirmar', async (event, { titulo, mensaje, detalle, botones, defaultId }) => {
  const respuesta = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    title: titulo,
    message: mensaje,
    detail: detalle || '',
    buttons: botones || ['Aceptar', 'Cancelar'],
    defaultId: typeof defaultId === 'number' ? defaultId : 0,
    cancelId: (botones || ['Aceptar', 'Cancelar']).length - 1
  });
  return respuesta.response;
});

ipcMain.handle('dialog:info', async (event, { titulo, mensaje, detalle }) => {
  await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: titulo,
    message: mensaje,
    detail: detalle || ''
  });
});

ipcMain.handle('dialog:error', async (event, { titulo, mensaje, detalle }) => {
  await dialog.showMessageBox(mainWindow, {
    type: 'error',
    title: titulo,
    message: mensaje,
    detail: detalle || ''
  });
});

// --- Logs (electron-log) ---
ipcMain.handle('logs:read-last', (event, lineLimit) => {
  try {
    const limit = Number.isFinite(lineLimit) ? Math.min(Math.max(1, lineLimit), 5000) : 200;
    return { ok: true, path: getLogPath(), lines: readLastLines(limit) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- Quote history (local, per-PC) ---
//
// Stored under <userData>/presupuestos.json. The renderer doesn't
// need to know the path; it just sends/receives plain quote objects.
ipcMain.handle('quotes:save', (event, draft) => {
  try {
    const saved = saveQuoteToHistory(SETTINGS_DIR, draft);
    logger.info('quote saved', { id: saved.id, total: saved.total_iva_inc });
    return { ok: true, quote: saved };
  } catch (err) {
    logger.error('quote save failed', { error: err.message });
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('quotes:list', () => {
  try {
    return { ok: true, quotes: listQuotes(SETTINGS_DIR) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('quotes:search', (event, query) => {
  try {
    return { ok: true, quotes: searchQuotes(SETTINGS_DIR, query) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('quotes:get', (event, id) => {
  try {
    return { ok: true, quote: getQuote(SETTINGS_DIR, id) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('quotes:delete', (event, id) => {
  try {
    const removed = deleteQuote(SETTINGS_DIR, id);
    if (removed) logger.info('quote deleted', { id });
    return { ok: true, removed };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- PDF export ---
//
// Renders the quote into a hidden BrowserWindow and uses
// `webContents.printToPDF` (built into Electron) to produce the
// file. We do not depend on external PDF libraries.
//
// Inputs:
//   { quote, empresa, presupuesto } -- quote is the persisted record
//                                       OR a fresh draft (resultado-only).
//   { defaultName }                 -- suggested file name.
//
// Returns { ok, ruta } on success or { ok:false, error } on failure.
ipcMain.handle('pdf:export', async (event, payload) => {
  const { quote, empresa, presupuesto, defaultName } = payload || {};
  if (!quote) return { ok: false, error: 'Falta el presupuesto a exportar.' };

  let win = null;
  let tmpHtmlPath = null;
  try {
    const saveDialog = await dialog.showSaveDialog(mainWindow, {
      title: 'Exportar presupuesto a PDF',
      defaultPath: defaultName || `${quote.id || 'presupuesto'}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (saveDialog.canceled || !saveDialog.filePath) {
      return { ok: false, cancelado: true };
    }

    const html = renderQuoteHtml(quote, { empresa, presupuesto });
    // electron-builder strips temp dirs from app userData, so use the
    // OS temp folder. The file is deleted after PDF generation.
    tmpHtmlPath = path.join(app.getPath('temp'), `packprice-quote-${Date.now()}.html`);
    fs.writeFileSync(tmpHtmlPath, html, 'utf-8');

    win = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    await win.loadFile(tmpHtmlPath);
    const pdfBuffer = await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { marginType: 'default' }
    });
    fs.writeFileSync(saveDialog.filePath, pdfBuffer);

    logger.info('pdf exported', { id: quote.id, ruta: saveDialog.filePath });
    return { ok: true, ruta: saveDialog.filePath };
  } catch (err) {
    logger.error('pdf export failed', { error: err.message });
    return { ok: false, error: err.message };
  } finally {
    if (win && !win.isDestroyed()) win.close();
    if (tmpHtmlPath && fs.existsSync(tmpHtmlPath)) {
      try { fs.unlinkSync(tmpHtmlPath); } catch (_) {}
    }
  }
});

// ============================================================
// Ciclo de vida de la app
// ============================================================

app.whenReady().then(() => {
  configureLogger({ logDir: LOG_DIR });
  logger.info('app started', {
    version: app.getVersion(),
    platform: process.platform,
    userData: SETTINGS_DIR
  });

  process.on('uncaughtException', (err) => {
    logger.error('uncaughtException', { message: err.message, stack: err.stack });
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandledRejection', { reason: String(reason) });
  });

  crearVentana();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) crearVentana();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
