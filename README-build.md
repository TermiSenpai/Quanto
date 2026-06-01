# PackPrice · Calculadora de packs (Electron)

App de escritorio para Windows. La calculadora vive en cada PC y lee/escribe el `config.js` centralizado en el NAS.

---

## 1. Requisitos previos

En el PC donde vayas a construir el `.exe`:

- **Node.js 18 o superior** (recomendado 20 LTS): https://nodejs.org
- **Conexión a internet** para descargar dependencias la primera vez

No necesitas Visual Studio ni Build Tools, electron-builder usa binarios pre-compilados.

---

## 2. Probar en modo desarrollo (sin construir)

Para iterar rápido durante el desarrollo:

```bash
pnpm install     # solo la primera vez
pnpm start       # alias de "electron ."
```

Cualquier cambio en el código requiere cerrar y volver a ejecutar.

---

## 3. Construir el .exe

Cuando quieras distribuir un binario:

```bash
pnpm build:win
```

Esto genera el ejecutable. Cuando termine, lo encontrarás en:

```
dist/PackPrice-2.0.0-portable.exe
```

Es un único archivo de ~85 MB. No necesita instalación.

---

## 4. Distribución a otros PCs

1. Construye el `.exe` una vez en tu PC.
2. Copia `dist/PackPrice-2.0.0-portable.exe` a cada PC de los usuarios.
3. Cada usuario:
   - Lo guarda en su escritorio o en `C:\Users\<usuario>\PackPrice\`.
   - Crea un acceso directo en el escritorio si quiere.
   - Doble clic para abrir.
4. La primera vez en cada PC, la app pedirá:
   - El nombre del usuario (Alberto, Fede, etc.).
   - La ruta del `config.js` en el NAS (ej: `\\172.26.0.154\Paep\Packs\config.js` o `Z:\Packs\config.js` si está mapeada).
5. Esos datos se guardan en `%APPDATA%\packprice\settings.json` y no se vuelven a pedir.

---

## 5. Creación del config.js

PackPrice puede crear el `config.js` automáticamente la primera vez:

- En el primer arranque, autopobla la ruta sugerida (UNC del NAS).
- Si esa ruta es accesible pero el archivo no existe, la app pregunta con un diálogo nativo:
  > **¿Crear config.js con los valores por defecto?**

  Al aceptar, se crea con los valores del plan (`PLAN_Calculadora.md`).

- Si el archivo ya existe, se lee tal cual.
- Si más adelante el archivo se borra o se mueve, la pantalla de error ofrece "Crear config con valores por defecto" o "Cambiar ubicación...".

Estructura recomendada en el NAS:

```
\\172.26.0.154\Paep\Packs\
├── config.js           ← creado por la app la primera vez
└── backups\            ← se crea automáticamente con cada edición admin
    ├── config-2026-04-28T15-30-12.js
    └── config-2026-04-29T09-15-44.js
```

---

## 6. Actualizaciones futuras

Cuando saques una nueva versión:

1. Reconstruye el `.exe` con los nuevos cambios (`pnpm build:win`).
2. Distribuye el nuevo `.exe` a cada PC reemplazando el anterior.
3. Los `settings.json` y el `config.js` del NAS se mantienen sin tocar.

Si a futuro lo necesitas, podemos añadir auto-update con `electron-updater`, pero requiere infraestructura (un servidor o un GitHub Releases). Para 2 PCs no compensa.

---

## 7. Estructura del proyecto

```
packs app/
├── package.json              ← dependencias y scripts
├── main.js                   ← proceso principal Electron (filesystem, IPC)
├── preload.js                ← puente seguro main↔renderer
├── config.default.js         ← valores por defecto (semilla del config.js)
├── icon.png                  ← icono del .exe
├── README-build.md           ← este archivo
├── CLAUDE.md                 ← guía para desarrollo y mantenimiento
├── PLAN_Calculadora.md       ← plan funcional y modelo de negocio
├── renderer/
│   ├── index.html            ← UI (todas las pantallas)
│   ├── app.js                ← orquestación (eventos, bootstrap, IPC)
│   ├── calculo.js            ← lógica pura de cálculo
│   ├── admin.js              ← editor de modo administrador
│   ├── format.js             ← helpers de DOM/formato
│   └── styles.css            ← estilos
└── dist/                     ← se crea al ejecutar build (no commitear)
    └── PackPrice-2.0.0-portable.exe
```

---

## 8. Resolución de problemas

**`pnpm install` falla con error de permisos en Windows**
Ejecuta la terminal como administrador.

**`pnpm build:win` falla con "code signing"**
electron-builder a veces avisa de que no firmaste el `.exe` digitalmente. Para uso interno no hace falta firmarlo. Si te bloquea: añade `"sign": null` en `package.json` dentro de `build.win`.

**Windows SmartScreen avisa al ejecutar el .exe**
Es normal con `.exe` sin firma. Pulsa "Más información" → "Ejecutar de todas formas". Solo se muestra la primera vez.

**La app no encuentra el config.js**
Comprueba que el NAS está accesible (la ruta UNC `\\172.26.0.154\Paep\Packs\` o la unidad `Z:` mapeada). Si la ubicación cambia, abre la app, ve a "Ajustes" y selecciona la nueva ruta. Si el archivo no existe pero la ruta es escribible, la app ofrece crearlo con valores por defecto.

**Conflicto al guardar en modo admin**
Es lo esperado si los dos editáis a la vez. La app pregunta qué hacer (sobrescribir / descartar / cancelar). Antes de cualquier sobrescritura, se crea un backup en `<NAS>\Packs\backups\`.

---

## 9. Notas de seguridad

- Toda comunicación con filesystem va a través de `main.js`. El renderer (la UI) **no** tiene acceso directo al disco.
- `contextIsolation: true` y `nodeIntegration: false`: el código del renderer no puede ejecutar Node.
- `preload.js` expone solo las funciones necesarias (leer/escribir config, settings, diálogos) en `window.packprice`.
- La clave de admin (en `config.js`) es protección anti-clic-accidental, no seguridad real. Cualquiera con acceso al NAS puede leerla.
- Los backups en `<NAS>\Packs\backups\` no se borran automáticamente. Limpia manualmente cada cierto tiempo si crecen mucho.
