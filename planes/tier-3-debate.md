# Tier 3 — Cambios que requieren debate

> Estas propuestas rompen alguna invariante de CLAUDE.md o están explícitamente listadas en §11 ("cosas que NO hacer"). **No deben implementarse sin un acuerdo previo documentado** (idealmente actualizando CLAUDE.md primero).
>
> El plan aquí es el qué/por qué/cuándo se justificarían, no el "vamos a hacerlo".

---

## 1. Backend HTTP central + base de datos

**Estado**: ya contemplado en CLAUDE.md §9.3 como "V4".

**Cuándo se justifica**:
- ≥4 usuarios activos simultáneos, o
- Necesidad de reportes cross-PC (top packs, facturación mensual cruzada), o
- Pérdida real de presupuestos por estar atados a un PC concreto.

**Plan si se aprueba**:

1. Levantar un mini-servidor en un PC siempre encendido (puede ser un Raspberry Pi 4):
   - Node + Fastify (más ligero que Express, similar API).
   - SQLite vía `better-sqlite3` (cero servicios externos).
   - Endpoints: `GET /config`, `PUT /config`, `GET/POST /presupuestos`, `GET /clientes`, `GET /audit`.
   - Auth: token compartido en `settings.json` de cada PC, no usuarios individuales (sigue siendo red local).
2. La app Electron pasa a ser cliente HTTP. `config.js` en NAS deja de ser el origen de verdad (pero se mantiene como **export/backup** semanal automático para no perder la propiedad "humano-editable").
3. Migración: script único que sube el `config.js` actual y los `presupuestos.json` locales al servidor.
4. Auto-update: GitHub Releases privado + `electron-updater`.

**Coste estimado**: 2-3 semanas + hardware (~80€ Raspberry).

**Riesgo**: el día que el Pi se cae, nadie cotiza. Mitigar con (a) export periódico a NAS, (b) modo offline degradado que use el último config en caché.

**Recomendación actual**: **no hacer**. Hoy son 2-3 usuarios, el NAS funciona, el `config.js` editable es una ventaja.

---

## 2. Auto-update con `electron-updater`

**Cuándo se justifica**:
- Releases más frecuentes que trimestrales, o
- Olvidos repetidos de actualizar PCs del taller, o
- Bug crítico que toca corregir en caliente.

**Plan si se aprueba**:

1. Firmar el `.exe` con certificado de código (autónomo / SL del taller). Coste: 200-400 €/año.
2. Subir releases a GitHub Releases privado o servidor propio (S3 / Cloudflare R2).
3. Configurar `electron-builder` con `publish` apuntando al feed.
4. En `main.js`, `autoUpdater.checkForUpdatesAndNotify()` al arrancar.
5. Política de actualización: silenciosa en background, prompt no bloqueante al usuario.

**Riesgo**:
- Una update mala bloquea los 3 PCs a la vez. Mitigar con releases en canary (1 PC) → estable.
- Sin firma, Defender bloqueará la descarga en frío.

**Recomendación actual**: **no hacer** mientras los releases sean trimestrales o menos. La fricción de copiar un `.exe` a 3 PCs es menor que el riesgo.

---

## 3. Migración a TypeScript

**Estado**: CLAUDE.md §11 lo prohíbe explícitamente "porque es mejor". Solo se justifica si:
- Hay 3+ devs simultáneos en el repo, o
- Un bug real en producción habría sido prevenido por tipos.

**Plan si se aprueba**:

1. No migrar todo de golpe. Empezar por `renderer/calculo.js` → `renderer/calculo.ts`.
2. Añadir `tsc` con `--noEmit` en CI (solo verifica, no compila).
3. Mantener `.js` con JSDoc-types en el resto. JSDoc + `// @ts-check` da el 70% del beneficio sin build step.
4. Si se decide compilar: añadir `esbuild` (la dependencia más liviana). No `webpack` ni `vite`.

**Coste**: 1 semana de migración inicial + curva de aprendizaje del equipo.

**Alternativa más barata**: JSDoc con `// @ts-check` en los archivos críticos (`calculo.js`, `main.js`). Cero build, mismo tipo de aviso.

**Recomendación actual**: **no migrar**. Implementar JSDoc + `// @ts-check` en `calculo.js` como punto medio si surge la inquietud.

---

## 4. Telemetría / analítica de uso

**Estado**: CLAUDE.md §1 dice "no telemetría". Frontalmente incompatible.

**Cuándo se justifica**:
- Decisiones de producto basadas en datos (qué packs se cotizan más, qué configs cambian).
- Pero esto se resuelve sin telemetría externa: la propia tabla de historial (Tier 1 #4) ya contiene la información.

**Plan si se aprueba (alternativa local)**:

1. Vista "Estadísticas" en la app que consulta el historial local:
   - Packs más cotizados (últimos 90 días)
   - Cliente con más presupuestos
   - Media de tamaño de pedido
2. Nada sale del PC. Punto.

**Recomendación actual**: hacer la vista de estadísticas local en lugar de telemetría real. Cumple el objetivo sin romper la invariante.

---

## 5. Firma de código del `.exe`

**Cuándo se justifica**:
- Distribución fuera del taller (otros talleres, marketplace, web pública).
- Quejas reales de Defender / SmartScreen.

**Plan si se aprueba**:

1. Obtener certificado EV Code Signing (caro: 300-500 €/año) o OV (~200 €/año, pide más build-up de reputación).
2. Configurar `electron-builder` con `signingHashAlgorithms`, `certificateFile`, `certificatePassword` desde env vars.
3. Documentar en `README-build.md` el proceso de release firmado.

**Recomendación actual**: **no hacer** mientras la distribución sea interna. Si se decide vender o ceder la app, sí.

---

## 6. Internacionalización

**Estado**: hoy todo en español, hard-coded. CLAUDE.md §9.4 lo difiere hasta que haga falta.

**Cuándo se justifica**:
- Venta a un cliente no hispanohablante.
- No antes.

**Plan si se aprueba**:

1. Extraer strings a `renderer/i18n/es.json` y `renderer/i18n/<lang>.json`.
2. Función `T(clave, params)` con lookup simple. **No usar `i18next`** para 50-200 strings.
3. Detección automática vía `app.getLocale()` con fallback a `es`.
4. Selector manual en config.

**Recomendación actual**: **no hacer** hasta que exista un cliente no español confirmado.

---

## 7. Migración a framework UI (React / Vue / Svelte)

**Estado**: CLAUDE.md §11 lo prohíbe sin debate previo.

**Cuándo se justificaría**:
- La UI crece a >10 pantallas con estado compartido complejo.
- 2+ devs frontend simultáneos que pelean con vanilla.
- Necesidad de componentes ricos (drag-and-drop, virtual scrolling, gráficos interactivos).

**Plan si se aprueba** (orden de menos a más disrupción):

1. Antes de framework: extraer componentes en módulos JS con `customElements` (Web Components nativos). Cero dependencias.
2. Si aún no basta: **Preact** (no React) sin JSX, vía `htm` template strings. ~10 KB, sin build step.
3. Solo si lo anterior no llega: React + esbuild. Reescribir es un mes mínimo.

**Recomendación actual**: **no hacer**. La UI actual es de 5-6 pantallas; vanilla es claramente suficiente. Si crece, ir paso a paso desde Web Components.

---

## 8. Sistema de licencias / activación

**Cuándo se justifica**: distribución comercial fuera del taller.

**Plan si se aprueba**:

1. Servidor mínimo de licencias (Cloudflare Workers + KV, ~0 €/mes a pequeña escala).
2. Activación por clave en primer arranque, validación periódica online con caché offline 30 días.
3. Telemetría mínima asociada (qué versión está activa, último ping).

**Riesgo**: añade dependencia de internet, complejidad significativa, soporte de usuarios bloqueados.

**Recomendación actual**: **no hacer** salvo decisión comercial explícita.

---

## Marco para decidir un Tier 3

Antes de aprobar cualquiera de los anteriores, exigir:

1. **Disparador objetivo**: número, evento, cliente concreto que justifique. No "sería más profesional".
2. **Coste estimado**: jornadas + €/año si hay servicios externos.
3. **Plan de rollback**: cómo se desmonta si no funciona.
4. **Actualización previa de CLAUDE.md**: para que la decisión quede documentada.

Si la propuesta no aguanta esas cuatro preguntas, se queda en este archivo.
