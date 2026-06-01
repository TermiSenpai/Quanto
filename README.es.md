# PackPrice

> **Idioma**: Español · [English](README.md)

Calculadora de escritorio para presupuestar **packs de personalización textil DTF** (Direct-to-Film). Pensada para uso interno en taller: cada PC corre el `.exe` portable y todos comparten un único `config.js` en el NAS de la empresa.

> Estado actual: **beta** (`2.0.0-preview`). En uso interno, pendiente de cerrar PVPs provisionales y de varios pulidos antes de marcar V1.

---

## Qué hace

- Calcula PVP, coste, margen e IVA para cinco modalidades de pack (peña, solo camisetas, solo sudaderas con/sin capucha, mixto de sudaderas).
- Aplica tramos de volumen (T1–T4) con descuento por cantidad y reducción de tiempo de mano de obra.
- Soporta recargos directos al cliente por tallas grandes (4XL, 5XL+) y un buffer interno para 3XL.
- Modo administrador con clave compartida para editar parámetros, PVPs y modelos sin tocar código.
- Detección de conflictos cuando dos personas editan el `config.js` a la vez (comparación `mtime + sha256`, backup automático antes de cada escritura).
- Primer arranque guiado: pide nombre del usuario y ruta del config en el NAS, los persiste en `%APPDATA%\packprice\settings.json`, y ofrece sembrar el `config.js` con valores por defecto si no existe.

---

## Stack y filosofía

| Pieza                   | Decisión                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------ |
| Runtime                 | Electron + Node.js (main) + Chromium (renderer)                                      |
| UI                      | HTML + CSS + JS vanilla (sin framework, sin build step)                              |
| Persistencia compartida | `config.js` plano en el NAS, parseado en sandbox (`vm.runInNewContext`, timeout 1 s) |
| Persistencia local      | `settings.json` en `%APPDATA%\packprice\`                                            |
| Tests                   | Vitest sobre la lógica de cálculo y el parser de config                              |
| Empaquetado             | `electron-builder` portable Windows x64                                              |
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
├── lib/
│   └── config-parser.js    ← parser aislado del config en NAS
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
pnpm build:win  # construir el .exe portable en dist/
```

Detalles de empaquetado, distribución a otros PCs y resolución de problemas: [README-build.md](README-build.md).

---

## Roadmap

Versiones pasadas y previstas. La V4 sólo se aborda si se cruza el umbral cuantitativo descrito; lo demás puede ocurrir antes según necesidad.

| Versión       | Estado          | Alcance                                                                                                                                 |
| ------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| V1 (web)      | Cerrada         | Prototipo en navegador, sin persistencia compartida                                                                                     |
| V2 (Electron) | **Beta actual** | App de escritorio, `config.js` en NAS, modo admin, conflictos, backups                                                                  |
| V2.x          | En curso        | Cierre de PVPs provisionales (sudaderas), pulido UI, más tests                                                                          |
| V3            | Planificado     | Historial de presupuestos por PC (`localStorage`), exportación a PDF                                                                    |
| V4            | Condicional     | Backend HTTP local (Node + Express + SQLite) si se superan ~5 usuarios o se piden reportes cross-PC. Auto-update con `electron-updater` |

Decisiones contempladas pero **deliberadamente fuera de alcance hoy**: TypeScript, frameworks UI (React/Vue/Svelte), bundlers, telemetría, internacionalización. Justificación y criterios para reconsiderar: [CLAUDE.md §11](CLAUDE.md).

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

**PackPrice** nace en un taller de personalización textil DTF en Guadalajara (España) con más de 25 años en el sector. La meta es muy concreta: presupuestar en segundos los "packs de peña" típicos de verano, manteniendo márgenes sanos y comunicando precios consistentes con descuento por volumen, sin depender de hojas de cálculo dispersas ni de la memoria del que coge el teléfono.

El diseño prioriza **claridad sobre flexibilidad**, **datos fuera del código** y **mínimo mantenimiento**: si un PVP cambia, el cambio es de datos, no de despliegue. La app debe seguir siendo entendible y editable por una sola persona dentro de cinco años.

- **Autor**: Alejandro Escarpa Prieto
- **Contexto**: empresa, uso interno, sin telemetría ni servicios en la nube
- **Principios**: YAGNI, fail-fast, español en el dominio, cero build step

---

## Tags

`electron` · `desktop-app` · `windows` · `portable-exe` · `vanilla-js` · `nodejs` · `pricing-calculator` · `quote-calculator` · `dtf-printing` · `direct-to-film` · `textile` · `apparel` · `merchandise` · `print-shop` · `small-business` · `internal-tool` · `nas-shared-config` · `electron-builder` · `vitest` · `spanish` · `es-ES`
