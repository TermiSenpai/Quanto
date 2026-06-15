# Roadmap de implementación v5 — refactor + cloud + producto

**Fecha:** 2026-06-12 · **Especificación:** `docs/PRD.md` (R1–R20, §1b),
`planes/v5-cloud-sync.md` (fases 0–8), `docs/UI-UX.md`.

> Cómo se ejecuta la v5: **siete planes pequeños y entregables**, cada uno con
> su documento de tareas detallado (formato TDD paso a paso, ver
> `v5-impl-plan-1-fundacion.md` como modelo). Un plan no se empieza hasta que
> el anterior del que depende está mergeado y verde. Cada plan se detalla
> **justo antes** de ejecutarse — detallar hoy el plan 6 sería especular.

## Orden y dependencias

```
Plan 0 (refactor inglés, ondas 10-11)──┐
                                        ├──► Plan 2 ──► Plan 3 ──► Plan 4 ──► Plan 5
Plan 1 (fundación D1 + ensamblador) ───┘                            
Plan 6 (plantillas PDF) ── independiente; en cualquier momento tras Plan 0
```

| Plan | Contenido | Cubre (plan v5) | Depende de | Tareas detalladas en |
|---|---|---|---|---|
| **0. Refactor inglés** | Terminar ondas 10–11: `renderer/app.js` e `index.html` (70+ ids HTML, identificadores, canales legacy). **Va primero**: los planes 2–5 tocan `app.js`/`index.html` a fondo y hacerlo sobre código español duplicaría el churn | — (deuda previa) | nada (rama actual `refactor/english-migration-pr1`) | ya existe: `migracion-codigo-ingles.md` ondas 10–11 (mapa de renombrados completo) |
| **1. Fundación cloud** | `lib/d1-client.js` (REST, fetch inyectable), `db/migrations/0001_init.sql`, `lib/migration-loader.js`, `lib/db-migrator.js` (aplicar/registrar/idempotente), `lib/catalog-assembler.js` bidireccional con round-trip contra `config.default.js`. Todo módulos puros con tests — **sin tocar UI ni main** | fase 0 + fase 1 | nada (paralelo a Plan 0) | **`v5-impl-plan-1-fundacion.md` (escrito)** |
| **2. Asistente + lectura** | `lib/config-backend.js` (interfaz) + adaptador `d1` de lectura; asistente primer arranque Local/Nube (UI-UX §2.0); aprovisionamiento (buscar/crear base + aplicar migraciones con **candado + backup export + verificación**, plan v5 §6); caché atómica + banner offline + indicador (UI-UX §2.1–2.2); **suite de contrato file/d1** (R18, lecturas) | fase 2 + §6 | 0 y 1 | se escribe al cerrar Plan 1 |
| **3. Escrituras** | Lotes con guarda de versión (`UPDATE … WHERE version=?`), diff→entidades en main, retirar puerta de contraseña, confirmación con resumen, conflicto por entidad (UI-UX §2.3), contrato de escrituras file/d1 | fase 3 | 2 | al cerrar Plan 2 |
| **4. Auditoría + rollback** | `audit_log`, `snapshots`, restore auditado, vistas en el editor | fase 4 | 3 | al cerrar Plan 3 |
| **5. Presupuestos + estadísticas + transición** | Tablas quotes (nombre/teléfono/`valid_until`), outbox, estados + recordatorio, `renderer/charts.js` (SVG), pantalla Estadísticas (UI-UX §2.7); migración local↔nube («Subir/Bajar»); transición del taller (cliente nº 1) | fases 5 + 6 | 4 | al cerrar Plan 4 |
| **6. Plantillas PDF** | `lib/template-engine.js` (`{{campo}}`, `{{#each}}`, `{{#if}}`), 6 plantillas según los diseños aprobados de `MainUI.pen`, color de marca, saneador, galería con vista previa | fase 8 | 0 (toca ajustes/renderer) | cuando se decida intercalarlo |
| **7. Producto + distribución** | Archivar catálogo real → semilla demo (R16), manual de usuario, exportar diagnóstico (R17), telemetría de errores + saneador testeado (R19, §5b), toggles de actualización, release GitHub (D4 resuelta antes) | fase 7 | 5 (y 6 si se quiere estrenar con plantillas) | al cerrar Plan 5 |

## Reglas de ejecución (todas obligatorias)

1. **Una rama por plan**, PR a `main`, sin `--force` (regla dura 10).
   Las modificaciones de documentación de hoy se commitean antes de empezar
   (decisión del propietario en qué rama/PR).
2. **Puerta de cierre de cada plan:** `pnpm test` verde (200+ existentes + los
   nuevos), smoke de `CLAUDE.md` §8, criterio de aceptación de la fase
   correspondiente en `planes/v5-cloud-sync.md` §8 cumplido, docs actualizados
   si cambió una regla o esquema.
3. **TDD siempre** (regla dura 7): cada módulo nuevo nace con su test en rojo.
4. **Sin dependencias nuevas** en ningún plan — `fetch` nativo, SVG a mano,
   motor de plantillas propio. Si un plan parece necesitar una, se para y se
   reabre el debate de `CLAUDE.md`.
5. Cada plan usa `superpowers:subagent-driven-development` o
   `superpowers:executing-plans` sobre su documento de tareas.

## Riesgos de secuencia ya decididos

- **Plan 0 antes que 2–5** para no renombrar código recién escrito.
- El detalle de la **API de export de D1** (backup pre-migración) se verifica
  contra la documentación de Cloudflare al escribir el Plan 2 — el contrato
  (`§6: candado → backup → migrar → verificar → fallback`) ya está fijado.
- La **suite de contrato** file/d1 (R18) crece por planes: lecturas en el 2,
  escrituras en el 3, auditoría en el 4.
