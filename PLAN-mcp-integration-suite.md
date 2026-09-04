# PLAN — MCP server para SAP Integration Suite (Cloud Integration)

> ⚠️ **Documento histórico: es el diseño original del 2026-07-28, no el estado de hoy.** Sigue vigente
> en arquitectura (transporte desacoplado, `handler(args, ctx)`, policy por profile) y **desactualizado
> en varios supuestos de API**. Los dos que más engañan: el **CSRF no hace falta** con Bearer, y la
> tabla de "tools propuestas" no es la que se construyó (`cpi_endpoints`, `cpi_iflow_upload` y
> `cpi_deploy_status` no existen; ver el listado real en [CLAUDE.md](CLAUDE.md)).
> **Manda [DISCOVERY.md](DISCOVERY.md)**, que es lo verificado contra el tenant.

> Brief para un MCP builder de Claude. Objetivo: construir un MCP server **sólido, basado en la
> documentación oficial de SAP y verificado contra los endpoints realmente disponibles en el tenant**
> antes de dar por definida cada tool. Si la skill `mcp-builder` está disponible, usarla.

## Contexto

- Proyecto: migración SAP PI/PO → Integration Suite (el PI se da de baja).
- Tenant Cloud Integration: `https://<tenant>.integrationsuite.cfapps.<region>.hana.ondemand.com`
  (subaccount BTP en Cloud Foundry, región `cf.br10`).
- Patrón de referencia obligatorio: el server hermano `mcp-sap` (leer su `CLAUDE.md`): perfiles por
  sistema en `systems.json` **gitignoreado**, tools orientadas a tarea (no wrappers 1:1 de la API),
  errores con hints accionables, política de solo-lectura configurable por profile.
- Preferencia del usuario (global): el MCP se registra **por proyecto** (`.mcp.json` del workspace o
  `claude mcp add -s project`), nunca a nivel user.

## Qué queremos armar

Un MCP (`mcp-cpi`) para operar el tenant desde Claude:

1. **Leer**: packages, iFlows (metadata y contenido), artefactos deployados, endpoints expuestos,
   message processing logs (monitoreo/diagnóstico), nombres de credenciales (nunca secretos).
2. **Escribir** (gated): subir/actualizar iFlows (ZIP), deployar/undeployar. Detrás de política
   (profile sin `policy: "readonly"`), con confirmación textual en la descripción de la tool.

## Documentación oficial (partir SIEMPRE de acá)

- **SAP Business Accelerator Hub**: https://api.sap.com → producto "SAP Integration Suite" →
  "Cloud Integration" → APIs OData v2. Ahí está cada entidad, operaciones y ejemplos (hay sandbox).
- **SAP Help Portal**: https://help.sap.com → "SAP Integration Suite" → sección *OData API* de Cloud
  Integration (referencia de entidades, auth y CSRF).
- No inventar entidades ni campos: si algo no está en el Hub/Help **y** en el `$metadata` del tenant,
  no existe para este proyecto.

## Autenticación (prerrequisito)

- OAuth2 `client_credentials` con service key del servicio **Process Integration Runtime, plan `api`**
  (¡no confundir con el plan `integration-flow`, que sirve para invocar iFlows, no para administrarlos!).
- Roles mínimos lectura: `MonitoringDataRead`, `WorkspacePackagesRead`. Para escritura:
  `WorkspacePackagesEdit`, `WorkspaceArtifactsDeploy` (verificar nombres exactos en SAP Help).
- **Estado al 2026-07-28**: Cloud Foundry **ya está habilitado** en la subaccount (lo confirmó el user).
  Falta crear la instancia de Process Integration Runtime **plan `api`** y su service key. Ojo: si ya
  existe una instancia con plan `integration-flow` (para invocar iFlows), ésta es **otra instancia
  hermana**, no se reutiliza. Sin la key del plan `api` no hay Fase 0.
- La service key va en el profile del `systems.json` gitignoreado (clientid, clientsecret, tokenurl, url).

## Fase 0 — Discovery contra el tenant real (antes de escribir tools)

1. Obtener token OAuth y hacer `GET <api-base>/api/v1/$metadata` → inventariar los entity sets
   **realmente disponibles** en esta versión del tenant.
2. Para cada entidad candidata, probar un read mínimo (`?$top=1`) y anotar: campos devueltos,
   paginación, filtros soportados.
3. Dejar el resultado en un `DISCOVERY.md` del repo: es la fuente de verdad de qué se implementa.

Entidades candidatas a verificar (nombres según Hub; confirmar contra `$metadata`):

- `IntegrationPackages` · `IntegrationDesigntimeArtifacts` (download + upload ZIP base64)
- `IntegrationRuntimeArtifacts` (deploy/undeploy/estado) · `BuildAndDeployStatus`
- `MessageProcessingLogs` (+ `$expand` de error/adapter attributes) · `LogFiles`
- `ServiceEndpoints` · `UserCredentials` / `SecureParameters` (solo listar nombres)

## Tools propuestas (ajustar según discovery)

| Tool | Tipo | Nota |
|---|---|---|
| `cpi_ping` | R | token + `$metadata` OK; devuelve versión/entidades detectadas |
| `cpi_packages` | R | listar packages con conteo de artefactos |
| `cpi_iflow_list` / `cpi_iflow_read` | R | metadata y descarga del ZIP de un iFlow |
| `cpi_messages` | R | monitor: filtros por estado/fecha/iflow; default últimas N, paginado |
| `cpi_message_detail` | R | log completo + error text de un MessageGuid |
| `cpi_endpoints` | R | URLs expuestas por los iFlows deployados |
| `cpi_iflow_upload` | W | crear/actualizar artefacto (ZIP base64) — gated |
| `cpi_deploy` / `cpi_deploy_status` | W/R | deploy y polling de `BuildAndDeployStatus` — gated |

## Gotchas conocidos

- OData **v2** (no v4): `$format=json`, paginación con `$top/$skip`, fechas en formato `/Date(...)/`.
- Escrituras requieren **X-CSRF-Token** (fetch con `X-CSRF-Token: Fetch` sobre un GET previo, misma sesión).
- El host de la API puede diferir del host de la UI del tenant (sale de la service key, campo `url`).
- Rate limits y payloads grandes en `MessageProcessingLogs`: siempre limitar y paginar por default.
- Nunca exponer ni loggear clientsecret/token; nunca devolver contenido de credenciales del tenant.

## Arquitectura: transporte desacoplado (leer ANTES de scaffoldear)

v1 es **MCP local (stdio)** y no hay que escribir el entrypoint HTTP todavía. Pero sí hay que dejar la
**costura**: las tools no conocen el transporte. Nada de stdio/HTTP dentro de `src/tools/`.

Layout:

```
src/
  server.js      -> createServer(deps): registra tools, devuelve el McpServer. NO conoce transporte
  tools/         -> una tool por archivo: inputSchema, jsonSchema, handler(args, ctx), definition
  core/          -> cliente OData (auth + CSRF + sesión) y ops/ (orquestación)
  config/
    local.js     -> systems.json + env CPI_PROFILE          (v1)
    btp.js       -> VCAP_SERVICES / Destination service      (solo si llega la Fase 2)
bin/
  stdio.js       -> createServer + StdioServerTransport      (v1, único entrypoint a escribir)
  http.js        -> express + StreamableHTTPServerTransport  (NO escribir en v1)
```

**Firma de los handlers — la decisión que hay que tomar bien desde el día uno:**

`mcp-sap` usa `makeHandler(client)`, que captura el cliente en un closure **al arrancar el proceso**.
Sirve para stdio (un proceso = un usuario = una config), pero ata el server a una sola identidad. Para
mantener la costura, en `mcp-cpi` el contexto viaja **por invocación**:

```js
// en vez de: makeHandler(client) -> (args) => ...
// usar:      handler(args, ctx)  -> ctx = { client, policy, identity }
```

Es una línea por tool si se hace ahora; una refactorización completa si se hace después. Todo lo demás
del patrón `mcp-sap` (schemas zod `.strict()`, `{ content: [...] }` / `{ isError: true }` sin `throw`,
ANNOTATIONS, capas, errores con hints) se respeta igual.

Diferencias que resuelve esta costura, para entender por qué importa:

1. **Credenciales**: local desde `systems.json`; BTP desde `VCAP_SERVICES`/Destination. Misma forma de
   config, distinto loader.
2. **Sesión e identidad**: stdio = 1 proceso, 1 usuario, 1 config. HTTP = N sesiones concurrentes, cada
   una con su token y sus permisos → el server se crea por sesión y el `ctx` viaja por invocación.
3. **Logging y ciclo de vida**: en stdio `stdout` está prohibido (canal JSON-RPC); en HTTP se suman
   health endpoint, graceful shutdown y limpieza de sesiones. Mantener siempre el logging por `stderr`.

## Fase 2 — despliegue remoto en BTP (opcional, posterior a v1)

Solo si aparece una razón concreta: que lo use más gente del equipo, o correrlo sin la laptop del
consultor. **No hacerlo "porque se puede"**: un MCP remoto es una URL en internet con las tools de
escritura de este plan (subir y deployar iFlows en el tenant de un cliente).

Piezas necesarias:

| Pieza | Para qué |
|---|---|
| **Cloud Foundry Runtime** con quota de memoria | Correr el server como app (buildpack Node). Verificar entitlements disponibles |
| **Transporte streamable HTTP/SSE** en el server | Reemplaza a stdio. Es la razón del requisito de diseño de arriba |
| **XSUAA** (Authorization & Trust Management) | OAuth2: quién puede invocar el MCP. **Obligatorio desde el día uno** |
| **Destination service** / **Credential Store** | Las credenciales dejan de venir de `systems.json` local |
| **Cliente MCP con soporte remoto + OAuth** | Verificar que la versión de Claude Code / claude.ai en uso lo soporte |

Reglas para la versión remota:

- Las tools de escritura (`cpi_iflow_upload`, `cpi_deploy`) **quedan fuera** o detrás de un scope OAuth
  propio y distinto del de lectura.
- Nunca desplegar sin XSUAA, ni con credenciales embebidas en la app.

**Alternativa a evaluar antes de construir esto**: el **MCP Gateway** de SAP Integration Suite (y el
MCP Hub, con GA anunciada para H1 2026) permite exponer APIs/iFlows como tools MCP gobernadas sin
hostear nada propio. Verificar si ya está disponible en el tenant: si lo está, puede cubrir la parte
CPI y dejar el desarrollo propio solo para el PI.

## Definición de terminado

- `DISCOVERY.md` con endpoints verificados contra el tenant real.
- Tools implementadas solo sobre lo verificado; las W gated por policy.
- `CLAUDE.md` del server con guía de uso (estilo mcp-sap).
- Registrado por proyecto en el workspace que lo use (`.mcp.json`).
- Prueba de humo end-to-end documentada: ping → listar packages → leer el iFlow `test` → últimos mensajes.
