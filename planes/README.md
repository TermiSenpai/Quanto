# Planes de evolución de PackPrice

Tres planes organizados por nivel de fricción contra los principios de CLAUDE.md.

| Tier | Archivo | Qué es | Cuándo |
|---|---|---|---|
| 1 | [`tier-1-profesionalidad-real.md`](tier-1-profesionalidad-real.md) | Mejoras alineadas con CLAUDE.md. Subir el listón sin romper nada. | Próximos releases |
| 2 | [`tier-2-ux-taller.md`](tier-2-ux-taller.md) | UX y robustez operativa. Asume Tier 1 hecho. | Tras Tier 1 |
| 3 | [`tier-3-debate.md`](tier-3-debate.md) | Cambios que requieren debate previo y actualización de CLAUDE.md. | Solo si hay disparador objetivo |

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
