# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es esto

`mcp-cpi`: MCP server para operar un tenant de **SAP Integration Suite — Cloud Integration** desde
Claude. Nació en una migración SAP PI/PO → Integration Suite. **No es solo lectura**: el objetivo es
que sea herramienta de desarrollo — crear iFlows, deployarlos, validarlos y diagnosticarlos.

Para instalarlo y usarlo desde otro repo, ver [README.md](README.md). Este archivo es para trabajar
**sobre el server**.

**Estado: 21 tools** (10 de lectura, 10 de escritura, 1 de ejecución), **todas verificadas contra el
tenant real**. El ciclo de desarrollo del iFlow está probado entero:
`crear el package → clonar → enganchar el mapping → validar → deployar → ejecutar → leer el log y
los payloads → undeploy → borrar`.

| Lectura | Escritura | Ejecución |
|---|---|---|
| `cpi_ping` · `cpi_packages` · `cpi_iflow_list` · `cpi_iflow_read` · `cpi_download` · `cpi_messages` · `cpi_message_detail` · `cpi_trace` · `cpi_deployed` · `cpi_credentials` | `cpi_package_create` · `cpi_iflow_clone` · `cpi_iflow_configure` · `cpi_iflow_update` · `cpi_iflow_externalize` · `cpi_iflow_mapping` · `cpi_deploy` · `cpi_undeploy` · `cpi_iflow_delete` (+ `cpi_iflow_validate`, que no modifica nada) | `cpi_invoke` |

**El diagnóstico tiene dos niveles y no son intercambiables.** `cpi_message_detail` da la cabecera,
el error y qué pasos corrieron; `cpi_trace` baja un nivel y da **el payload de cada paso**. El
segundo es el que sirve cuando el iFlow completa en verde pero devuelve datos equivocados, que es
la forma típica de fallar de un mapping migrado.

⚠️ **Cero payloads tiene dos causas y confundirlas manda a arreglar lo que no está roto.** O el run
no corrió en `LogLevel=Trace` —que se prende **a mano en la UI** y no es retroactivo—, o corrió y
**las trazas ya se purgaron**: el payload caduca antes que el MPL, así que un run viejo queda
marcado `TRACE` y sin contenido, y la navegación contesta 200 con lista vacía en vez de avisar
(verificado el 2026-08-11, detalle en DISCOVERY). `cpi_trace` cuenta las trazas y el nivel de log
por separado justamente para decir cuál de las dos es.

**No hay `cpi_package_delete`, y es a propósito:** borrar un package se lleva puesto todo lo que
tiene adentro. `scripts/test-write-cycle.js` lo hace crudo contra el cliente, que es el único lugar
donde hace falta.

**Los dos planos del tenant.** `cpi_invoke` es la única tool que usa el plano de **runtime**
(service key del plan `integration-flow`, otro host: `…it-cpi008-rt.cfapps…`); todas las demás usan
el de **administración** (plan `api`). Por eso el `ctx` lleva dos clientes: `ctx.client` administra y
`ctx.runtime` ejecuta. `ctx.runtime` **puede venir null** — un profile sin esa key es config válida —
y la tool que lo necesita tiene que chequearlo y explicar qué falta, no romperse.

`cpi_invoke` está en `WRITE_TOOLS` aunque no escriba en el tenant: ejecuta un iFlow, y ese iFlow
puede mandarle una orden a un backend real. Un profile `readonly` tiene que ser inofensivo de verdad,
no solo no dejar rastro en Cloud Integration.

**Para saber qué hace un iFlow hay que leer sus archivos, no su metadata.** `cpi_iflow_read` con
`file=<ruta o nombre>` devuelve el contenido del Groovy, el XSLT, el WSDL o el propio `.iflw`. Va por
el ZIP del bundle y no por la navegación `Resources`. **No es que `Resources` no sirva:**
`Resources(Name='…',ResourceType='…')/$value` **sí** devuelve el contenido, verificado el 2026-08-10.
Va por el ZIP porque una sola descarga trae todo y no exige adivinar el `ResourceType`; con bundles de
pocos KB el intercambio conviene. Detalle en DISCOVERY.md.

**Las cuatro familias de artefacto se leen y se escriben con el mismo código.** `kind`
(`iflow` | `mapping` | `script` | `valuemapping`) lo aceptan `cpi_iflow_list`, `cpi_iflow_read`,
`cpi_iflow_clone`, `cpi_iflow_update`, `cpi_iflow_delete` y `cpi_deploy`: son gemelas —misma key,
mismo `/$value` con el bundle en ZIP— así que el entity set está parametrizado en `ops/design.js` y
en `ops/write.js` en vez de duplicado. Un Id de mapping pedido como iFlow da **404**, no lista vacía.

Dos asimetrías que el `kind` no borra. **`cpi_iflow_validate` es solo de iFlow** — no existe
`Validate` para el resto, así que ahí el deploy es la primera verificación y cada intento sale más
caro. Y **solo el deploy de iFlow devuelve TaskId**: `DeployMessageMappingDesigntimeArtifact`
responde con el body vacío aunque el deploy arranque bien, así que para esas familias no hay
`BuildAndDeployStatus` que consultar y hay que esperar sobre `IntegrationRuntimeArtifacts`
(`deployDevuelveTaskId` en `ops/write.js`). Dar el body vacío por error es un **falso negativo sobre
un deploy exitoso** — ya pasó.

**Enganchar un mapping a un iFlow toca DOS archivos del bundle.** `cpi_iflow_mapping` escribe las
seis propiedades del paso en el `.iflw` **y** el header `Require-Capability` del `MANIFEST.MF`: con
solo el modelo, el bundle OSGi no declara la dependencia. El `.mmap` no se copia — es una referencia
—, y por eso **el mapping se deploya antes que el iFlow**: no hay auto-deploy del referenciado.
La ruta del `.mmap` se **lee** del bundle y no se deriva del Id: el nombre del archivo no es
predecible desde afuera, porque el tenant reescribe el bundle al ingerirlo.

⚠️ **Que un iFlow enganchado quede `STARTED` no prueba que el enganche ande.** La cláusula lleva
`resolution:=optional`, así que OSGi no falla si no resuelve. Para verificarlo hay que **invocar** y
mirar el payload transformado. Ya se hizo una vez (2026-08-10, detalle en DISCOVERY).

**Convertir un iFlow hecho a mano en un molde reusable es código, no trabajo manual.**
`cpi_iflow_externalize` convierte los
valores hardcodeados del modelo en parámetros externalizados reescribiendo el bundle: `{{Nombre}}` en
el `.iflw` y el default en `parameters.prop` — el `parameters.propdef` **no hace falta**. Verificado
end-to-end: el runtime sustituye el placeholder al deployar. Detalle en DISCOVERY.md.

⚠️ **En el tenant hay artefactos que no son de este repo, y no se tocan.** Un tenant de desarrollo
tiene packages de otras personas y artefactos deployados a propósito. Los smoke tests crean y borran
**lo suyo** (Ids con prefijo `zz_` / `ZZ`, dentro del package `DEVtest`); el resto es solo lectura.

**El flujo de creación es clonar-y-configurar, no generar.** El `MANIFEST.MF` es un bundle OSGi con
~1,5 KB de `Import-Package` de internals de Camel/CXF: sintetizarlo no es viable. `cpi_iflow_clone`
baja el bundle de una plantilla, reescribe `MANIFEST.MF` y `.project`, y lo sube con Id nuevo; después
`cpi_iflow_configure` ajusta los parámetros externalizados. Verificado: un clon así pasa el
`ValidateIntegrationDesigntimeArtifact` del tenant.

Documentos, en orden de autoridad:

1. **[DISCOVERY.md](DISCOVERY.md)** — lo verificado contra el tenant real. **Manda sobre todo lo demás.**
   Si el PLAN y el DISCOVERY se contradicen, gana el DISCOVERY (ya pasó con el CSRF).
2. [ROADMAP.md](ROADMAP.md) — lo que falta construir en el MCP, y lo que se decidió **no** hacer y
   por qué. Es el único backlog: DISCOVERY registra el tenant, no el trabajo pendiente.
3. [PLAN-mcp-integration-suite.md](PLAN-mcp-integration-suite.md) — diseño original. Vigente en
   arquitectura; **desactualizado en varios supuestos de API**.
4. Business Accelerator Hub / Help Portal — contrato documentado. Ver nota de browser abajo.

🔴 **Este repo es el server, no el proyecto que lo usa.** El proyecto de migración —arquetipos,
mapeos del ESR, la pata contra el ABAP, el inventario del parque, el vocabulario
`provider`/`consumer`— vive en **su propio workspace**, que declara este server en su `.mcp.json` y
lo **usa**. Acá se lo **construye**.

El criterio de corte, cuando aparezca un hallazgo nuevo: si sirve para **construir una tool**, va a
DISCOVERY; si sirve para **migrar una interfaz**, va al otro workspace. Y si describe algo que salió
del PI, del ESR o de un canal —no de leer el tenant—, **decirlo**: mezclar los dos vocabularios ya
hizo parecer erróneo un iFlow sano.

**El cómo se hace vive en una skill, no en estos documentos.** `.claude/skills/mcp-cpi-iflows/` tiene
el procedimiento para crear un iFlow y para migrar un ICO según su forma —un archivo por arquetipo en
`workflows/`—, con el ciclo `clonar → externalizar → configurar → validar → deployar → invocar`. La
división es: **DISCOVERY registra lo verificado, la skill dice en qué orden usarlo.** Está incompleta a
propósito: sólo el arquetipo 3 se probó end-to-end, y cada archivo dice qué falta.

**La skill se escribe acá y se usa allá.** Va local al repo, nunca a nivel user —misma regla que los
MCPs—, y `npm run skills:sync` la copia a los workspaces cuyo `.mcp.json` declara este server; los
que no lo declaran no se tocan. Dónde buscar esos workspaces lo dice la variable de entorno
`CPI_WORKSPACES_DIR` (rutas separadas por `;`); sin ella, el sync no hace nada. ⚠️ **La copia de
allá no es la fuente**: editarla ahí no sirve, el próximo sync la pisa.

**El desfasaje lo ataja un hook, no la buena memoria:** `.githooks/pre-commit` corre
`sync-skills.js --check` cuando el commit toca `.claude/skills/` y **aborta** si algún workspace quedó
con la versión vieja. Avisa y da el comando; **no copia solo** — un commit no debería escribir fuera
del repo sin que se lo pidan. Se activa una vez por clone:

```bash
git config core.hooksPath .githooks
```

El check compara **por contenido, byte a byte**: la fecha no prueba nada, porque copiar actualiza la
mtime. Y si no hay ningún workspace destino, sale 0 — nada que sincronizar no es un error.

Proyecto hermano: `mcp-pi` — 9 tools de solo lectura contra el **Integration Directory** del PI.
Los dos servers se usan juntos desde el workspace de la migración, y ninguno depende del otro en
código. **No llega al ESR**: ese spike dio negativo (no hay API de lectura).

Patrón de referencia maduro: `mcp-sap` (ABAP/ADT), de donde salen la estructura de `systems.json`,
la policy por profile y los errores con hint.

## Comandos

```bash
npm test             # unitarios + boot. NO toca el tenant, no pide credenciales
npm run test:unit    # node --test test/ — zip.js, iflw.js, rewriteManifest(), _render.js. Lógica pura
npm run test:boot    # test-mcp-boot.js — levanta el server, tools/list por JSON-RPC
npm run smoke        # test-smoke.js — ejercita las tools de lectura contra el tenant real
npm run smoke:write  # test-write-cycle.js — ⚠️ ESCRIBE: crea package/clona/configura/valida/borra. No deploya
npm run smoke:deploy # test-deploy-cycle.js — ⚠️ ESCRIBE EN EL RUNTIME: clona/deploya/undeploya/borra
npm start            # node bin/stdio.js
npm run discover     # discover.js — token + $metadata + inventario de entity sets
npm run skills:sync  # copia .claude/skills/ a los workspaces que declaran mcp-cpi. ESCRIBE fuera del repo
npm run skills:check # exit 1 si algun workspace quedo con la skill vieja
```

`npm test` es **obligatorio** después de tocar `src/` o de agregar una tool. Falla si una tool no tiene
`additionalProperties:false`, descripción decente o entrada en `ANNOTATIONS`.

Los unitarios cubren la lógica de formato, que es donde una regresión no falla al escribir sino
**al deployar**: round-trip de ZIP y que un bundle reescrito conserve lo que no se tocó; que una clave
ambigua del `.iflw` **tire error** en vez de reemplazar la primera; el escape de `:` y `=` del
`.properties`; que `rewriteManifest()` respete las continuaciones a los 72 bytes del `Import-Package`;
y que `addRequireCapability()` sume una cláusula al header sin duplicar la clave ni replegar el resto
del manifiesto. `diagnostico.test.js` cubre lo otro que se rompe en silencio: que el detalle de un
deploy fallido se lea de donde SAP lo pone (`parameter`, no `messageText`) y que el volcado del
Validate se resuma en vez de gastar el contexto en 100 frames de Tomcat.
`trace.test.js` va contra un cliente falso que **registra cada path pedido**, porque lo que se
rompe en la cadena de trazas no es la lógica sino las dos URLs: la key compuesta del `RunStep` sale
del `__metadata.uri` (armarla a mano da 404) y `TraceMessages` necesita el sufijo `L` del
`Edm.Int64`. Cubre además que las dos causas de "cero payloads" den mensajes distintos.
`render.test.js` va por otro lado: invoca los handlers reales con `ctx` vacío, así el texto que se
verifica es el mismo que ve el modelo.

Sondas de discovery (regenerables, escriben en `discovery-raw/`, gitignoreado):

```bash
node scripts/probe-entities.js       # ?$top=1 por entidad: cuáles responden y con qué campos
node scripts/probe-navigation.js     # recorre las navegaciones con IDs reales
node scripts/probe-iflow-content.js  # baja el ZIP de un iFlow y lista su contenido
node scripts/probe-write-csrf.js     # ⚠️ ESCRIBE: crea y borra un artefacto descartable
node scripts/probe-runtime-key.js    # valida la key del plan integration-flow (scope ESBMessaging.send)
node scripts/probe-invoke.js <addr>  # ⚠️ EJECUTA: invoca el endpoint de un iFlow deployado
node scripts/probe-trace-cycle.js    # ⚠️ EJECUTA: invocar -> MPL -> RunSteps -> payload (pide Trace)
node scripts/probe-mapping-bundle.js [kind] [id]   # baja el bundle de un artefacto que no es iFlow
node scripts/probe-deploy-mapping.js [id]          # ⚠️ ESCRIBE EN EL RUNTIME: deploya un mapping
node scripts/probe-mapping-reference.js [iflow] [mapping]  # compara nuestro enganche vs el de la UI
node scripts/probe-package-download.js [packageId]         # los dos /$value de descarga: package y bundle
node scripts/probe-remove-file.js [sourceId]  # ⚠️ ESCRIBE: matriz de eliminar archivos del bundle, sobre clones descartables
```

`probe-runtime-key`, `probe-invoke` y `probe-trace-cycle` usan el bloque `runtime` del profile (plan
`integration-flow`); los tres de mapping van por el plano de administración. El `LogLevel=Trace` que
necesita `probe-trace-cycle` **se prende a mano en la UI**: no hay API para eso.

## Arquitectura

Regla central: **las tools no conocen el transporte.** Nada de stdio/HTTP dentro de `src/tools/`.

```
bin/stdio.js       config -> CpiClient -> createServer -> StdioServerTransport. Único entrypoint
src/server.js      createServer(deps): registra tools, ANNOTATIONS, gate de policy. NO conoce transporte
src/config/local.js  systems.json + env CPI_PROFILE / CPI_SYSTEMS   (btp.js sería el equivalente para VCAP_SERVICES)
src/core/token.js    TokenSource: OAuth2 client_credentials + cache. Compartido por los DOS planos
src/core/client.js   CpiClient: plano `api` (OData v2 + errores con hint). SIN orquestación
src/core/runtime-client.js  RuntimeClient: plano `integration-flow`. Invoca /http/<address>
src/core/zip.js      lectura/escritura de ZIP sin dependencias (solo store/deflate, sin ZIP64)
src/core/iflw.js     formato del modelo: propiedades del .iflw y parameters.prop. Sin HTTP
src/core/ops/        composites task-shaped: design.js / monitor.js / runtime.js / write.js. La "cocina"
src/tools/*.js       una tool por archivo. `_render.js` es helper compartido, no es tool
```

**Dónde va el código nuevo:** ¿una llamada REST nueva? → `core/client.js`. ¿Encadena varias llamadas o
tapa un quirk? → `core/ops/`. ¿Superficie para el modelo? → `src/tools/`. Lógica en las tools: **no**.

### Contrato de una tool

Cada archivo de `src/tools/` exporta cuatro cosas: `inputSchema` (zod `.strict()`), `jsonSchema`
(escrito a mano, sincronizado a mano — no usamos `zod-to-json-schema`), `handler(args, ctx)` y
`definition`.

**El contexto viaja por invocación, no en un closure.** `mcp-sap` usa `makeHandler(client)` y queda
atado a una sola identidad; acá es `handler(args, ctx)` con
`ctx = { client, policy, profile, label, identity }`. Es la costura que permite HTTP multi-sesión después.

**Siempre devolver `{ content: [...] }` en éxito y `{ isError: true, content: [...] }` en error — nunca
`throw`.** Usar los helpers `ok()` / `fail(err, {tool})` de `_render.js`: `fail` propaga el `hint`, y
traduce el `ZodError` a frases (`falta el parametro requerido "messageGuid"`) en vez de volcar su JSON.
Por eso el `try { inputSchema.parse(args) } catch { return fail(err, {tool}) }` de cada handler no es
ceremonia: es lo que hace que un argumento mal puesto se corrija en el mismo turno.

**Para agregar una tool:** crear el archivo → importarla en `src/server.js` y sumarla a `MODULES` →
agregarla a `ANNOTATIONS` → si escribe, agregarla a `WRITE_TOOLS` → `npm test`.

## Convenciones

- Nombres de tools: `cpi_<noun>`.
- Las tools de escritura van en `WRITE_TOOLS` de `server.js`: un profile con `policy: "readonly"` las
  bloquea antes de llegar al handler.
- Credenciales en `systems.json` **gitignoreado**, con `systems.example.json` versionado. Profile activo
  por env `CPI_PROFILE`; ruta del archivo por env `CPI_SYSTEMS` (default: la raíz de este repo).
- **Nunca** loggear ni devolver clientsecret/token. De `UserCredentials`/`SecureParameters` solo
  **nombres**, y con **whitelist explícita** de campos (`CREDENTIAL_SAFE_FIELDS` en `ops/runtime.js`):
  la entidad devuelve un campo `Password`, y con blacklist un campo nuevo de SAP se filtraría solo.
- Logging siempre por **stderr** (en stdio, `stdout` es el canal JSON-RPC). El smoke test detecta un
  `console.log()` mal puesto porque rompe el parseo JSON-RPC.
- El MCP se registra **por proyecto** ([.mcp.json](.mcp.json)), nunca a nivel user.

## Gotchas del API (todos verificados contra el tenant — detalle en DISCOVERY.md)

- **El CSRF NO hace falta.** Con Bearer, `POST` sin `X-CSRF-Token` devuelve 201. No hay cookie jar. Se
  mantiene un reintento defensivo ante `403 + X-CSRF-Token: Required` por si alguna operación difiere.
- **`$format=json` no es universal** (`KeystoreEntries` lo rechaza). Pedir JSON por header `Accept`.
- **`$top` no es universal**: `UserCredentials`, `SecureParameters`, `DataStores`, `Variables` lo rechazan.
- **`$skip` se ignora EN SILENCIO en las navegaciones** (`IntegrationPackages(…)/…Artifacts`): no da
  error, devuelve la primera página de nuevo. Ahí hay que paginar en memoria. Y `$inlinecount` solo
  anda en `MessageProcessingLogs`. Tabla completa en DISCOVERY.md.
- **La API es un grafo.** De 131 entity sets del `$metadata`, solo 7 son consultables de primer nivel; el
  resto da `501` y se alcanza navegando desde `IntegrationPackages` o `MessageProcessingLogs`. Y el
  `$metadata` **sobre-declara**: `IntegrationFlows` figura pero da 404.
- **El Id de un package no admite guion bajo**, aunque el de un artefacto sí: `ZZ_PKG_PROBE` da
  `400 — cannot have a special character` y `zz_clone_probe` es un Id de iFlow válido. Dos reglas
  distintas para lo que parece el mismo campo.
- **`500` = error de negocio**, no fallo transitorio (ej: Id duplicado). Nunca reintentar a ciegas; el
  mensaje útil está en `error.message.value`.
- **`204`** en una navegación significa vacío, no error.
- **Un draft bloquea el export del package entero** (`IntegrationPackages('…')/$value` → 500
  listando los drafts), y en el listado el draft figura como `Version: 'Active'`, no `'Draft'`.
  El bundle individual del draft sí se baja. Es el gotcha central de `cpi_download`.
- **Estados transitorios en deploy/undeploy**: `BuildAndDeployStatus` pasa por `DEPLOYING` antes de
  `SUCCESS`, y el runtime por `STARTING`/`STOPPING`. Darlos por finales genera **falsos errores** (ya
  pasó). Hay que esperar dos veces: el task y después el runtime (`waitForDeploy` / `waitForRuntime`).
- **No hay FunctionImport de undeploy**: se hace con `DELETE IntegrationRuntimeArtifacts('<id>')`.
- **El runtime tiene DOS servlets y el sender decide cuál**: un sender SOAP se invoca por
  `/cxf/<address>` y uno HTTPS/REST por `/http/<address>`. Lo dice el campo `Protocol` de
  `ServiceEndpoints`. Errarle da **404 del Tomcat con el iFlow sano y `STARTED`**, y sin MPL donde
  mirar: parece que el iFlow no escucha (ya pasó, 2026-08-27).
- **`ServiceEndpoints` va atrasado respecto del deploy**: se midió entre 30 s y **más de 3 minutos**
  con el artefacto ya en `STARTED`. Reintentar antes de concluir que el iFlow no expone endpoint.
- **`BuildAndDeployStatus` solo responde con la key** (`(TaskId='…')`); como colección da 501.
- **Dos formatos de fecha mezclados**: `Edm.DateTime` viene como `/Date(...)/` y algunos `Edm.String`
  traen epoch millis en texto (`CreatedAt`, `ModifiedDate`). `clean()` en `client.js` maneja ambos.
- **`/$value`** devuelve el binario del artefacto; sin `/$value` devolvés el registro JSON.
- El host del API sale del campo `url` de la service key y **difiere** del host de la UI
  (`it-cpi008...` vs `integrationsuite...`).
- **`api.sap.com` y `help.sap.com` son SPAs**: `WebFetch` devuelve vacío. Leerlas con las tools de browser.
