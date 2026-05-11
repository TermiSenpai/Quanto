// ============================================================
// PackPrice · Renderer (orquestación)
// ============================================================
// - Bootstrap y enrutado entre pantallas
// - Eventos del DOM
// - Llamadas IPC al proceso principal vía window.packprice
//
// La lógica pura vive en:
//   - calculo.js  (cálculo de packs)
//   - admin.js    (renderizado del editor admin)
//   - format.js   (utilidades de DOM/formato)
// ============================================================

import { el, show, hide, intDe, fmtEur, fmtPct, deepClone } from './format.js';
import {
  calcularPackPena,
  calcularPackIndividual,
  calcularPackMixto,
  calcularPackPersonalizado,
  getTramo
} from './calculo.js';
import {
  renderAdminTabContent,
  actualizarConfigDesdeInput,
  ejecutarAccionAdmin
} from './admin.js';
import {
  renderAuditTab,
  renderDiffPreview,
  renderLogsModal
} from './admin-extras.js';
import {
  renderHistoryList,
  buildQuoteDraft
} from './history.js';

// ============================================================
// Estado del módulo
// ============================================================
let CFG = null;                    // configuración actual cargada del NAS
let SETTINGS = null;                // ruta_config + nombre_usuario
let infoConfigAlAbrirAdmin = null;  // mtime + hash al abrir admin (conflictos)
let CFG_BACKUP = null;              // copia para "Cancelar cambios"
let eventosBindeados = false;
let ultimoResultado = null;         // útil para "Copiar resumen"

const estado = {
  packId: null,
  esAdmin: false,
  adminTab: 'parametros',
  mostrarCostes: false      // atajo secreto: 3 × "." alterna la vista
};

// ============================================================
// Metadatos visuales por pack (icono y descripción de tarjeta)
// ============================================================
// Se mapean por id; si entra un pack nuevo en el config sin entrada
// aquí, usa los defaults seguros.
const PACK_META = {
  pena_completa: {
    icon: 'i-pack',
    desc: 'Camiseta + sudadera por persona. Hasta 4 caras de impresión.'
  },
  solo_camisetas: {
    icon: 'i-shirt',
    desc: 'Pack ligero. Una camiseta por persona, hasta 2 caras.'
  },
  solo_clasica: {
    icon: 'i-hoodie',
    desc: 'Sudaderas sin capucha (CLASICA). Una por persona.'
  },
  solo_urban: {
    icon: 'i-hoodie',
    desc: 'Sudaderas con capucha (URBAN). Una por persona.'
  },
  sudaderas_mixto: {
    icon: 'i-layers',
    desc: 'CLASICA + URBAN combinadas en el mismo pedido.'
  },
  personalizado: {
    icon: 'i-plus',
    desc: 'Combina manualmente cualquier cantidad de cada modelo Roly.'
  }
};

const ADMIN_TAB_META = {
  parametros: { titulo: 'Parámetros de cálculo', desc: 'Variables que afectan al coste interno y al recargo de tallas grandes.' },
  modelos:    { titulo: 'Modelos Roly',          desc: 'Precio base de cada prenda Roly. No incluye DTF ni mano de obra.' },
  tramos:     { titulo: 'Tramos por volumen',    desc: 'Rangos de unidades que activan cada tramo y su reducción de tiempo.' },
  packs:      { titulo: 'Packs (PVP)',           desc: 'PVP final IVA incluido por tramo, capucha y caras.' },
  auditoria:  { titulo: 'Auditoría',              desc: 'Quién cambió qué y cuándo, leído desde audit.log junto al config.' }
};

// ============================================================
// Arranque: decidir pantalla a mostrar
// ============================================================

async function arrancar() {
  SETTINGS = await window.packprice.leerSettings();

  if (!SETTINGS || !SETTINGS.ruta_config || !SETTINGS.nombre_usuario) {
    mostrarBienvenida();
    return;
  }

  await cargarConfigYMostrarApp();
}

function mostrarBienvenida() {
  hide('pantalla-app');
  hide('pantalla-error');
  show('pantalla-bienvenida');

  el('btn-bv-explorar').addEventListener('click', async () => {
    const r = await window.packprice.seleccionarConfig();
    if (!r.cancelado) {
      el('bv-ruta').value = r.ruta;
      validarFormBienvenida();
    }
  });

  el('bv-nombre').addEventListener('input', validarFormBienvenida);
  el('bv-ruta').addEventListener('input', validarFormBienvenida);
  el('btn-bv-empezar').addEventListener('click', empezarPrimeraVez);

  validarFormBienvenida();
  setTimeout(() => el('bv-nombre').focus(), 50);

  window.packprice.rutaConfigPorDefecto()
    .then((sugerencia) => {
      const input = el('bv-ruta');
      if (!input.value && sugerencia && sugerencia.sugerida) {
        input.value = sugerencia.sugerida;
        validarFormBienvenida();
      }
    })
    .catch(() => { /* no bloqueamos la UI por una sugerencia */ });
}

function validarFormBienvenida() {
  const nombre = el('bv-nombre').value.trim();
  const ruta = el('bv-ruta').value.trim();
  el('btn-bv-empezar').disabled = !(nombre && ruta);
}

async function empezarPrimeraVez() {
  const nombre = el('bv-nombre').value.trim();
  const ruta = el('bv-ruta').value.trim();
  hide('bv-error');

  const btn = el('btn-bv-empezar');
  const textoOriginal = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Comprobando ruta…';
  try {
    await empezarPrimeraVezImpl(nombre, ruta);
  } finally {
    btn.innerHTML = textoOriginal;
    validarFormBienvenida();
  }
}

async function empezarPrimeraVezImpl(nombre, ruta) {
  const exist = await window.packprice.existeConfig(ruta);
  if (!exist.existe) {
    if (!exist.escribible) {
      mostrarErrorBienvenida(
        'No se puede crear el archivo en esa ruta. Comprueba que el NAS está accesible y tienes permisos de escritura.'
      );
      return;
    }
    const opcion = await window.packprice.confirmar({
      titulo: 'Archivo no encontrado',
      mensaje: '¿Crear config.js con los valores por defecto?',
      detalle: `No se encontró un archivo de configuración en:\n${ruta}\n\nSe creará uno nuevo con los valores por defecto del plan.`,
      botones: ['Crear con valores por defecto', 'Cancelar'],
      defaultId: 0
    });
    if (opcion !== 0) return;

    const creado = await window.packprice.crearConfigDefault({ ruta, modificadoPor: nombre });
    if (!creado.ok) {
      mostrarErrorBienvenida(`No se pudo crear el archivo: ${creado.error}`);
      return;
    }
  } else {
    const r = await window.packprice.leerConfig(ruta);
    if (!r.ok) {
      mostrarErrorBienvenida(`No se pudo leer el archivo: ${r.error}`);
      return;
    }
  }

  SETTINGS = { ruta_config: ruta, nombre_usuario: nombre };
  const guardado = await window.packprice.guardarSettings(SETTINGS);
  if (!guardado.ok) {
    mostrarErrorBienvenida(`No se pudo guardar la configuración local: ${guardado.error}`);
    return;
  }

  hide('pantalla-bienvenida');
  await cargarConfigYMostrarApp();
}

function mostrarErrorBienvenida(mensaje) {
  el('bv-error').textContent = mensaje;
  show('bv-error');
}

async function cargarConfigYMostrarApp() {
  const r = await window.packprice.leerConfig(SETTINGS.ruta_config);
  if (!r.ok) {
    await mostrarPantallaError(r.error);
    return;
  }

  CFG = r.config;
  garantizarPacksPorDefecto(CFG);
  hide('pantalla-bienvenida');
  hide('pantalla-error');
  show('pantalla-app');
  inicializarApp();
}

/**
 * Asegura que el config en memoria tiene los packs y parámetros
 * introducidos en versiones posteriores al archivo del NAS. Solo añade
 * campos que faltan con defaults seguros; no toca el archivo hasta que
 * un admin guarde.
 */
function garantizarPacksPorDefecto(cfg) {
  if (!cfg.packs) cfg.packs = {};
  if (!cfg.packs.personalizado) {
    cfg.packs.personalizado = {
      tipo: 'personalizado',
      nombre: 'Pack personalizado',
      min_total: 10,
      modelos_referencia: {
        BEAGLE:  'solo_camisetas',
        CLASICA: 'solo_clasica',
        URBAN:   'solo_urban'
      }
    };
  }

  if (!cfg.parametros) cfg.parametros = {};
  if (cfg.parametros.extra_nombre_eur      === undefined) cfg.parametros.extra_nombre_eur      = 1.5;
  if (cfg.parametros.extra_manga_corta_eur === undefined) cfg.parametros.extra_manga_corta_eur = 1.5;
  if (cfg.parametros.extra_manga_larga_eur === undefined) cfg.parametros.extra_manga_larga_eur = 3;
}

async function mostrarPantallaError(detalle) {
  hide('pantalla-app');
  hide('pantalla-bienvenida');
  show('pantalla-error');
  el('error-detalle').textContent = detalle;

  const exist = await window.packprice.existeConfig(SETTINGS.ruta_config);
  const btnCrear = el('btn-error-crear-default');
  if (btnCrear) {
    if (!exist.existe && exist.escribible) {
      btnCrear.classList.remove('hidden');
    } else {
      btnCrear.classList.add('hidden');
    }
    btnCrear.onclick = async () => {
      const opcion = await window.packprice.confirmar({
        titulo: 'Crear config por defecto',
        mensaje: '¿Crear config.js con los valores por defecto?',
        detalle: `Ruta: ${SETTINGS.ruta_config}`,
        botones: ['Crear', 'Cancelar'],
        defaultId: 0
      });
      if (opcion !== 0) return;

      const creado = await window.packprice.crearConfigDefault({
        ruta: SETTINGS.ruta_config,
        modificadoPor: SETTINGS.nombre_usuario
      });
      if (!creado.ok) {
        await window.packprice.mostrarError({
          titulo: 'Error',
          mensaje: 'No se pudo crear el archivo',
          detalle: creado.error
        });
        return;
      }
      await cargarConfigYMostrarApp();
    };
  }

  el('btn-error-reintentar').onclick = async () => {
    await cargarConfigYMostrarApp();
  };
  el('btn-error-cambiar-ruta').onclick = async () => {
    const r = await window.packprice.seleccionarConfig();
    if (!r.cancelado) {
      SETTINGS.ruta_config = r.ruta;
      await window.packprice.guardarSettings(SETTINGS);
      await cargarConfigYMostrarApp();
    }
  };
}

// ============================================================
// Inicialización de la app principal
// ============================================================

function inicializarApp() {
  el('info-usuario').textContent = SETTINGS.nombre_usuario;
  el('info-fecha-cfg').textContent = abreviarFechaCfg(CFG.fecha_actualizacion);
  el('cfg-version').textContent = CFG.version || '?';

  // Sustituir spans con valores de config
  document.querySelectorAll('[data-cfg]').forEach(span => {
    const key = span.dataset.cfg;
    if (CFG.parametros && CFG.parametros[key] !== undefined) {
      span.textContent = CFG.parametros[key];
    }
  });

  renderListaPacks();

  if (!eventosBindeados) {
    bindearEventos();
    eventosBindeados = true;
  }
}

function abreviarFechaCfg(fecha) {
  if (!fecha) return 'sin fecha';
  // "28/4/2026, 15:32:10" → "28/4 · 15:32"
  const [fechaPart, horaPart = ''] = fecha.split(',');
  const horaCorta = horaPart.trim().split(':').slice(0, 2).join(':');
  const fechaCorta = fechaPart.split('/').slice(0, 2).join('/');
  return horaCorta ? `${fechaCorta} · ${horaCorta}` : fechaCorta;
}

function bindearEventos() {
  el('btn-calcular').addEventListener('click', ejecutarCalculo);
  el('btn-reset').addEventListener('click', resetear);
  el('btn-cambiar-pack').addEventListener('click', volverASeleccion);
  const btnCambiarPack2 = el('btn-cambiar-pack-2');
  if (btnCambiarPack2) btnCambiarPack2.addEventListener('click', volverASeleccion);
  const btnEditar = el('btn-editar-pedido');
  if (btnEditar) btnEditar.addEventListener('click', volverAEditar);

  el('btn-recargar').addEventListener('click', recargarConfig);
  el('btn-ajustes').addEventListener('click', abrirAjustes);

  el('btn-admin-toggle').addEventListener('click', abrirAdmin);
  el('btn-cerrar-admin').addEventListener('click', cerrarAdmin);
  el('btn-admin-login').addEventListener('click', loginAdmin);
  el('admin-clave').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') loginAdmin();
  });
  el('btn-guardar-config').addEventListener('click', guardarConfigEnNAS);
  el('btn-cancelar-admin').addEventListener('click', cancelarCambiosAdmin);

  // Logs viewer (admin footer)
  const btnVerLogs = el('btn-ver-logs');
  if (btnVerLogs) btnVerLogs.addEventListener('click', abrirLogs);
  const btnLogsCerrar = el('btn-logs-cerrar');
  if (btnLogsCerrar) btnLogsCerrar.addEventListener('click', cerrarLogs);
  const btnLogsClose = el('btn-cerrar-logs');
  if (btnLogsClose) btnLogsClose.addEventListener('click', cerrarLogs);
  const logsOverlay = el('logs-overlay');
  if (logsOverlay) {
    logsOverlay.addEventListener('click', (e) => {
      if (e.target.id === 'logs-overlay') cerrarLogs();
    });
  }

  // History
  const btnHistorial = el('btn-historial');
  if (btnHistorial) btnHistorial.addEventListener('click', abrirHistorial);
  const btnHistoryCerrar = el('btn-history-cerrar');
  if (btnHistoryCerrar) btnHistoryCerrar.addEventListener('click', cerrarHistorial);
  const btnHistoryClose = el('btn-cerrar-history');
  if (btnHistoryClose) btnHistoryClose.addEventListener('click', cerrarHistorial);
  const historyOverlay = el('history-overlay');
  if (historyOverlay) {
    historyOverlay.addEventListener('click', (e) => {
      if (e.target.id === 'history-overlay') cerrarHistorial();
    });
  }
  const searchInput = el('history-search');
  if (searchInput) {
    let searchTimer = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(refrescarHistorial, 150);
    });
  }
  const btnGuardarPresupuesto = el('btn-guardar-presupuesto');
  if (btnGuardarPresupuesto) btnGuardarPresupuesto.addEventListener('click', guardarPresupuesto);
  const btnExportarPdf = el('btn-exportar-pdf');
  if (btnExportarPdf) btnExportarPdf.addEventListener('click', exportarPresupuestoPdf);

  document.querySelectorAll('.admin-nav__item, .admin-tab').forEach(tab => {
    tab.addEventListener('click', () => mostrarAdminTab(tab.dataset.tab));
  });

  el('admin-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'admin-overlay') cerrarAdmin();
  });

  // Modal ajustes
  el('btn-cerrar-ajustes').addEventListener('click', cerrarAjustes);
  el('btn-aj-cancelar').addEventListener('click', cerrarAjustes);
  el('btn-aj-guardar').addEventListener('click', guardarAjustes);
  el('btn-aj-explorar').addEventListener('click', async () => {
    const r = await window.packprice.seleccionarConfig();
    if (!r.cancelado) {
      el('aj-ruta').value = r.ruta;
    }
  });
  el('ajustes-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'ajustes-overlay') cerrarAjustes();
  });

  // Acciones del resultado: copia un resumen al portapapeles. PDF queda
  // como placeholder hasta tener implementación.
  const btnCopiar = el('btn-copiar-resumen');
  if (btnCopiar) btnCopiar.addEventListener('click', copiarResumen);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      cerrarAdmin();
      cerrarAjustes();
      return;
    }

    if (e.key === 'Enter') {
      const paso2 = el('seccion-paso2');
      if (paso2.classList.contains('hidden')) return;
      if (!el('admin-overlay').classList.contains('hidden')) return;
      if (!el('ajustes-overlay').classList.contains('hidden')) return;
      if (!(e.target instanceof HTMLElement) || !paso2.contains(e.target)) return;

      e.preventDefault();
      ejecutarCalculo();
    }
  });

  document.addEventListener('focusin', (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type === 'number') {
      e.target.select();
    }
  });

  document.addEventListener('wheel', (e) => {
    const a = document.activeElement;
    if (a instanceof HTMLInputElement && a.type === 'number' && a === e.target) {
      a.blur();
    }
  }, { passive: true });

  bindearAtajoSecretoCostes();
}

/**
 * Atajo secreto: 3 pulsaciones de "." (numpad o no) en menos de 800 ms
 * alternan la visualización de costes y márgenes en el resultado. Útil
 * para ocultar datos internos cuando el cliente está mirando la pantalla.
 *
 * Se ignora si el foco está en un input/textarea/select para no romper
 * la introducción de decimales (numpad "." o coma decimal).
 */
function bindearAtajoSecretoCostes() {
  const VENTANA_MS = 800;
  let pulsaciones = 0;
  let timer = null;

  const reset = () => {
    pulsaciones = 0;
    if (timer) { clearTimeout(timer); timer = null; }
  };

  document.addEventListener('keydown', (e) => {
    if (e.key !== '.') {
      // Cualquier otra tecla rompe la cadena.
      if (pulsaciones > 0) reset();
      return;
    }

    const t = e.target;
    const enCampo = t instanceof HTMLElement
      && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
    if (enCampo) return;

    pulsaciones++;
    if (timer) clearTimeout(timer);
    timer = setTimeout(reset, VENTANA_MS);

    if (pulsaciones >= 3) {
      reset();
      estado.mostrarCostes = !estado.mostrarCostes;
      // Re-render solo si la pantalla del resultado está visible.
      const resultadoVisible = !el('seccion-resultado').classList.contains('hidden');
      if (resultadoVisible && ultimoResultado) {
        renderResultado(ultimoResultado);
      }
    }
  });
}

// ============================================================
// UI: selección de pack
// ============================================================

function renderListaPacks() {
  const container = el('lista-packs');
  container.innerHTML = '';

  for (const [id, pack] of Object.entries(CFG.packs)) {
    const meta = PACK_META[id] || { icon: 'i-pack', desc: '' };
    const desde = calcularDesde(pack);
    const minTexto = pack.tipo === 'mixto'
      ? `Mín. ${pack.min_total} unidades en total`
      : `Mín. ${pack.min} unidades`;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pack-card';
    btn.dataset.packId = id;
    btn.innerHTML = `
      <div class="pack-card__top">
        <span class="pack-card__icon"><svg class="icon icon--lg"><use href="#${meta.icon}"/></svg></span>
        <span class="pack-card__arrow"><svg class="icon"><use href="#i-arrow-right"/></svg></span>
      </div>
      <span class="pack-card__title">${escapeHTML(pack.nombre)}</span>
      <span class="pack-card__desc">${escapeHTML(meta.desc || minTexto)}</span>
      <div class="pack-card__foot">
        ${desde !== null ? `<span class="badge badge--accent">Desde ${fmtEur(desde)}</span>` : ''}
        <span class="badge badge--neutral">${minTexto}</span>
      </div>
    `;
    btn.addEventListener('click', () => seleccionarPack(id));
    container.appendChild(btn);
  }
}

/**
 * "Desde X €" para la tarjeta del pack: cogemos el PVP del primer tramo
 * (T1) con la combinación por defecto (2 caras, sin capucha si aplica).
 * Es el precio de referencia más comprensible para el usuario.
 */
function calcularDesde(pack) {
  if (pack.tipo === 'pena' && pack.pvp && pack.pvp.sin_capucha) {
    const t1 = CFG.tramos[0]?.id;
    return pack.pvp.sin_capucha.dos_caras?.[t1] ?? null;
  }
  if (pack.tipo === 'individual' && pack.pvp && pack.pvp.dos_caras) {
    const t1 = CFG.tramos[0]?.id;
    return pack.pvp.dos_caras[t1] ?? null;
  }
  if (pack.tipo === 'mixto' && pack.packs_referencia) {
    const refClasica = CFG.packs[pack.packs_referencia.CLASICA];
    if (refClasica) return calcularDesde(refClasica);
  }
  if (pack.tipo === 'personalizado' && pack.modelos_referencia) {
    // El más barato de las referencias en T1 con 2 caras: orienta al usuario.
    let min = null;
    for (const refId of Object.values(pack.modelos_referencia)) {
      const ref = CFG.packs[refId];
      const v = ref ? calcularDesde(ref) : null;
      if (v !== null && (min === null || v < min)) min = v;
    }
    return min;
  }
  return null;
}

function seleccionarPack(packId) {
  estado.packId = packId;
  hide('error-msg');

  const pack = CFG.packs[packId];
  const meta = PACK_META[packId] || { icon: 'i-pack', desc: '' };

  // Marcar tarjeta seleccionada visualmente (se ve al volver a paso 1)
  document.querySelectorAll('.pack-card').forEach(card => {
    card.classList.toggle('is-selected', card.dataset.packId === packId);
  });

  el('pack-titulo').textContent = pack.nombre;
  el('pack-subtitulo').textContent = meta.desc || (pack.tipo === 'mixto'
    ? `Mín. ${pack.min_total} unidades en total`
    : `Mín. ${pack.min} unidades`);

  // Icono de la cabecera del paso 2
  const iconWrap = document.querySelector('#seccion-paso2 .section-card__icon');
  if (iconWrap) {
    iconWrap.innerHTML = `<svg class="icon icon--lg"><use href="#${meta.icon}"/></svg>`;
  }

  renderInputsPack(packId);
  irAPantalla('paso2');
  hookPreviewListeners();
  recalcularPreview();
}

/**
 * Navegación tipo "una pantalla a la vez": muestra la sección indicada
 * y oculta las demás. Hace scroll al inicio para que cada paso empiece
 * desde arriba, no desde donde estabas en la pantalla anterior.
 */
function irAPantalla(pantalla) {
  const mapeo = {
    paso1:     'seccion-paso1',
    paso2:     'seccion-paso2',
    resultado: 'seccion-resultado'
  };
  for (const [clave, id] of Object.entries(mapeo)) {
    if (clave === pantalla) {
      show(id);
    } else {
      hide(id);
    }
  }
  // Reset del scroll al cambiar de pantalla.
  const scroller = document.querySelector('.app-body') || window;
  if (scroller && typeof scroller.scrollTo === 'function') {
    scroller.scrollTo({ top: 0, behavior: 'instant' });
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function renderInputsPack(packId) {
  const pack = CFG.packs[packId];
  const container = el('inputs-pack');

  if (pack.tipo === 'pena') {
    container.innerHTML = `
      <div class="form-grid-2">
        <div class="field">
          <label class="field__label" for="in_cantidad">Número de packs (personas)</label>
          ${numStep('in_cantidad', pack.min, pack.min)}
          <span class="field__hint">Mínimo ${pack.min}. Cada pack incluye 1 camiseta + 1 sudadera.</span>
        </div>
        <div class="field">
          <span class="field__label">Caras de impresión (cada prenda)</span>
          <div class="radio-cards radio-cards--inline">
            <label class="radio-card"><input type="radio" name="caras" value="1"> 1 cara</label>
            <label class="radio-card"><input type="radio" name="caras" value="2" checked> 2 caras</label>
          </div>
        </div>
      </div>
      <div class="field">
        <span class="field__label">Modelo de sudadera</span>
        <div class="radio-cards">
          <label class="radio-card">
            <input type="radio" name="capucha" value="sin" checked>
            <span><strong>CLASICA</strong> · sin capucha</span>
          </label>
          <label class="radio-card">
            <input type="radio" name="capucha" value="con">
            <span><strong>URBAN</strong> · con capucha</span>
          </label>
        </div>
        <span class="field__hint">El modelo afecta al PVP del pack.</span>
      </div>
    `;
  } else if (pack.tipo === 'individual') {
    const m = CFG.modelos_roly[pack.modelo];
    container.innerHTML = `
      <div class="form-grid-2">
        <div class="field">
          <label class="field__label" for="in_cantidad">Cantidad de ${m.nombre.toLowerCase()}</label>
          ${numStep('in_cantidad', pack.min, pack.min)}
          <span class="field__hint">Mínimo ${pack.min} unidades.</span>
        </div>
        <div class="field">
          <span class="field__label">Caras de impresión</span>
          <div class="radio-cards radio-cards--inline">
            <label class="radio-card"><input type="radio" name="caras" value="1"> 1 cara</label>
            <label class="radio-card"><input type="radio" name="caras" value="2" checked> 2 caras</label>
          </div>
        </div>
      </div>
    `;
  } else if (pack.tipo === 'mixto') {
    container.innerHTML = `
      <div class="form-grid-2">
        <div class="field">
          <label class="field__label" for="in_cant_clasica">Sudaderas SIN capucha (CLASICA)</label>
          ${numStep('in_cant_clasica', 0, 0)}
        </div>
        <div class="field">
          <label class="field__label" for="in_cant_urban">Sudaderas CON capucha (URBAN)</label>
          ${numStep('in_cant_urban', 0, 0)}
        </div>
      </div>
      <div class="field">
        <span class="field__label">Caras de impresión</span>
        <div class="radio-cards radio-cards--inline">
          <label class="radio-card"><input type="radio" name="caras" value="1"> 1 cara</label>
          <label class="radio-card"><input type="radio" name="caras" value="2" checked> 2 caras</label>
        </div>
        <span class="field__hint">Total mínimo: ${pack.min_total} sudaderas. Cada sudadera factura a su PVP según el tramo del total.</span>
      </div>
    `;
  } else if (pack.tipo === 'personalizado') {
    const modelosDisponibles = Object.keys(pack.modelos_referencia || {});
    container.innerHTML = `
      <div id="lineas-personalizado" class="lineas-personalizado"></div>
      <div class="lineas-personalizado__add">
        <button id="btn-anadir-linea" type="button" class="btn btn-secondary">
          <svg class="icon"><use href="#i-plus"/></svg> Añadir línea
        </button>
        <span class="field__hint">
          Mín. ${pack.min_total} prendas en total. Cada línea factura al PVP del pack individual del modelo, según el tramo del total.
        </span>
      </div>
    `;
    // Línea inicial con el primer modelo disponible
    const cont = el('lineas-personalizado');
    cont.appendChild(crearLineaPersonalizado(modelosDisponibles, modelosDisponibles[0], 1, 2));

    el('btn-anadir-linea').addEventListener('click', () => {
      const idx = cont.children.length;
      cont.appendChild(crearLineaPersonalizado(modelosDisponibles, modelosDisponibles[0], 1, 2, idx));
      recalcularPreview();
    });

    cont.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-accion-linea="eliminar"]');
      if (!btn) return;
      const linea = btn.closest('.linea-personalizado');
      if (!linea) return;
      if (cont.children.length === 1) {
        // Mantener al menos una línea: limpiamos cantidad en lugar de borrar.
        const input = linea.querySelector('[data-linea-cantidad]');
        if (input) input.value = '0';
        recalcularPreview();
        return;
      }
      linea.remove();
      reindexarLineasPersonalizado(cont);
      recalcularPreview();
    });
  }

  // Wire NumberSteps
  container.querySelectorAll('.numstep').forEach(wireNumStep);
}

/**
 * Crea una <div.linea-personalizado> con select de modelo, cantidad y caras.
 * Los radios de caras necesitan un nombre único por línea para que cada
 * grupo sea independiente.
 */
function crearLineaPersonalizado(modelosDisponibles, modeloSel, cantidad, caras, idx = 0) {
  const wrap = document.createElement('div');
  wrap.className = 'linea-personalizado';
  wrap.dataset.idx = String(idx);

  const opciones = modelosDisponibles.map(id => {
    const m = CFG.modelos_roly[id];
    const nombre = m ? `${m.nombre} (${id})` : id;
    return `<option value="${id}" ${id === modeloSel ? 'selected' : ''}>${escapeHTML(nombre)}</option>`;
  }).join('');

  const carasName = `caras_linea_${idx}_${Math.random().toString(36).slice(2, 7)}`;
  wrap.innerHTML = `
    <div class="linea-personalizado__grid">
      <div class="field">
        <label class="field__label">Modelo</label>
        <select class="input" data-linea-modelo>${opciones}</select>
      </div>
      <div class="field">
        <label class="field__label">Cantidad</label>
        <input type="number" class="input" min="0" step="1" value="${cantidad}" data-linea-cantidad>
      </div>
      <div class="field">
        <span class="field__label">Caras</span>
        <div class="radio-cards radio-cards--inline">
          <label class="radio-card">
            <input type="radio" name="${carasName}" value="1" data-linea-caras ${caras === 1 ? 'checked' : ''}> 1 cara
          </label>
          <label class="radio-card">
            <input type="radio" name="${carasName}" value="2" data-linea-caras ${caras === 2 ? 'checked' : ''}> 2 caras
          </label>
        </div>
      </div>
      <button type="button" class="linea-personalizado__remove" data-accion-linea="eliminar"
              aria-label="Eliminar línea" title="Eliminar línea">
        <svg class="icon"><use href="#i-x"/></svg>
      </button>
    </div>
  `;
  return wrap;
}

function reindexarLineasPersonalizado(cont) {
  Array.from(cont.children).forEach((linea, idx) => {
    linea.dataset.idx = String(idx);
  });
}

function numStep(id, min, value) {
  return `
    <div class="numstep" data-min="${min}">
      <button type="button" class="numstep__btn" data-action="dec" aria-label="Disminuir">−</button>
      <input class="numstep__input" type="number" id="${id}" min="${min}" value="${value}">
      <button type="button" class="numstep__btn" data-action="inc" aria-label="Aumentar">+</button>
    </div>
  `;
}

function wireNumStep(stepEl) {
  const input = stepEl.querySelector('input');
  const min = parseInt(stepEl.dataset.min || '0', 10);
  stepEl.querySelector('[data-action="dec"]').addEventListener('click', () => {
    const v = Math.max(min, (parseInt(input.value, 10) || 0) - 1);
    input.value = v;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  stepEl.querySelector('[data-action="inc"]').addEventListener('click', () => {
    const v = (parseInt(input.value, 10) || 0) + 1;
    input.value = v;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function recogerInputs() {
  const pack = CFG.packs[estado.packId];
  const cant_4xl = intDe('cant_4xl');
  const cant_5xl = intDe('cant_5xl');
  const extras = {
    nombres:        intDe('cant_nombres'),
    mangas_cortas:  intDe('cant_mangas_cortas'),
    mangas_largas:  intDe('cant_mangas_largas')
  };

  if (pack.tipo === 'pena') {
    return {
      cantidad: intDe('in_cantidad'),
      capucha: document.querySelector('input[name="capucha"]:checked').value,
      caras: parseInt(document.querySelector('input[name="caras"]:checked').value, 10),
      cant_4xl, cant_5xl, extras
    };
  }
  if (pack.tipo === 'individual') {
    return {
      cantidad: intDe('in_cantidad'),
      caras: parseInt(document.querySelector('input[name="caras"]:checked').value, 10),
      cant_4xl, cant_5xl, extras
    };
  }
  if (pack.tipo === 'mixto') {
    return {
      cant_clasica: intDe('in_cant_clasica'),
      cant_urban: intDe('in_cant_urban'),
      caras: parseInt(document.querySelector('input[name="caras"]:checked').value, 10),
      cant_4xl, cant_5xl, extras
    };
  }
  if (pack.tipo === 'personalizado') {
    const lineas = [];
    document.querySelectorAll('.linea-personalizado').forEach(row => {
      const modelo = row.querySelector('[data-linea-modelo]')?.value || '';
      const cantidad = parseInt(row.querySelector('[data-linea-cantidad]')?.value, 10) || 0;
      const carasInput = row.querySelector('input[data-linea-caras]:checked');
      const caras = carasInput ? parseInt(carasInput.value, 10) : 2;
      lineas.push({ modelo, cantidad, caras });
    });
    return { lineas, cant_4xl, cant_5xl, extras };
  }
  return null;
}

// ============================================================
// Preview en vivo (sideCol del paso 2)
// ============================================================

let previewListenersAttached = false;
function hookPreviewListeners() {
  if (previewListenersAttached) return;
  const paso2 = el('seccion-paso2');
  if (!paso2) return;
  // Delegación: cualquier cambio en el formulario recalcula el preview.
  // Se engancha una sola vez (los inputs internos cambian al cambiar
  // de pack, pero la sección contenedora persiste).
  paso2.addEventListener('input', recalcularPreview);
  paso2.addEventListener('change', recalcularPreview);
  previewListenersAttached = true;
}

function recalcularPreview() {
  if (!estado.packId) return;

  const pack = CFG.packs[estado.packId];
  const opt = recogerInputsSafe();
  const r = opt ? calcularPackTipo(pack.tipo, opt) : null;

  const elTotal = el('preview-total');
  const elTramo = el('preview-tramo');
  const elMeta = el('preview-meta');
  const elRows = el('preview-rows');

  if (!r || r.error) {
    elTotal.textContent = '—';
    elTramo.textContent = '—';
    elMeta.textContent = r && r.error ? r.error : 'Rellena los campos para ver el precio';
    elRows.innerHTML = '';
    renderTramoBar(opt ? cantidadTotalDe(pack, opt) : 0);
    return;
  }

  ultimoResultado = r;
  elTotal.textContent = fmtEur(r.total_iva_inc);
  elTramo.textContent = `Tramo ${tramoIdDeEtiqueta(r.tramo)}`;

  const cantidad = r.es_mixto ? r.cantidad_total : r.cantidad;
  const unidadLabel = r.es_personalizado ? 'prendas' : 'sudaderas';
  const pvpTexto = r.es_mixto
    ? `${cantidad} ${unidadLabel}`
    : `${cantidad} × ${fmtEur(r.pvp_unitario)}`;
  elMeta.textContent = pvpTexto;

  // Filas de desglose breve
  let rowsHtml = '';
  if (r.es_mixto) {
    for (const d of r.desglose) {
      if (d.cantidad === 0) continue;
      rowsHtml += `<div class="preview__row"><span>${escapeHTML(d.modelo)} × ${d.cantidad}</span><strong>${fmtEur(d.subtotal)}</strong></div>`;
    }
  } else {
    rowsHtml += `<div class="preview__row"><span>Subtotal pack</span><strong>${fmtEur(r.subtotal)}</strong></div>`;
  }
  if (r.recargos > 0) {
    rowsHtml += `<div class="preview__row"><span>Recargo tallas grandes</span><strong>${fmtEur(r.recargos)}</strong></div>`;
  }
  if (r.extras_sin_iva > 0) {
    const e = r.extras_detalle || {};
    const partes = [];
    if (e.nombres)        partes.push(`${e.nombres} nombre${e.nombres > 1 ? 's' : ''}`);
    if (e.mangas_cortas)  partes.push(`${e.mangas_cortas} mc`);
    if (e.mangas_largas)  partes.push(`${e.mangas_largas} ml`);
    rowsHtml += `<div class="preview__row"><span>Extras (${partes.join(' · ')}) <em style="font-style: normal; opacity: 0.7;">sin IVA</em></span><strong>${fmtEur(r.extras_sin_iva)}</strong></div>`;
  }
  rowsHtml += `<div class="preview__row"><span>IVA (${fmtPct(CFG.parametros.iva)})</span><strong>${fmtEur(r.iva)}</strong></div>`;
  rowsHtml += `<div class="preview__row preview__row--total"><span>Total</span><strong>${fmtEur(r.total_iva_inc)}</strong></div>`;
  elRows.innerHTML = rowsHtml;

  renderTramoBar(cantidad);
}

function recogerInputsSafe() {
  try {
    const opt = recogerInputs();
    if (!opt) return null;
    if ('cantidad' in opt && (isNaN(opt.cantidad) || opt.cantidad <= 0)) return null;
    if ('cant_clasica' in opt && (opt.cant_clasica + opt.cant_urban) <= 0) return null;
    if ('lineas' in opt) {
      const total = (opt.lineas || []).reduce((s, l) => s + (l.cantidad || 0), 0);
      if (total <= 0) return null;
    }
    return opt;
  } catch (_) {
    return null;
  }
}

function calcularPackTipo(tipo, opt) {
  try {
    if (tipo === 'pena')          return calcularPackPena(CFG, opt);
    if (tipo === 'individual')    return calcularPackIndividual(CFG, estado.packId, opt);
    if (tipo === 'mixto')         return calcularPackMixto(CFG, opt);
    if (tipo === 'personalizado') return calcularPackPersonalizado(CFG, opt);
  } catch (e) {
    return { error: e.message || String(e) };
  }
  return null;
}

function cantidadTotalDe(pack, opt) {
  if (pack.tipo === 'mixto') return (opt.cant_clasica || 0) + (opt.cant_urban || 0);
  if (pack.tipo === 'personalizado') {
    return (opt.lineas || []).reduce((s, l) => s + (l.cantidad || 0), 0);
  }
  return opt.cantidad || 0;
}

function tramoIdDeEtiqueta(etiqueta) {
  const t = CFG.tramos.find(x => x.etiqueta === etiqueta);
  return t ? t.id : '—';
}

function renderTramoBar(cantidad) {
  const bar = el('tramo-bar');
  const tip = el('tramo-tip');
  if (!bar) return;

  const total = CFG.tramos.length;
  const tramoActual = getTramo(CFG, cantidad);
  const idxActual = tramoActual ? CFG.tramos.indexOf(tramoActual) : -1;

  let html = '';
  for (let i = 0; i < total; i++) {
    const cls = (i < idxActual)
      ? 'is-active'
      : (i === idxActual ? 'is-current' : '');
    html += `<span class="tramo-bar__seg ${cls}"></span>`;
  }
  bar.innerHTML = html;

  // Tip al siguiente tramo si existe y mejora el PVP
  if (tip) {
    const siguiente = CFG.tramos[idxActual + 1];
    if (siguiente && tramoActual && estado.packId) {
      const dif = siguiente.desde - cantidad;
      tip.textContent = `Si llegas a ${siguiente.desde} unidades pasas al ${siguiente.id} (${siguiente.etiqueta.toLowerCase()}). Te faltan ${dif}.`;
      tip.style.display = 'flex';
    } else {
      tip.style.display = 'none';
    }
  }
}

// ============================================================
// Cálculo final
// ============================================================

function ejecutarCalculo() {
  hide('error-msg');
  const pack = CFG.packs[estado.packId];
  const opt = recogerInputs();

  const resultado = calcularPackTipo(pack.tipo, opt);

  if (!resultado || resultado.error) {
    el('error-msg').textContent = (resultado && resultado.error) || 'No se pudo calcular el precio.';
    show('error-msg');
    hide('seccion-resultado');
    return;
  }

  ultimoResultado = resultado;
  renderResultado(resultado);
  irAPantalla('resultado');
}

/**
 * Vuelve a la pantalla del paso 2 desde el resultado, manteniendo los
 * inputs como estaban.
 */
function volverAEditar() {
  if (!estado.packId) {
    irAPantalla('paso1');
    return;
  }
  irAPantalla('paso2');
  recalcularPreview();
}

function renderResultado(r) {
  const c = el('resultado-content');
  const cantidad = r.es_mixto ? r.cantidad_total : r.cantidad;
  const tramoId = tramoIdDeEtiqueta(r.tramo);
  const baseSinIva = r.base_venta;

  // Hero stats
  const tiempoTotal = calcularTiempoTotal(r);
  const tiempoFmt = formatearTiempo(tiempoTotal);
  const verCostes = estado.esAdmin || estado.mostrarCostes;
  const pvpPorPack = r.es_mixto
    ? fmtEur(r.subtotal / Math.max(1, r.cantidad_total))
    : fmtEur(r.pvp_unitario);
  const labelCantidad = r.es_personalizado ? 'Prendas' : 'Packs';
  const labelPvp = r.es_personalizado ? 'PVP medio' : 'PVP por pack';
  const stats = [
    { label: labelCantidad,     value: cantidad,    mono: true },
    { label: labelPvp,          value: pvpPorPack,  mono: true },
    { label: 'Tiempo estimado', value: tiempoFmt,   mono: true }
  ];
  if (verCostes) {
    stats.push({
      label: 'Margen bruto',
      value: fmtPct(r.margen_pct),
      mono: true,
      accent: r.margen_pct >= 0.30
    });
  }

  // Composición por tallas
  const totalPrendas = r.es_mixto ? cantidad : (CFG.packs[estado.packId].tipo === 'pena' ? cantidad * 2 : cantidad);
  const tallasGrandes = r.cant_4xl + r.cant_5xl;
  const tallasNormales = Math.max(0, totalPrendas - tallasGrandes);
  const pctNormales = totalPrendas > 0 ? (tallasNormales / totalPrendas * 100) : 100;
  const pct4xl = totalPrendas > 0 ? (r.cant_4xl / totalPrendas * 100) : 0;
  const pct5xl = totalPrendas > 0 ? (r.cant_5xl / totalPrendas * 100) : 0;

  const breakdownRows = construirBreakdownRows(r);
  const composicionMeta = construirComposicionMeta(r);

  c.innerHTML = `
    <div class="resultado-grid">
      <article class="dark-card result-hero">
        <div class="preview__head">
          <span class="badge badge--inverse"><svg class="icon"><use href="#i-check"/></svg> Cálculo guardado · Tramo ${tramoId}</span>
          <span class="text-mono" style="color: var(--fg-inverse-muted); font-size: 11px;">PASO 3 DE 3</span>
        </div>
        <div>
          <p style="color: var(--fg-inverse-muted); font-size: 13px;">Total a facturar</p>
          <h2 class="result-hero__total">${fmtEur(r.total_iva_inc)}</h2>
          <p class="result-hero__sub">con ${fmtPct(CFG.parametros.iva)} IVA · ${fmtEur(baseSinIva)} sin IVA</p>
        </div>
        <div class="result-hero__stats">
          ${stats.map(s => `
            <div class="stat">
              <span style="color: var(--fg-inverse-muted); font-size: 11px;">${s.label}</span>
              <strong class="${s.mono ? 'text-mono' : ''}" style="color: ${s.accent ? 'var(--success)' : 'var(--fg-inverse)'}; font-size: 20px;">${s.value}</strong>
            </div>
          `).join('')}
        </div>
      </article>

      <article class="section-card">
        <div>
          <h3 class="h-card">Próximos pasos</h3>
          <p class="text-secondary" style="font-size: 12px; margin-top: 2px;">Acciones que probablemente harás ahora.</p>
        </div>
        <div class="next-steps">
          <button class="next-steps__item" type="button" disabled title="Próximamente">
            <span class="next-steps__icon"><svg class="icon"><use href="#i-clock"/></svg></span>
            <span class="next-steps__body"><strong>Programar producción</strong><span>Estimación: ${tiempoFmt}</span></span>
            <svg class="icon"><use href="#i-arrow-right"/></svg>
          </button>
          <button class="next-steps__item" type="button" disabled title="Próximamente">
            <span class="next-steps__icon"><svg class="icon"><use href="#i-send"/></svg></span>
            <span class="next-steps__body"><strong>Enviar al cliente</strong><span>Por email o WhatsApp</span></span>
            <svg class="icon"><use href="#i-arrow-right"/></svg>
          </button>
          <button class="next-steps__item" type="button" onclick="document.getElementById('btn-cambiar-pack').click()">
            <span class="next-steps__icon"><svg class="icon"><use href="#i-plus"/></svg></span>
            <span class="next-steps__body"><strong>Nuevo cálculo</strong><span>Sin perder este resultado</span></span>
            <svg class="icon"><use href="#i-arrow-right"/></svg>
          </button>
        </div>
      </article>
    </div>

    <div class="resultado-grid" style="margin-top: 16px;">
      <article class="section-card">
        <div class="section-card__head">
          <h3 class="h-card">Desglose por concepto</h3>
          <span class="text-muted" style="font-size: 12px;">${breakdownRows.length} concepto${breakdownRows.length === 1 ? '' : 's'}</span>
        </div>
        <table class="breakdown">
          <thead>
            <tr>
              <th>Concepto</th>
              <th class="num">Ud. (€)</th>
              <th class="num">Cant.</th>
              <th class="num">Subtotal</th>
            </tr>
          </thead>
          <tbody>
            ${breakdownRows.map(row => `
              <tr class="${row.cls || ''}">
                <td class="concept">
                  <strong>${escapeHTML(row.concepto)}</strong>
                  ${row.detalle ? `<span>${escapeHTML(row.detalle)}</span>` : ''}
                </td>
                <td class="num">${row.unit !== undefined ? fmtEur(row.unit) : '—'}</td>
                <td class="num">${row.qty !== undefined ? row.qty : '—'}</td>
                <td class="num">${fmtEur(row.subtotal)}</td>
              </tr>
            `).join('')}
            <tr class="subtotal">
              <td colspan="3">Subtotal sin IVA</td>
              <td class="num">${fmtEur(baseSinIva)}</td>
            </tr>
            <tr>
              <td colspan="3">IVA (${fmtPct(CFG.parametros.iva)})</td>
              <td class="num">${fmtEur(r.iva)}</td>
            </tr>
            <tr class="total">
              <td colspan="3">TOTAL A FACTURAR</td>
              <td class="num">${fmtEur(r.total_iva_inc)}</td>
            </tr>
          </tbody>
        </table>
      </article>

      <article class="section-card">
        <div>
          <h3 class="h-card">Composición del pedido</h3>
          <p class="text-secondary" style="font-size: 12px; margin-top: 2px;">Distribución por talla · ${totalPrendas} prendas</p>
        </div>
        <div>
          <div class="composition__bar">
            <span class="composition__seg" style="width: ${pctNormales.toFixed(1)}%; background: var(--accent-primary);"></span>
            <span class="composition__seg" style="width: ${pct4xl.toFixed(1)}%; background: var(--warning);"></span>
            <span class="composition__seg" style="width: ${pct5xl.toFixed(1)}%; background: var(--danger);"></span>
          </div>
          <div class="composition__legend">
            <span><i style="background: var(--accent-primary);"></i>S–3XL · ${tallasNormales}</span>
            <span><i style="background: var(--warning);"></i>4XL · ${r.cant_4xl}</span>
            <span><i style="background: var(--danger);"></i>5XL+ · ${r.cant_5xl}</span>
          </div>
        </div>
        <hr class="divider">
        <div class="kv-list">
          ${composicionMeta.map(m => `<div class="kv-list__row"><span>${escapeHTML(m.label)}</span><span>${escapeHTML(m.value)}</span></div>`).join('')}
        </div>
        ${verCostes ? `
          <hr class="divider">
          <div>
            <h4 class="h-card" style="font-size: 13px; margin-bottom: 8px;">Datos internos${estado.esAdmin ? ' (admin)' : ''}</h4>
            <div class="kv-list">
              <div class="kv-list__row"><span>Coste total</span><span class="text-mono">${fmtEur(r.coste_total)}</span></div>
              <div class="kv-list__row"><span>Margen €</span><span class="text-mono">${fmtEur(r.margen)}</span></div>
              <div class="kv-list__row"><span>Margen %</span><span class="text-mono" style="color: ${r.margen_pct >= 0.30 ? 'var(--success)' : 'var(--warning)'};">${fmtPct(r.margen_pct)}</span></div>
              ${r.coste_unitario !== undefined ? `<div class="kv-list__row"><span>Coste unitario</span><span class="text-mono">${fmtEur(r.coste_unitario)}</span></div>` : ''}
            </div>
          </div>
        ` : ''}
      </article>
    </div>
  `;
}

function construirBreakdownRows(r) {
  const rows = [];
  if (r.es_mixto) {
    for (const d of r.desglose) {
      if (d.cantidad === 0) continue;
      // En personalizado cada línea trae sus propias caras; en mixto
      // clásico todas comparten r.caras.
      const caras = d.caras ?? r.caras;
      rows.push({
        concepto: `${d.nombre}`,
        detalle: `${d.modelo} · ${caras} cara${caras > 1 ? 's' : ''} · modelo Roly`,
        unit: d.pvp,
        qty: d.cantidad,
        subtotal: d.subtotal
      });
    }
  } else {
    const pack = CFG.packs[estado.packId];
    const detalle = pack.tipo === 'pena'
      ? `Camiseta + sudadera por persona · ${r.extra?.caras ?? 2} cara(s)`
      : `${r.extra?.caras ?? 2} cara(s) de impresión`;
    rows.push({
      concepto: r.pack,
      detalle,
      unit: r.pvp_unitario,
      qty: r.cantidad,
      subtotal: r.subtotal
    });
  }
  if (r.recargos > 0) {
    const partes = [];
    if (r.cant_4xl > 0) partes.push(`${r.cant_4xl} × 4XL`);
    if (r.cant_5xl > 0) partes.push(`${r.cant_5xl} × 5XL+`);
    rows.push({
      cls: 'surcharge',
      concepto: 'Recargo tallas grandes',
      detalle: partes.join(' · ') + ' · facturado al cliente',
      subtotal: r.recargos
    });
  }
  if (r.extras_sin_iva > 0) {
    const e = r.extras_detalle || {};
    const iva = CFG.parametros.iva || 0;
    const items = [
      { k: 'nombres',       label: 'Nombre',        unit: CFG.parametros.extra_nombre_eur,      uniLabel: 'ud'    },
      { k: 'mangas_cortas', label: 'Manga corta',   unit: CFG.parametros.extra_manga_corta_eur, uniLabel: 'manga' },
      { k: 'mangas_largas', label: 'Manga larga',   unit: CFG.parametros.extra_manga_larga_eur, uniLabel: 'manga' }
    ];
    for (const it of items) {
      const cant = e[it.k] || 0;
      if (cant === 0) continue;
      const unitInc = (it.unit || 0) * (1 + iva);
      rows.push({
        concepto: it.label,
        detalle: `${fmtEur(it.unit || 0)}/${it.uniLabel} sin IVA · extra opcional`,
        unit: unitInc,
        qty: cant,
        subtotal: cant * unitInc
      });
    }
  }
  return rows;
}

function construirComposicionMeta(r) {
  const pack = CFG.packs[estado.packId];
  const meta = [
    { label: 'Pack', value: r.pack }
  ];
  if (pack.tipo === 'pena') {
    const cap = r.extra?.capucha === 'con_capucha' ? 'URBAN (con capucha)' : 'CLASICA (sin capucha)';
    meta.push({ label: 'Modelo sudadera', value: cap });
    meta.push({ label: 'Caras impresión', value: `${r.extra?.caras ?? 2} cara${(r.extra?.caras ?? 2) > 1 ? 's' : ''}` });
  } else if (pack.tipo === 'individual') {
    const m = CFG.modelos_roly[pack.modelo];
    meta.push({ label: 'Modelo', value: `${m.nombre} (${pack.modelo})` });
    meta.push({ label: 'Caras impresión', value: `${r.extra?.caras ?? 2} cara${(r.extra?.caras ?? 2) > 1 ? 's' : ''}` });
  } else if (pack.tipo === 'mixto') {
    meta.push({ label: 'CLASICA / URBAN', value: `${r.desglose[0].cantidad} / ${r.desglose[1].cantidad}` });
    meta.push({ label: 'Caras impresión', value: `${r.caras} cara${r.caras > 1 ? 's' : ''}` });
  } else if (pack.tipo === 'personalizado') {
    const lineasResumen = r.desglose
      .filter(d => d.cantidad > 0)
      .map(d => `${d.cantidad} × ${d.modelo} (${d.caras}c)`)
      .join(' · ');
    meta.push({ label: 'Líneas', value: lineasResumen || '—' });
    meta.push({ label: 'Total prendas', value: String(r.cantidad_total) });
  }
  meta.push({ label: 'Tallas con recargo', value: `${r.cant_4xl + r.cant_5xl} (${r.cant_4xl} × 4XL · ${r.cant_5xl} × 5XL+)` });
  meta.push({ label: 'Tramo aplicado', value: r.tramo });
  return meta;
}

function calcularTiempoTotal(r) {
  // Reconstruimos el tiempo a partir de minutos base × cantidad × tramo.
  // No es exacto al cálculo interno pero da una estimación útil al usuario.
  const p = CFG.parametros;
  const tramo = CFG.tramos.find(t => t.etiqueta === r.tramo);
  const reduc = tramo ? tramo.reduccion_tiempo : 0;

  // En personalizado cada línea puede tener caras distintas.
  if (r.es_personalizado) {
    let total = 0;
    for (const d of r.desglose || []) {
      const base = d.caras === 2 ? p.minutos_2caras_base : p.minutos_1cara_base;
      total += d.cantidad * base * (1 - reduc);
    }
    return total;
  }

  const cantidad = r.es_mixto ? r.cantidad_total : r.cantidad;
  // Para pena son dos prendas por pack
  const pack = CFG.packs[estado.packId];
  const prendas = pack && pack.tipo === 'pena' ? cantidad * 2 : cantidad;
  const caras = r.es_mixto ? r.caras : (r.extra?.caras ?? 2);
  const base = caras === 2 ? p.minutos_2caras_base : p.minutos_1cara_base;
  return prendas * base * (1 - reduc);
}

function formatearTiempo(minutos) {
  if (!minutos || isNaN(minutos)) return '—';
  const h = Math.floor(minutos / 60);
  const m = Math.round(minutos % 60);
  if (h <= 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function copiarResumen() {
  const r = ultimoResultado;
  if (!r) return;
  const cantidad = r.es_mixto ? r.cantidad_total : r.cantidad;
  const lineas = [
    `${r.pack} · ${r.tramo}`,
    `Cantidad: ${cantidad}`,
    `Total IVA inc.: ${fmtEur(r.total_iva_inc)}`,
    `Base sin IVA: ${fmtEur(r.base_venta)}`,
    `IVA (${fmtPct(CFG.parametros.iva)}): ${fmtEur(r.iva)}`
  ];
  if (r.recargos > 0) {
    lineas.push(`Recargo tallas grandes: ${fmtEur(r.recargos)} (${r.cant_4xl} × 4XL · ${r.cant_5xl} × 5XL+)`);
  }
  if (r.extras_sin_iva > 0) {
    const e = r.extras_detalle || {};
    const partes = [];
    if (e.nombres)        partes.push(`${e.nombres} nombre${e.nombres > 1 ? 's' : ''}`);
    if (e.mangas_cortas)  partes.push(`${e.mangas_cortas} manga${e.mangas_cortas > 1 ? 's' : ''} corta${e.mangas_cortas > 1 ? 's' : ''}`);
    if (e.mangas_largas)  partes.push(`${e.mangas_largas} manga${e.mangas_largas > 1 ? 's' : ''} larga${e.mangas_largas > 1 ? 's' : ''}`);
    lineas.push(`Extras opcionales (sin IVA): ${fmtEur(r.extras_sin_iva)} (${partes.join(' · ')})`);
  }
  navigator.clipboard.writeText(lineas.join('\n')).catch(() => {});
}

function escapeHTML(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function resetear() {
  if (estado.packId) renderInputsPack(estado.packId);
  el('cant_4xl').value = '0';
  el('cant_5xl').value = '0';
  el('cant_nombres').value = '0';
  el('cant_mangas_cortas').value = '0';
  el('cant_mangas_largas').value = '0';
  hide('error-msg');
  recalcularPreview();
}

function volverASeleccion() {
  estado.packId = null;
  hide('error-msg');
  document.querySelectorAll('.pack-card').forEach(card => card.classList.remove('is-selected'));
  irAPantalla('paso1');
}

// ============================================================
// Recargar config desde NAS
// ============================================================

async function recargarConfig() {
  if (estado.esAdmin) {
    const ok = confirm('Tienes el modo admin abierto con cambios sin guardar. ¿Recargar de todos modos? Se perderán tus cambios.');
    if (!ok) return;
    cerrarAdmin();
  }
  await cargarConfigYMostrarApp();
}

// ============================================================
// Modo administrador
// ============================================================

async function abrirAdmin() {
  show('admin-overlay');
  if (estado.esAdmin) {
    await mostrarEditorAdmin();
  } else {
    show('admin-login');
    hide('admin-editor');
    setTimeout(() => el('admin-clave').focus(), 100);
  }
}

function cerrarAdmin() {
  hide('admin-overlay');
  hide('admin-login-error');
  el('admin-clave').value = '';
}

async function loginAdmin() {
  const clave = el('admin-clave').value;
  // La clave admin no viaja al renderer: la verificación ocurre en main
  // (timing-safe). Así DevTools no puede leer la clave del CFG cargado.
  const r = await window.packprice.verificarAdmin({
    ruta: SETTINGS.ruta_config,
    clave
  });
  if (r && r.ok && r.valida) {
    estado.esAdmin = true;
    el('btn-admin-toggle').innerHTML = '<svg class="icon"><use href="#i-lock"/></svg> Admin activo';
    el('btn-admin-toggle').classList.remove('btn-secondary');
    el('btn-admin-toggle').classList.add('btn-primary');
    hide('admin-login-error');
    el('admin-clave').value = '';
    await mostrarEditorAdmin();
  } else {
    show('admin-login-error');
  }
}

async function mostrarEditorAdmin() {
  hide('admin-login');
  show('admin-editor');

  CFG_BACKUP = deepClone(CFG);
  infoConfigAlAbrirAdmin = await window.packprice.infoConfig(SETTINGS.ruta_config);
  actualizarFooterAdmin();

  mostrarAdminTab(estado.adminTab);
}

function actualizarFooterAdmin() {
  const info = el('admin-foot-info');
  if (!info) return;
  const fecha = CFG.fecha_actualizacion || '—';
  const por = CFG.modificado_por || '—';
  info.textContent = `Última escritura: ${fecha} · por ${por}`;
}

function mostrarAdminTab(tab, opts = {}) {
  estado.adminTab = tab;
  document.querySelectorAll('.admin-nav__item').forEach(t => {
    t.classList.toggle('is-active', t.dataset.tab === tab);
  });
  document.querySelectorAll('.admin-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });

  const meta = ADMIN_TAB_META[tab];
  if (meta) {
    const titulo = el('admin-form-title');
    const desc = el('admin-form-desc');
    if (titulo) titulo.textContent = meta.titulo;
    if (desc) desc.textContent = meta.desc;
  }

  // Preservar scroll al re-renderizar tras una acción (añadir/eliminar
  // fila): si no, el contenedor del modal salta arriba en cada cambio.
  const scroller = document.querySelector('.modal__body');
  const scrollPrev = (opts.preserveScroll && scroller) ? scroller.scrollTop : null;

  const cont = el('admin-tab-content');

  // Auditoría: contenido async, lo cargamos por IPC.
  if (tab === 'auditoria') {
    cont.innerHTML = '<p class="hint">Cargando auditoría…</p>';
    window.packprice.listAuditEntries({ ruta: SETTINGS.ruta_config, limit: 200 })
      .then((r) => {
        cont.innerHTML = (r && r.ok)
          ? renderAuditTab(r.entries || [])
          : `<div class="alert alert-error"><svg class="icon"><use href="#i-warn"/></svg><span>No se pudo leer audit.log: ${escAttr(r && r.error)}</span></div>`;
      })
      .catch((err) => {
        cont.innerHTML = `<div class="alert alert-error"><svg class="icon"><use href="#i-warn"/></svg><span>${escAttr(err.message)}</span></div>`;
      });
    if (scrollPrev !== null && scroller) scroller.scrollTop = scrollPrev;
    return;
  }

  cont.innerHTML = renderAdminTabContent(CFG, tab);

  cont.querySelectorAll('input[data-cfg-path]').forEach(input => {
    input.addEventListener('change', () => actualizarConfigDesdeInput(CFG, input));
  });

  // Acciones de fila (añadir/eliminar tramo o modelo). Tras la mutación
  // re-renderizamos manteniendo la pestaña y el scroll.
  cont.querySelectorAll('[data-accion]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const result = ejecutarAccionAdmin(CFG, btn.dataset);
      if (result && result.error) {
        await window.packprice.mostrarError({
          titulo: 'Acción no permitida',
          mensaje: result.error
        });
        return;
      }
      if (result && result.dirty) {
        mostrarAdminTab(tab, { preserveScroll: true });
      }
    });
  });

  if (scrollPrev !== null && scroller) {
    scroller.scrollTop = scrollPrev;
  }
}

// Pequeño escape sólo para inyectar mensajes de error en el HTML
// asíncrono. No depende de format.js para no introducir importaciones
// circulares en una función defensiva.
function escAttr(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function guardarConfigEnNAS() {
  CFG.fecha_actualizacion = new Date().toLocaleString('es-ES');
  CFG.modificado_por = SETTINGS.nombre_usuario;

  const datos = {
    ruta: SETTINGS.ruta_config,
    configNuevo: CFG,
    infoEsperada: infoConfigAlAbrirAdmin
  };

  // Diff preview: muestra al admin exactamente qué va a cambiar antes
  // de escribir. Si no hay cambios reales, avisa y aborta.
  const confirmado = await mostrarDiffPreview(datos);
  if (!confirmado) return;

  const r = await window.packprice.guardarConfig(datos);

  if (r.ok) {
    infoConfigAlAbrirAdmin = r.info;
    CFG_BACKUP = deepClone(CFG);
    await window.packprice.mostrarInfo({
      titulo: 'Guardado',
      mensaje: 'Cambios guardados correctamente en el NAS',
      detalle: r.backupPath ? `Backup creado en:\n${r.backupPath}` : ''
    });
    inicializarApp();
    actualizarFooterAdmin();
    return;
  }

  if (r.conflicto) {
    await resolverConflictoAdmin(r);
    return;
  }

  await window.packprice.mostrarError({
    titulo: 'Error al guardar',
    mensaje: 'No se pudo guardar el archivo',
    detalle: r.error || 'Error desconocido'
  });
}

async function resolverConflictoAdmin(respuestaConflicto) {
  const respuesta = await window.packprice.confirmarConflicto({
    modificadoPor: respuestaConflicto.modificadoPor,
    fechaActualizacion: respuestaConflicto.fechaActualizacion
  });

  if (respuesta === 0) {
    const r2 = await window.packprice.guardarConfigForzado({
      ruta: SETTINGS.ruta_config,
      configNuevo: CFG
    });
    if (r2.ok) {
      infoConfigAlAbrirAdmin = r2.info;
      CFG_BACKUP = deepClone(CFG);
      await window.packprice.mostrarInfo({
        titulo: 'Guardado (forzado)',
        mensaje: 'Cambios guardados sobrescribiendo la versión del compañero.'
      });
      inicializarApp();
    } else {
      await window.packprice.mostrarError({
        titulo: 'Error',
        mensaje: 'No se pudo guardar',
        detalle: r2.error
      });
    }
  } else if (respuesta === 1) {
    cerrarAdmin();
    estado.esAdmin = false;
    el('btn-admin-toggle').innerHTML = '<svg class="icon"><use href="#i-lock"/></svg> Admin';
    el('btn-admin-toggle').classList.remove('btn-primary');
    el('btn-admin-toggle').classList.add('btn-secondary');
    await cargarConfigYMostrarApp();
  }
}

function cancelarCambiosAdmin() {
  if (CFG_BACKUP) {
    CFG = deepClone(CFG_BACKUP);
    mostrarAdminTab(estado.adminTab);
    inicializarApp();
  }
}

// ============================================================
// Diff preview modal (call before writing the config)
// ============================================================
//
// Resolves to `true` when the user confirms, `false` when they
// cancel or there are no changes. Always reuses the same overlay
// element; the actual buttons are wired here for each call so the
// promise resolves cleanly.
async function mostrarDiffPreview(datos) {
  let preview;
  try {
    preview = await window.packprice.previewConfigDiff({
      ruta: datos.ruta,
      configNuevo: datos.configNuevo
    });
  } catch (err) {
    await window.packprice.mostrarError({
      titulo: 'No se pudo generar la previsualización',
      mensaje: err.message || 'Error desconocido'
    });
    return false;
  }

  if (!preview || !preview.ok) {
    await window.packprice.mostrarError({
      titulo: 'No se pudo generar la previsualización',
      mensaje: (preview && preview.error) || 'Error desconocido'
    });
    return false;
  }

  const cambios = preview.cambios || [];
  if (cambios.length === 0) {
    await window.packprice.mostrarInfo({
      titulo: 'Sin cambios',
      mensaje: 'No hay nada que guardar: el config actual ya coincide con el del NAS.'
    });
    return false;
  }

  el('diff-body').innerHTML = renderDiffPreview(cambios);
  show('diff-overlay');

  return new Promise((resolve) => {
    const cleanup = () => {
      hide('diff-overlay');
      btnConfirm.removeEventListener('click', onConfirm);
      btnCancel.removeEventListener('click', onCancel);
      btnClose.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlayClick);
      document.removeEventListener('keydown', onKey);
    };
    const onConfirm = () => { cleanup(); resolve(true); };
    const onCancel  = () => { cleanup(); resolve(false); };
    const onOverlayClick = (e) => { if (e.target.id === 'diff-overlay') onCancel(); };
    const onKey = (e) => { if (e.key === 'Escape') onCancel(); };

    const btnConfirm = el('btn-diff-confirmar');
    const btnCancel  = el('btn-diff-cancelar');
    const btnClose   = el('btn-cerrar-diff');
    const overlay    = el('diff-overlay');

    btnConfirm.addEventListener('click', onConfirm);
    btnCancel.addEventListener('click', onCancel);
    btnClose.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKey);
  });
}

// ============================================================
// Logs viewer modal
// ============================================================
async function abrirLogs() {
  el('logs-body').innerHTML = '<p class="hint">Cargando…</p>';
  show('logs-overlay');
  try {
    const r = await window.packprice.readLogs(200);
    if (r && r.ok) {
      el('logs-body').innerHTML = renderLogsModal({ path: r.path, lines: r.lines });
    } else {
      el('logs-body').innerHTML = `<div class="alert alert-error"><svg class="icon"><use href="#i-warn"/></svg><span>No se pudo leer el log: ${escAttr(r && r.error)}</span></div>`;
    }
  } catch (err) {
    el('logs-body').innerHTML = `<div class="alert alert-error"><svg class="icon"><use href="#i-warn"/></svg><span>${escAttr(err.message)}</span></div>`;
  }
}

function cerrarLogs() {
  hide('logs-overlay');
}

// ============================================================
// Quote history modal
// ============================================================
async function abrirHistorial() {
  show('history-overlay');
  const search = el('history-search');
  if (search) search.value = '';
  await refrescarHistorial();
}

function cerrarHistorial() {
  hide('history-overlay');
}

async function refrescarHistorial() {
  const body = el('history-body');
  const search = el('history-search');
  const query = search ? search.value : '';
  body.innerHTML = '<p class="hint">Cargando…</p>';
  try {
    const r = query
      ? await window.packprice.searchQuotes(query)
      : await window.packprice.listQuotes();
    if (!r || !r.ok) {
      body.innerHTML = `<div class="alert alert-error"><svg class="icon"><use href="#i-warn"/></svg><span>${escAttr(r && r.error)}</span></div>`;
      return;
    }
    body.innerHTML = renderHistoryList(r.quotes || []);
    el('history-foot-info').textContent = `${(r.quotes || []).length} presupuesto${(r.quotes || []).length === 1 ? '' : 's'}`;

    body.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => onHistoryAction(btn.dataset.action, btn.dataset.id));
    });
  } catch (err) {
    body.innerHTML = `<div class="alert alert-error"><svg class="icon"><use href="#i-warn"/></svg><span>${escAttr(err.message)}</span></div>`;
  }
}

async function onHistoryAction(action, id) {
  if (action === 'delete') {
    const ok = await window.packprice.confirmar({
      titulo: 'Eliminar presupuesto',
      mensaje: `¿Eliminar el presupuesto ${id}?`,
      detalle: 'Esta acción no se puede deshacer.',
      botones: ['Eliminar', 'Cancelar'],
      defaultId: 1
    });
    if (ok !== 0) return;
    await window.packprice.deleteQuote(id);
    await refrescarHistorial();
    return;
  }
  if (action === 'open') {
    const r = await window.packprice.getQuote(id);
    if (!r || !r.ok || !r.quote) return;
    ultimoResultado = r.quote.resultado || r.quote;
    cerrarHistorial();
    if (typeof renderResultado === 'function') {
      try { renderResultado(ultimoResultado); } catch (_) {}
    }
    await window.packprice.mostrarInfo({
      titulo: 'Presupuesto cargado',
      mensaje: `Presupuesto ${id} reabierto en pantalla.`
    });
    return;
  }
  if (action === 'pdf') {
    const r = await window.packprice.getQuote(id);
    if (!r || !r.ok || !r.quote) return;
    const out = await window.packprice.exportPdf({
      quote: r.quote,
      empresa: CFG && CFG.empresa,
      presupuesto: CFG && CFG.presupuesto,
      defaultName: `${r.quote.id}.pdf`
    });
    if (out && out.cancelado) return;
    if (!out || !out.ok) {
      await window.packprice.mostrarError({
        titulo: 'Error al exportar',
        mensaje: (out && out.error) || 'Error desconocido'
      });
      return;
    }
    await window.packprice.mostrarInfo({
      titulo: 'PDF exportado',
      mensaje: `Guardado en:\n${out.ruta}`
    });
  }
}

async function guardarPresupuesto() {
  if (!ultimoResultado) {
    await window.packprice.mostrarError({
      titulo: 'Nada que guardar',
      mensaje: 'Calcula un presupuesto antes de guardarlo.'
    });
    return;
  }
  const draft = buildQuoteDraft(ultimoResultado, {
    usuario: SETTINGS.nombre_usuario,
    configVersion: CFG && CFG.version,
    packId: estado.packId
  });
  const r = await window.packprice.saveQuote(draft);
  if (!r || !r.ok) {
    await window.packprice.mostrarError({
      titulo: 'No se pudo guardar',
      mensaje: (r && r.error) || 'Error desconocido'
    });
    return;
  }
  await window.packprice.mostrarInfo({
    titulo: 'Presupuesto guardado',
    mensaje: `Asignado el ID ${r.quote.id}.`,
    detalle: 'Disponible en el botón “Historial” del menú superior.'
  });
}

async function exportarPresupuestoPdf() {
  if (!ultimoResultado) {
    await window.packprice.mostrarError({
      titulo: 'Nada que exportar',
      mensaje: 'Calcula un presupuesto antes de exportarlo.'
    });
    return;
  }

  // The PDF needs a quote object with id + fecha. If the user hasn't
  // saved it yet, persist it now so the PDF and the history are
  // consistent (same id printed on the document and stored locally).
  let quote;
  if (ultimoResultado.id && ultimoResultado.fecha) {
    quote = ultimoResultado;
  } else {
    const draft = buildQuoteDraft(ultimoResultado, {
      usuario: SETTINGS.nombre_usuario,
      configVersion: CFG && CFG.version,
      packId: estado.packId
    });
    const r = await window.packprice.saveQuote(draft);
    if (!r || !r.ok) {
      await window.packprice.mostrarError({
        titulo: 'No se pudo preparar el PDF',
        mensaje: (r && r.error) || 'Error al guardar el presupuesto previo a exportar.'
      });
      return;
    }
    quote = r.quote;
    // Replace ultimoResultado so subsequent clicks reuse the saved id.
    ultimoResultado = quote;
  }

  const r = await window.packprice.exportPdf({
    quote,
    empresa: CFG && CFG.empresa,
    presupuesto: CFG && CFG.presupuesto,
    defaultName: `${quote.id}.pdf`
  });
  if (r && r.cancelado) return;
  if (!r || !r.ok) {
    await window.packprice.mostrarError({
      titulo: 'Error al exportar',
      mensaje: (r && r.error) || 'Error desconocido'
    });
    return;
  }
  await window.packprice.mostrarInfo({
    titulo: 'PDF exportado',
    mensaje: `Guardado en:\n${r.ruta}`
  });
}

// ============================================================
// Modal Ajustes locales
// ============================================================

function abrirAjustes() {
  el('aj-nombre').value = SETTINGS.nombre_usuario || '';
  el('aj-ruta').value = SETTINGS.ruta_config || '';
  // Toggles: persistencia local en localStorage como placeholder hasta
  // tener el campo oficial en settings.json (ver PLAN_UI §9).
  const recordar = localStorage.getItem('pp:recordar-pack') === '1';
  const mostrarIva = localStorage.getItem('pp:mostrar-iva') !== '0'; // por defecto sí
  const tRec = el('aj-recordar-pack');
  const tIva = el('aj-mostrar-iva');
  if (tRec) tRec.checked = recordar;
  if (tIva) tIva.checked = mostrarIva;
  show('ajustes-overlay');
}

function cerrarAjustes() {
  hide('ajustes-overlay');
}

async function guardarAjustes() {
  const nombre = el('aj-nombre').value.trim();
  const ruta = el('aj-ruta').value.trim();

  if (!nombre || !ruta) {
    await window.packprice.mostrarError({
      titulo: 'Datos incompletos',
      mensaje: 'Indica nombre y ruta del config'
    });
    return;
  }

  if (ruta !== SETTINGS.ruta_config) {
    const r = await window.packprice.leerConfig(ruta);
    if (!r.ok) {
      await window.packprice.mostrarError({
        titulo: 'No se puede leer el archivo',
        mensaje: r.error
      });
      return;
    }
  }

  // Toggles -> localStorage
  localStorage.setItem('pp:recordar-pack', el('aj-recordar-pack').checked ? '1' : '0');
  localStorage.setItem('pp:mostrar-iva',  el('aj-mostrar-iva').checked ? '1' : '0');

  SETTINGS = { nombre_usuario: nombre, ruta_config: ruta };
  await window.packprice.guardarSettings(SETTINGS);
  cerrarAjustes();
  await cargarConfigYMostrarApp();
}

// ============================================================
// Bootstrap
// ============================================================

document.addEventListener('DOMContentLoaded', arrancar);
