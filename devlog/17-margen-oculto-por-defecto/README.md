# 17 — Margen bruto oculto por defecto (v5.1.1-beta)

> **Resumen ejecutivo:** el margen bruto y los "Datos internos" del paso 3 ya
> no se muestran nunca por defecto, ni siquiera con el modo admin activo. El
> único mecanismo para verlos (y volver a ocultarlos) es el atajo discreto de
> tres pulsaciones de `.`.

**Release:** `v5.1.1-beta` · **Fecha:** 2026-07-21 · **Tests:** 1143 verdes ·
**Tamaño .exe:** 75,4 MB

---

## Contexto

El atajo secreto de 3 × `.` para alternar los costes internos existe desde el
diseño del editor de catálogo (spec 2026-06-15), pero la pantalla de resultado
calculaba la visibilidad como `admin OR toggle`: con el modo admin activo, el
margen quedaba **siempre** a la vista y el atajo no podía ocultarlo. Molesto
cuando se enseña la pantalla a un cliente con la sesión de admin abierta.

## Qué se hizo

Un cambio de una línea en `renderer/app.js`: la visibilidad depende **solo**
del toggle secreto. Afecta a los dos puntos donde aparecía el dato en el
paso 3 — la stat "Margen bruto" de la tarjeta oscura y el bloque "Datos
internos" (coste total, margen € y margen %) al final de "Composición del
pedido" — que alternan juntos. Como el estado arranca oculto, cada arranque
de la app empieza sin costes a la vista.

TODO captura: paso 3 sin margen (por defecto) y con margen (tras 3 × `.`).

## Cómo funciona

El atajo ya existía y no se tocó: un listener global de teclado que acepta
`.`, `,` y el punto del teclado numérico (por la distribución española),
exige 3 pulsaciones en menos de 800 ms, ignora las hechas dentro de campos de
formulario y re-renderiza el resultado si está visible.

```mermaid
flowchart LR
  A[3 × "." en <800 ms] --> B[state.showCosts = !state.showCosts]
  B --> C{¿Paso 3 visible?}
  C -- sí --> D[Re-render del resultado]
  C -- no --> E[Se aplicará al próximo render]
```

## Caminos descartados

- **Persistir la visibilidad en `settings.json`.** Es un guard de privacidad
  frente a terceros, no una preferencia: lo seguro es arrancar siempre oculto.
  Persistirlo invitaría a dejarlo activado para siempre.
- **Mantener el override de admin y añadir un botón visible de ocultar.** Un
  botón a la vista delata que hay algo que ocultar; el valor del atajo es
  precisamente su discreción delante del cliente.
- **Toggles separados para la stat del hero y "Datos internos".** Son el mismo
  concepto (costes internos); dos estados solo añadirían confusión.

## Decisiones bloqueadas

- **Decisión:** la visibilidad de costes internos nunca se persiste y su único
  mecanismo es el atajo 3 × `.`; el modo admin no la fuerza.
  **Por qué:** privacidad frente a clientes por defecto, cero configuración.
  **Reabrir solo si:** aparece una necesidad real de roles/permisos por
  usuario.

## Métricas de la release

| Métrica | Antes | Después |
|---|---|---|
| Tests | 1143 | 1143 |
| Tamaño del `.exe` | 75,4 MB | 75,4 MB |
| Líneas cambiadas (fix) | — | 1 (+comentario) |
