# Quanto

> **Idioma**: Español · [English](README.md)

Calculadora de escritorio para presupuestar **packs de personalización textil DTF** (Direct-to-Film). Cada PC ejecuta una app instalada (instalador por-usuario); el catálogo compartido vive en un único `config.js` en el NAS **o** en **Cloudflare D1 dentro de la propia cuenta del cliente** — ambos intercambiables en cualquier momento, **sin ningún backend del desarrollador** por medio.

> Estado actual: **beta** (`5.0.0-beta`). En uso interno; el cloud-sync v5 (almacenamiento opcional en Cloudflare D1, en la cuenta del propio cliente) está en curso. Aún sin marcar V1.

---

## Qué hace

- Calcula PVP, coste, margen e IVA para las modalidades de pack del taller (peña, solo camisetas, sudaderas con/sin capucha, mixto) — todo el catálogo es configurable por el usuario (esquema v4).
- Aplica tramos de volumen (T1–T4) con descuento por cantidad y reducción de tiempo de mano de obra.
- Soporta recargos directos al cliente por tallas grandes (4XL, 5XL+) y un buffer interno para 3XL.
- Editor de catálogo (productos, proveedores, extras, packs, precios, márgenes, textos del presupuesto) — todo editable desde la app, sin tocar código. La contraseña de administrador se eliminó en v5; los errores se protegen con confirmación al guardar, autor por escritura en la auditoría y vuelta atrás por snapshots.
- Detección de conflictos cuando dos personas editan a la vez (modo local: `mtime + sha256`; modo nube: versión por entidad), con backup/snapshot automático antes de cada escritura.
- Primer arranque guiado: pide nombre del usuario y ruta del config en el NAS, los persiste en `%APPDATA%\Quanto\settings.json`, y ofrece sembrar el `config.js` con valores por defecto si no existe.

---

## Stack y filosofía

| Pieza                   | Decisión                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------ |
| Runtime                 | Electron + Node.js (main) + Chromium (renderer)                                      |
| UI                      | HTML + CSS + JS vanilla (sin framework, sin build step)                              |
| Persistencia compartida | `config.js` en PC/NAS (se escanea su bloque JSON + `JSON.parse` + validación de esquema — sin `eval`/`vm`) **o** Cloudflare D1 en la cuenta del propio cliente (REST desde main, sin servidor) |
| Persistencia local      | `settings.json` en `%APPDATA%\Quanto\`                                            |
| Tests                   | Vitest sobre la lógica de cálculo y el parser de config                              |
| Empaquetado             | `electron-builder` instalador NSIS por-usuario, Windows x64                          |
| Idioma                  | Español (dominio, comentarios, UI)                                                   |

Cero dependencias en runtime. Sólo `electron`, `electron-builder` y `vitest` como `devDependencies`. Las restricciones, principios de diseño e invariantes de seguridad están en [CLAUDE.md](CLAUDE.md).

---

## Estructura

```
packs app/
├── PLAN_Calculadora.md     ← plan funcional y fórmulas (fuente de verdad de negocio)
├── CLAUDE.md               ← guía de trabajo y convenciones
├── README-build.md         ← cómo construir y distribuir el .exe
├── README.md               ← este archivo
├── LICENSE                 ← Apache 2.0
├── package.json
├── main.js                 ← proceso principal Electron (filesystem + IPC)
├── preload.js              ← bridge contextual main↔renderer
├── config.default.js       ← semilla del config.js
├── lib/                    ← módulos puros y testables (parser/esquema de
│                             config, cliente D1 nube, migraciones, pdf, auditoría…)
├── renderer/
│   ├── index.html
│   ├── app.js              ← orquestación (eventos, bootstrap, IPC)
│   ├── calculo.js          ← lógica pura de cálculo
│   ├── admin.js            ← editor de modo administrador
│   ├── format.js           ← helpers de DOM/formato
│   └── styles.css
├── tests/                  ← Vitest sobre cálculo, parser y config por defecto
└── devlog/                 ← crónica de diseño y decisiones
```

---

## Uso rápido

```bash
pnpm install        # solo la primera vez
pnpm dev        # iterar en modo desarrollo
pnpm test           # ejecutar tests
pnpm build:win  # construir el instalador por-usuario en dist/
```

Detalles de empaquetado, distribución a otros PCs y resolución de problemas: [README-build.md](README-build.md).

---

## Versiones

| Versión       | Estado          | Alcance                                                                          |
| ------------- | --------------- | -------------------------------------------------------------------------------- |
| V1 (web)      | Cerrada         | Prototipo en navegador, sin persistencia compartida                              |
| V2 (Electron) | Cerrada         | App de escritorio, `config.js` en NAS, conflictos, backups                       |
| V3            | Cerrada         | Historial de presupuestos por PC + exportación a PDF                             |
| V4            | Cerrada         | Catálogo totalmente configurable por el usuario (productos, proveedores, extras, packs) |
| V5            | **Beta actual** | Almacenamiento opcional en Cloudflare D1 en la cuenta del propio cliente (sin backend), estadísticas en la app, auditoría + snapshots, productización (repo público, Apache-2.0); contraseña de admin eliminada |

Deliberadamente **fuera de alcance**: un servidor/backend propio, TypeScript, frameworks UI, bundlers, telemetría de negocio. Justificación y los debates documentados: [CLAUDE.md](CLAUDE.md).

---

## Contribuir

Proyecto interno de empresa pequeña (2–3 usuarios). No se aceptan PRs de terceros por defecto. Si vas a tocar el código:

1. Lee [CLAUDE.md](CLAUDE.md) (convenciones, principios, qué NO hacer).
2. Lee [PLAN_Calculadora.md](PLAN_Calculadora.md) si vas a tocar lógica de negocio.
3. Ejecuta `pnpm test` antes de proponer cambios.
4. Mantén las funciones de cálculo puras y testables.

---

## Licencia

[Apache License 2.0](LICENSE) — © 2026 Alejandro Escarpa Prieto.

---

## About

**Quanto** nace en un taller de personalización textil DTF en Guadalajara (España) con más de 25 años en el sector. La meta es muy concreta: presupuestar en segundos los "packs de peña" típicos de verano, manteniendo márgenes sanos y comunicando precios consistentes con descuento por volumen, sin depender de hojas de cálculo dispersas ni de la memoria del que coge el teléfono.

El diseño prioriza **claridad sobre flexibilidad**, **datos fuera del código** y **mínimo mantenimiento**: si un PVP cambia, el cambio es de datos, no de despliegue. La app debe seguir siendo entendible y editable por una sola persona dentro de cinco años.

- **Autor**: Alejandro Escarpa Prieto
- **Contexto**: empresa, uso interno, sin telemetría de negocio; nube opcional solo en la cuenta del propio cliente (sin backend del desarrollador)
- **Principios**: YAGNI, fail-fast, español en el dominio, cero build step

---

## Tags

`electron` · `desktop-app` · `windows` · `nsis-installer` · `vanilla-js` · `nodejs` · `pricing-calculator` · `quote-calculator` · `dtf-printing` · `direct-to-film` · `textile` · `apparel` · `merchandise` · `print-shop` · `small-business` · `internal-tool` · `nas-shared-config` · `electron-builder` · `vitest` · `spanish` · `es-ES`
