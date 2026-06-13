# Manual de usuario — PackPrice

> PackPrice es la calculadora de precios de packs DTF. Esta guía está pensada
> para quien usa la app a diario en el mostrador y para quien administra el
> catálogo: no hace falta saber de informática. Sigue las secciones en orden
> la primera vez; después, usa el índice para ir a lo que necesites.

**Versión del manual:** para PackPrice 5.x · **Última revisión:** 2026-06-13

> Las capturas de pantalla de este manual están **pendientes de generar** con
> el catálogo de demostración (nunca con precios reales). Donde verás
> `![…](images/…)` con la marca «TODO captura» habrá una imagen en la versión
> publicada.

---

## Índice

1. [Instalación](#1-instalación)
2. [Primer arranque: Local o Nube](#2-primer-arranque-local-o-nube)
3. [Uso diario: hacer un presupuesto](#3-uso-diario-hacer-un-presupuesto)
4. [Editar el catálogo](#4-editar-el-catálogo)
5. [Copias de seguridad y restauración](#5-copias-de-seguridad-y-restauración)
6. [Cambiar de Local a Nube (y viceversa)](#6-cambiar-de-local-a-nube-y-viceversa)
7. [Estados de los datos](#7-estados-de-los-datos)
8. [Plantillas de presupuesto](#8-plantillas-de-presupuesto)
9. [Estadísticas](#9-estadísticas)
10. [Privacidad y conexiones a internet](#10-privacidad-y-conexiones-a-internet)
11. [Actualizar la app](#11-actualizar-la-app)
12. [Preguntas frecuentes y problemas](#12-preguntas-frecuentes-y-problemas)
13. [Licencia](#13-licencia)

---

## 1. Instalación

PackPrice es un **único archivo `.exe`** para Windows. No tiene instalador: se
descarga, se guarda donde quieras y se ejecuta con doble clic.

1. Entra en la página de **GitHub Releases** del proyecto y descarga el archivo
   `PackPrice-<versión>-preliminar.exe` de la última versión.
2. Guárdalo donde te resulte cómodo, por ejemplo en el Escritorio o en una
   carpeta tipo `C:\Users\<tu usuario>\PackPrice\`. Puedes crear un acceso
   directo en el Escritorio.
3. Doble clic para abrir.

![Página de GitHub Releases con el .exe a descargar](images/manual-01-releases.png)
<!-- TODO captura: página de Releases (datos demo) -->

### 1.1 El aviso de Windows SmartScreen

La primera vez que ejecutes el `.exe`, Windows mostrará un aviso azul de
**SmartScreen** parecido a este: «Windows protegió tu PC».

> **Esto es normal y esperado.** El `.exe` de PackPrice **no está firmado con un
> certificado de pago** (decisión D3 del proyecto: para el uso actual no
> compensa el coste de un certificado). Windows desconfía por defecto de
> cualquier programa sin firma, aunque sea seguro. El aviso solo aparece la
> primera vez.

Para ejecutarlo:

1. En el aviso de SmartScreen, pulsa **«Más información»**.
2. Aparecerá un botón nuevo: **«Ejecutar de todas formas»**. Púlsalo.

![Aviso de SmartScreen con «Más información»](images/manual-02-smartscreen-1.png)
<!-- TODO captura: SmartScreen paso 1 -->

![Botón «Ejecutar de todas formas»](images/manual-03-smartscreen-2.png)
<!-- TODO captura: SmartScreen paso 2 -->

A partir de aquí la app arranca con normalidad y Windows ya no volverá a
preguntar por ese archivo.

> Si tu antivirus o las políticas de la empresa bloquean el ejecutable, pide a
> quien administre los PCs que añada una excepción para `PackPrice-*.exe`.

---

## 2. Primer arranque: Local o Nube

La primera vez que abres PackPrice (o cuando aún no hay un origen de datos
configurado), aparece el **asistente de primer arranque** con la pregunta:

> **¿Dónde guardamos tus datos?**

Dos opciones, ambas válidas y **intercambiables más adelante** (ver §6):

- **Local** — los datos viven en **este equipo** o en una **carpeta de red
  (NAS)** que compartes con tus compañeros. Sencillo, sin cuentas externas.
- **Nube** — los datos viven en **tu propia cuenta de Cloudflare** (gratis),
  accesibles desde todos tus equipos, con estadísticas centralizadas y acceso
  desde fuera del taller.

![Asistente: Local o Nube](images/manual-04-asistente.png)
<!-- TODO captura: asistente con las dos tarjetas -->

### 2.1 Opción Local

1. Pulsa **Local**.
2. Elige la ruta del archivo de configuración (`config.js`):
   - En **este PC**: por ejemplo `C:\PackPrice\config.js`.
   - En el **NAS** (carpeta de red), para compartir con el resto del taller:
     por ejemplo `\\172.26.0.154\Paep\Packs\config.js` o `Z:\Packs\config.js`
     si la unidad está mapeada.
3. Si el archivo no existe pero la carpeta es escribible, la app ofrece
   **crearlo con valores por defecto**. Acepta y listo.
4. Indica también tu **nombre de equipo/trabajador** (por ejemplo
   «Mostrador-2»): es el autor que quedará registrado en el historial de
   cambios.

Estos datos se guardan en `%APPDATA%\packprice\settings.json` de ese PC y no se
vuelven a pedir.

### 2.2 Opción Nube (Cloudflare D1)

La nube de PackPrice usa **Cloudflare D1** dentro de **tu propia cuenta de
Cloudflare**. No hay ningún servidor del desarrollador por medio: la app habla
directamente con Cloudflare y **crea tu base de datos sola** la primera vez.
Solo necesitas hacer una cosa a mano (una vez por empresa): generar una **clave
de acceso** (token) y pegarla.

El asistente te guía en 3 pasos con una barra de progreso:

**Paso 1 — Cuenta de Cloudflare.**
Si ya tienes cuenta, sigue. Si no, pulsa el botón que abre el **registro de
Cloudflare** en tu navegador y crea una cuenta gratuita (correo + contraseña).

**Paso 2 — Crear la clave de acceso (token).**
1. Pulsa el botón que abre la **página de crear token** con la **plantilla
   pre-rellenada** (permisos: solo Cloudflare D1).
2. En esa página de Cloudflare, pulsa para crear el token y **cópialo**.
   Cloudflare solo te lo muestra una vez: cópialo antes de cerrar.
3. Vuelve a PackPrice y **pega el token** en el campo. La app lo comprueba al
   instante contra Cloudflare; si no es válido, te lo dice en lenguaje claro
   («Esa clave no funciona — vuelve a copiarla»).

> **¿Por qué este paso es manual?** Cloudflare no ofrece un «inicio de sesión»
> automático para apps de terceros, así que el token es la forma segura de que
> la app actúe en tu cuenta. Es la única parte manual y solo se hace una vez
> por empresa.

**Paso 3 — Aprovisionamiento automático.**
La app, sola y con un indicador de progreso:
- detecta tu cuenta,
- **busca la base de datos `packprice`**:
  - si **ya existe** (es el segundo PC de tu empresa), se conecta;
  - si **no existe** (eres el primer PC), **la crea y aplica el esquema**.

Cuando termina, ya estás dentro. Indica también tu **nombre de
equipo/trabajador** para la auditoría.

![Asistente de nube, paso del token](images/manual-05-nube-token.png)
<!-- TODO captura: paso 2 del flujo de nube -->

> **El token vive solo en tu PC** (`settings.json`), nunca se envía al
> desarrollador ni se guarda en la nube de PackPrice. En todos los PCs de tu
> empresa se usa el **mismo token**.

---

## 3. Uso diario: hacer un presupuesto

El flujo de mostrador está pensado para presupuestar un pack en menos de un
minuto.

1. **Elige el pack** en la pantalla de selección (tarjetas con color e icono):
   por ejemplo «Pack Peña» (camiseta + sudadera).
2. **Introduce los datos del pedido**: cantidades, tallas (incluidas las
   especiales 3XL/4XL/5XL si las hay) y las opciones del pack (por ejemplo, con
   o sin capucha). Verás el **precio en vivo** en la columna lateral mientras
   escribes.
3. **Rellena los datos del cliente — obligatorios:**
   - **Nombre** del cliente.
   - **Teléfono** del cliente.
   La app no te deja guardar sin ambos (validación en línea, en el momento).
4. **Revisa el resultado**: precio grande, desglose, margen y el **PVP
   recomendado** (sugerido, nunca impuesto: puedes ajustar a mano).
5. **Guarda** el presupuesto en el historial.
6. **Exporta el PDF** con el botón correspondiente. El PDF lleva el cliente, el
   desglose y la **validez de 15 días** («Presupuesto válido hasta
   dd/mm/aaaa»). La validez es configurable como cualquier dato de negocio
   (ver §4).

![Resultado del presupuesto y exportar PDF](images/manual-06-resultado.png)
<!-- TODO captura: pantalla de resultado con datos demo -->

### 3.1 Estado del presupuesto (pendiente / aceptado / rechazado)

En el **historial**, cada presupuesto tiene un chip de estado que cualquier
trabajador puede cambiar con un clic:

- **Pendiente** (neutro) — recién creado, sin respuesta del cliente.
- **Aceptado** (verde) — el cliente lo aceptó.
- **Rechazado** (rojo) — el cliente lo descartó.

Cambiar el estado es un clic directo (sin formularios), con opción de deshacer
en un aviso breve. Estos estados alimentan la **conversión** en Estadísticas
(§9).

### 3.2 Recordatorio al arrancar

Cuando abres la app, si hay presupuestos que requieren atención aparece un
**aviso discreto** bajo la barra superior, por ejemplo:

> «4 presupuestos esperan respuesta · 2 caducan esta semana — [Revisar]»

Cuenta los presupuestos **sin estado con más de 7 días** y los que **caducan
esta semana** (validez 15 días). Pulsar **[Revisar]** abre el historial
filtrado. Se descarta con un clic y no vuelve hasta el día siguiente. **Nunca
bloquea**: es un recordatorio, no una tarea.

---

## 4. Editar el catálogo

En PackPrice **todo lo que es dinero es dato**: precios, costes, márgenes,
productos, proveedores, extras (addons), packs y los textos del presupuesto
(condiciones, notas) se editan desde la app, **sin tocar código**.

> **En la v5 ya no hay contraseña de administrador.** El editor del catálogo
> está disponible para cualquier trabajador desde la barra superior. La
> protección frente a errores no es una puerta, son tres cosas mejores:
> confirmación al guardar, autor registrado y vuelta atrás.

### 4.1 Cómo se edita y se guarda

1. Abre el **editor de catálogo** desde la barra superior. En la cabecera verás
   «Editando como *<tu nombre>*».
2. Cambia lo que necesites (un precio, un margen, una talla, un texto…).
3. Pulsa **Guardar**. Antes de escribir nada, aparece una **confirmación con el
   resumen de cambios** (qué entidades cambian y a qué valores) y el **autor**
   que quedará registrado:

   > `[Guardar N cambios]`  `[Cancelar]`

   No se puede guardar sin pasar por esta confirmación.

![Confirmación de guardado con el resumen de cambios](images/manual-07-confirmar.png)
<!-- TODO captura: diálogo de confirmación -->

### 4.2 Conflictos (dos personas editando a la vez)

Si mientras editabas otra persona cambió **la misma entidad** (por ejemplo, el
mismo pack), al guardar aparece un **diálogo de conflicto** con el diff (lo
suyo frente a lo tuyo):

> `[Cargar versión del servidor]`  `[Sobrescribir con la mía]`  `[Cancelar]`

Solo entra en conflicto la **entidad afectada**: el resto de tus cambios se
guardan con normalidad. La app te lo dice claro, por ejemplo «3 cambios
guardados, 1 conflicto».

> En **modo local** el control de conflictos compara fecha de modificación y
> firma (hash) del archivo; en **modo nube** compara la versión de cada
> entidad. En ambos casos el objetivo es el mismo: que nadie pise el cambio de
> otro sin enterarse.

### 4.3 Historial de versiones y «Restaurar versión»

Dentro del editor tienes:

- **Auditoría**: quién cambió qué y cuándo.
- **Versiones**: cada guardado deja una versión (snapshot). Con el botón
  **«Restaurar esta versión»** vuelves a un estado anterior; también pide
  confirmación y queda registrado en la auditoría.

> La restauración es **hacia adelante**: restaurar una versión vieja crea una
> **versión nueva** con ese contenido (no borra el historial). Así nunca se
> pierde la trazabilidad de lo que pasó.

![Lista de versiones con «Restaurar esta versión»](images/manual-08-versiones.png)
<!-- TODO captura: pestaña de versiones -->

---

## 5. Copias de seguridad y restauración

PackPrice protege tus datos en varias capas, según el modo.

### 5.1 Snapshots dentro de la app (Local y Nube)

Cada guardado del catálogo crea un **snapshot versionado**. Desde el editor
(§4.3) puedes volver a cualquier versión anterior con «Restaurar esta versión».
Es la forma más rápida de deshacer un cambio de precios equivocado: cuestión de
segundos, sin salir de la app.

### 5.2 En modo Nube: copias de Cloudflare

- **Antes de cada actualización de esquema** (cuando instalas una versión nueva
  de la app que necesita migrar la base de datos), PackPrice descarga
  **automáticamente** un volcado SQL completo a
  `%APPDATA%\packprice\backups\pre-migration-<fecha>.sql`. Si la migración
  fallara, la propia app ofrece un botón **«Restaurar copia de seguridad»** y no
  escribe nada más.
- **Time Travel de Cloudflare**: D1 guarda el estado de tu base de datos de los
  **últimos 30 días**. Es una red de seguridad gratuita frente a un borrado
  accidental, recuperable desde el panel de Cloudflare.
- **Export manual**: puedes exportar tu base de datos cuando quieras desde el
  **panel de Cloudflare** (sección de la base D1) o, si te manejas con
  herramientas técnicas, con el comando `wrangler d1 export`. *No es necesario
  para el uso normal* — es para quien quiera una copia externa adicional.

### 5.3 En modo Local: el archivo y sus backups

- Los datos viven en el **`config.js`** que elegiste (PC o NAS).
- **Antes de cada guardado del catálogo**, la app crea un backup fechado en la
  carpeta `backups\` junto al `config.js`:

  ```
  \\172.26.0.154\Paep\Packs\
  ├── config.js
  └── backups\
      ├── config-2026-04-28T15-30-12.js
      └── config-2026-04-29T09-15-44.js
  ```

- Estos backups **no se borran solos**: si crecen mucho con el tiempo, bórralos
  a mano de vez en cuando.

---

## 6. Cambiar de Local a Nube (y viceversa)

Los dos modos son **intercambiables en cualquier momento** desde
**Ajustes → Origen de datos**.

- **«Subir a la nube»**: lanza el asistente de nube (si aún no lo configuraste)
  y sube tu **catálogo completo** y el **historial de presupuestos** a tu
  cuenta de Cloudflare. Pide confirmación con un resumen.
- **«Bajar a local»**: descarga el catálogo de la nube y lo guarda como un
  `config.js` local. Pide confirmación.

Cambiar de origen recarga la app con los datos del nuevo origen. El modo local
sigue existiendo siempre como red de seguridad: si la nube te diera problemas,
«Bajar a local» te devuelve al archivo.

> **Consejo para el cambio definitivo a nube:** sube los datos, trabaja una
> semana comprobando que todo cuadra (precios, presupuestos), y solo entonces
> considera la nube como origen principal. La vuelta atrás siempre está
> disponible.

---

## 7. Estados de los datos

En modo nube, la barra superior muestra siempre un **indicador** del estado de
tus datos, para que sepas de un vistazo si estás viendo lo último:

| Estado | Qué significa | Qué puedes hacer |
|---|---|---|
| **Datos al día** (verde) | Conectado; ves la última versión del catálogo | Todo: presupuestar y editar |
| **Sin conexión** (ámbar) | No hay internet; ves los **últimos datos descargados**, con su fecha | Presupuestar sí; **editar el catálogo, no** |
| **Modo local** (neutro) | Estás trabajando con un archivo (PC/NAS), no con la nube | Todo, contra el archivo |

Junto al indicador hay un botón **«Actualizar»**: comprueba si hay novedades en
la nube y, si las hay, descarga y refresca; si no, te avisa con un «Ya estás al
día». Nunca bloquea la pantalla.

### 7.1 Sin conexión (modo solo lectura)

Si arrancas sin internet, la app usa la **caché local** (los últimos datos
descargados) y muestra un **banner** bajo la barra superior:

> ⚠ **Sin conexión.** Estás viendo precios del **12/06 14:32**. Puedes
> presupuestar, pero no editar el catálogo. `[Reintentar]`

- **Presupuestar funciona igual**: el cálculo es 100 % local.
- **Editar el catálogo está deshabilitado** (con un aviso al pasar el ratón).
- Los **presupuestos que crees sin conexión se guardan y se encolan**: en
  cuanto vuelva internet (al arrancar o al pulsar «Actualizar»/«Reintentar»),
  se suben solos a la nube. No se pierde nada y no se duplican.

![Banner de sin conexión](images/manual-09-offline.png)
<!-- TODO captura: banner offline con datos demo -->

> Si es el **primer arranque de un PC sin internet y sin datos guardados**, la
> app no puede inventar un catálogo: te ofrece **[Reintentar]** o **[Usar modo
> archivo…]** para apuntar a un `config.js`.

---

## 8. Plantillas de presupuesto

PackPrice trae **6 plantillas de PDF** integradas, seleccionables en
**Ajustes → Plantilla de presupuesto**:

**Clásica · Moderna · Compacta · Detallada · Corporativa · Formulario**.

- Al seleccionar una, ves una **vista previa** con un presupuesto de
  demostración.
- Las plantillas que usan color (**Corporativa** y **Moderna**) muestran un
  **selector de color de marca**: eliges el color de tu empresa y la app deriva
  sola los tonos oscuro y suave. El color es un dato de la empresa, igual para
  todos sus PCs.

![Galería de plantillas con vista previa](images/manual-10-plantillas.png)
<!-- TODO captura: galería de plantillas, datos demo -->

### 8.1 Plantillas personalizadas (solo modo nube)

Quien tenga conocimientos de HTML/CSS puede **añadir plantillas propias** con
«Añadir plantilla personalizada…». Se guardan en el **almacén compartido de la
empresa** (en la nube), de modo que **todos los PCs imprimen igual**.

Por seguridad, al cargarse se **sanean**: no se permiten scripts ni recursos
externos. Si una plantilla los contiene, la app la rechaza con un mensaje claro
(«La plantilla contiene scripts, que no están permitidos»).

> Todos los **textos** del presupuesto (condiciones, notas legales, nota de
> confirmación) son **datos editables** del catálogo, no parte fija de la
> plantilla: cada empresa los redacta a su manera desde el editor.

---

## 9. Estadísticas

La pantalla **«Estadísticas»** (accesible desde la barra superior) responde a
«¿qué se presupuesta y qué se vende?» con datos de **todos los PCs** de la
empresa.

> **Las estadísticas requieren el modo Nube.** Son lo que unifica los datos de
> todos los equipos. En **modo local**, la app solo conoce el historial de ese
> PC, así que las estadísticas globales no están disponibles en ese modo.

Qué muestra (con selector de periodo: Temporada · 30 días · Año · Rango):

- **Tarjetas resumen**: total presupuestado, total aceptado, **tasa de
  conversión**, unidades, ticket medio y **margen real medio vs. objetivo**.
- **Gráficos** (dibujados por la propia app, sin librerías externas):
  - presupuestos y unidades por pack,
  - conversión por pack (aceptado/rechazado/pendiente),
  - evolución semanal (presupuestado vs. aceptado),
  - distribución por tramo (T1–T4),
  - margen real vs. objetivo por pack,
  - desviación sobre el PVP recomendado,
  - top de productos y addons,
  - tallas especiales por pack.

Cada gráfico se puede **ver como tabla** para copiar los números.

![Pantalla de estadísticas](images/manual-11-estadisticas.png)
<!-- TODO captura: estadísticas con datos demo -->

---

## 10. Privacidad y conexiones a internet

PackPrice está construida sobre un principio: **el desarrollador no ve los
datos de ningún cliente.** Tus precios, clientes, catálogo y presupuestos viven
en **tu** almacenamiento (tu PC, tu NAS o tu cuenta de Cloudflare). El
desarrollador solo entrega el software.

Fuera de tu propio almacén, la app **solo** hace **dos** conexiones a internet,
ambas declaradas aquí y **ambas desactivables**:

### 10.1 Comprobación de versión (GitHub)

Al arrancar (si hay red) la app pregunta a **GitHub** si existe una versión
más nueva, para avisarte. No envía ningún dato tuyo: es una simple consulta de
«cuál es la última versión publicada». Se puede desactivar en **Ajustes →
Actualizaciones** («Buscar actualizaciones al iniciar»). Ver §11.

### 10.2 Informes de error (opt-out)

Cuando ocurre un **error técnico no controlado**, la app puede enviar un
**informe de error** al desarrollador para que pueda arreglarlo **antes** de
que te afecte más.

**Qué contiene EXACTAMENTE un informe de error** (lista cerrada):

- el **mensaje y la traza técnica del error** (stack trace),
- el **tipo/código** de error,
- la **versión de la app** y la **versión del esquema** de datos,
- el **sistema operativo** y la arquitectura,
- el **modo de almacenamiento** (local o nube).

**Qué NO contiene NUNCA** (garantizado por un filtro con pruebas automáticas):

- **precios, costes ni márgenes**,
- **clientes** (nombres, teléfonos),
- **catálogo** (productos, packs, proveedores),
- **presupuestos**,
- **tu token de Cloudflare** ni ninguna otra credencial,
- rutas con tu nombre de usuario de Windows (se recortan).

> El informe se envía a un servicio de errores estándar (compatible con
> Sentry). Si no hay internet en ese momento, el informe se encola en local y
> se envía al reconectar.

**Cómo desactivarlo:** **Ajustes → Privacidad → «Enviar informes de error»**.
Está activado por defecto; el interruptor lo apaga.

### 10.3 «Exportar diagnóstico» (para soporte)

Como el desarrollador no ve tus datos, el soporte es «a ciegas». Para ayudar
sin comprometer tu privacidad, **Ajustes → Privacidad → «Exportar
diagnóstico»** genera un archivo (`packprice-diagnostico-<fecha>.json`) con:

- las **últimas líneas del log** de la app,
- las **versiones** (app, esquema, Electron, SO),
- el **modo de almacenamiento**,
- tus **ajustes con el token oculto**,
- el **recuento** (no el contenido) de la caché y la cola de pendientes.

Este archivo **no contiene tu token ni datos de negocio**. **Tú decides** si lo
compartes con el desarrollador para diagnosticar un problema; la app solo lo
genera y abre la carpeta donde lo guardó.

![Sección de Privacidad en Ajustes](images/manual-12-privacidad.png)
<!-- TODO captura: ajustes de privacidad -->

---

## 11. Actualizar la app

PackPrice se distribuye por **GitHub Releases**. La actualización es manual y
nunca se instala sola.

- Al arrancar (o con el botón **«Buscar ahora»** en **Ajustes →
  Actualizaciones**), la app comprueba si hay una versión nueva. Si la hay,
  muestra «Versión X.Y disponible — [Descargar]», con enlace a la página de la
  release.
- Para actualizar: **descarga el nuevo `.exe`** de Releases y **reemplaza** el
  anterior. Tus ajustes (`settings.json`) y tus datos (config local o nube) se
  mantienen intactos.
- Si tu base de datos en la nube necesita migrarse, la app lo hace sola al
  arrancar la versión nueva, con copia de seguridad previa (ver §5.2). Las
  migraciones son **solo aditivas**: un PC con una versión más antigua sigue
  funcionando aunque un compañero ya haya actualizado.

> Puedes apagar la comprobación al iniciar con el interruptor «Buscar
> actualizaciones al iniciar». El botón «Buscar ahora» sigue disponible cuando
> quieras.

---

## 12. Preguntas frecuentes y problemas

**Windows me avisa de que el programa no es seguro (SmartScreen).**
Es por la falta de firma del `.exe` (ver §1.1). Pulsa «Más información» →
«Ejecutar de todas formas». Solo pasa la primera vez.

**No tengo internet. ¿Puedo trabajar?**
Sí. En modo nube arrancas con los últimos datos descargados (solo lectura) y
puedes presupuestar; los presupuestos se encolan y se suben al volver la
conexión (§7.1). En modo local no dependes de internet en absoluto.

**Me dice que el token de Cloudflare ya no funciona / lo he rotado.**
Crea un token nuevo en el panel de Cloudflare (misma plantilla de permisos D1)
y pégalo en **Ajustes → Origen de datos → token de Cloudflare**. El mismo token
sirve para todos los PCs de la empresa. Si sospechas que el token se filtró,
**revócalo** desde el panel de Cloudflare y crea uno nuevo: solo expone los
datos de tu propia cuenta, y los backups + Time Travel cubren el peor caso.

**Al guardar el catálogo me sale un «conflicto».**
Es lo esperado si dos personas editaban la misma entidad a la vez (§4.2).
Elige «Cargar versión del servidor» (descarta lo tuyo en esa entidad),
«Sobrescribir con la mía» o «Cancelar». El resto de tus cambios se guardan
igualmente.

**He cambiado un precio por error.**
Abre el editor → pestaña de **Versiones** → **«Restaurar esta versión»** sobre
el estado anterior (§4.3). En modo local, también tienes los backups fechados
junto al `config.js` (§5.3).

**Estoy montando PackPrice en otra empresa desde cero.**
Sigue el asistente de nube (§2.2): con un token nuevo, la app crea la base de
datos `packprice` sola en esa cuenta de Cloudflare. Cada empresa tiene su
cuenta, su base y su token: están **completamente aisladas** entre sí. El
catálogo de partida es un **catálogo de ejemplo** que debes editar con tus
propios productos y precios.

**La app no encuentra el `config.js` (modo local).**
Comprueba que el PC o el NAS están accesibles (la ruta UNC o la unidad
mapeada). Si la ubicación cambió, ve a **Ajustes → Origen de datos** y
selecciona la nueva ruta. Si el archivo no existe pero la carpeta es
escribible, la app ofrece crearlo.

**¿Dónde están mis ajustes y la caché?**
En `%APPDATA%\packprice\` de cada PC: `settings.json` (incluye tu token, solo
en local), la caché del catálogo y la cola de pendientes (outbox). Estos
archivos **no se suben** a ningún sitio.

**El desarrollador, ¿puede ver mis precios o mis clientes?**
No. Tus datos viven en tu almacenamiento. Las dos únicas conexiones salientes
(comprobación de versión y, opcionalmente, informes de error) **no contienen
datos de negocio** (§10). El export de diagnóstico solo se comparte si tú
decides hacerlo, y nunca incluye tu token.

---

## 13. Licencia

PackPrice se distribuye bajo la licencia **Apache-2.0**. Puedes usar y modificar
la app libremente según los términos de esa licencia (el texto completo está en
el archivo `LICENSE` del repositorio). El modelo de negocio es el **servicio**
(instalación, soporte y evolución), no el cobro por la licencia.

© xkoistudio.
