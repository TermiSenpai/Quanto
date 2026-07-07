# Planes de evolución de Quanto

Tres planes organizados por nivel de fricción contra los principios de CLAUDE.md.

| Tier | Archivo | Qué es | Cuándo |
|---|---|---|---|
| 1 | [`tier-1-profesionalidad-real.md`](tier-1-profesionalidad-real.md) | Mejoras alineadas con CLAUDE.md. Subir el listón sin romper nada. | Próximos releases |
| 2 | [`tier-2-ux-taller.md`](tier-2-ux-taller.md) | UX y robustez operativa. Asume Tier 1 hecho. | Tras Tier 1 |
| 3 | [`tier-3-debate.md`](tier-3-debate.md) | Cambios que requieren debate previo y actualización de CLAUDE.md. | Solo si hay disparador objetivo |
| Refactor | [`migracion-codigo-ingles.md`](migracion-codigo-ingles.md) | Migración por ondas de los identificadores a inglés (CLAUDE.md §3). | Transversal a Tier 1/2 |
| V4 | [`v4-configurabilidad-total.md`](v4-configurabilidad-total.md) | Catálogo 100% configurable: productos, proveedores, packs y complementos. Motor unificado, PVP recomendado, 3XL correcto. Esquema `config v4` (sobre el v3-inglés) + migración v3→v4. | Evolución mayor; cruza Tier 3 |
| V5 | [`v5-cloud-sync.md`](v5-cloud-sync.md) | Datos en local o nube a elección: Cloudflare D1 (tablas normalizadas) **en la cuenta de cada empresa**, sin servidor propio — la app habla con D1 por REST y se aprovisiona sola (estilo FactuSOL). Caché local, escrituras por entidad, auditoría, rollback, estadísticas, migraciones de esquema con backup automático. Debate en `CLAUDE.md` §9; requisitos en `docs/PRD.md`. | Aprobado 2026-06-12; tras cerrar v4 |
| V5 impl | [`v5-impl-roadmap.md`](v5-impl-roadmap.md) | **Cómo se ejecuta la v5**: 7 planes pequeños (refactor inglés → fundación → asistente/lectura → escrituras → auditoría → quotes/stats/transición → producto; plantillas PDF intercalable), dependencias, puertas de calidad y reglas de ejecución. | Ejecución; empezar por Plan 0 y Plan 1 |
| V5 plan 1 | [`v5-impl-plan-1-fundacion.md`](v5-impl-plan-1-fundacion.md) | Tareas TDD paso a paso de la fundación: `lib/d1-client.js`, `db/migrations/0001_init.sql`, loader + migrador idempotente, ensamblador bidireccional con round-trip exacto contra `config.default.js`. | Listo para ejecutar |

## Orden global recomendado

Si se ejecutase todo en serie:

1. Tier 1 #3 — Validación de esquema del config
2. Tier 1 #1 — Tests del cálculo
3. Tier 1 #2 — `electron-log`
4. Tier 1 #6 + #7 — Auditoría y diff visual admin
5. Tier 2 #4 — Atajos de teclado
6. Tier 1 #4 — Historial de presupuestos
7. Tier 1 #5 — Exportación PDF
8. Tier 2 #1 — Vista cliente
9. Tier 2 #5 — Aviso de config desactualizado
10. Tier 2 #2 — Ficha de cliente
11. Tier 2 #3, #6, #7, #8 — Resto de UX
12. Tier 3 — solo bajo demanda con disparador objetivo

Total Tier 1 + 2: ~11-12 jornadas de trabajo enfocado.
