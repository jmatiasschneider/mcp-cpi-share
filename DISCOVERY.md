# DISCOVERY — cómo se comporta el API del tenant

Resultado de la Fase 0. **Fuente de verdad de qué se implementa.** Nada entra acá sin haber sido
verificado contra un tenant real (uno de DEV/QAS, región `cf.br10`, plan Cloud Foundry).

- API base: `https://<tenant>.it-cpi<nnn>.cfapps.<region>.hana.ondemand.com/api/v1`
- Host UI (**distinto**): `<tenant>.integrationsuite.cfapps.<region>.hana.ondemand.com`
- Scripts: `npm run discover` · `node scripts/probe-entities.js` · `node scripts/probe-navigation.js`
- Última corrida de esas tres sondas: 2026-07-30. **El documento sigue creciendo después de esa fecha**:
  cada sección de abajo dice contra qué se verificó y cuándo.

🔴 **Acá va cómo se comporta el API, no cómo se migra una interfaz.** El proyecto de migración
PI/PO → Integration Suite —arquetipos, mapeos del ESR, la pata contra el ABAP, el inventario del
parque— vive en su propio workspace. Si un hallazgo sirve para **construir una tool**, es de acá; si
sirve para **migrar una interfaz**, es de allá.

## Estado

| Chequeo | Resultado |
|---|---|
| OAuth2 `client_credentials` | ✅ token OK, `bearer`, `expires_in=43199` (~12 h) |
| `GET /api/v1/$metadata` | ✅ HTTP 200 — plan **`api`** confirmado |
| EntitySets declarados en `$metadata` | 131 |
| EntitySets **consultables de primer nivel** | **7** (ver abajo) |
| Lectura verificada por navegación | ✅ diseño, runtime, monitor |
| CSRF en escrituras con Bearer | ✅ **no hace falta** (2026-07-30, ver *Escritura — contrato verificado*) |
| Invocar un iFlow para probarlo | ✅ desde el 2026-08-04, con la key del plan `integration-flow` |

## Contenido actual del tenant

⚠️ **Un tenant de desarrollo no es un banco libre.** El tenant donde se verificó esto tiene packages
de otras personas y artefactos deployados a propósito. Los smoke tests que escriben crean y borran
lo suyo (package `DEVtest`, Ids `zz_*`); nada de lo ajeno se toca. Varias secciones de abajo se
verificaron **contra artefactos reales de otros**, leyéndolos: eso es lectura, y está dicho caso
por caso.

Lo que los smoke tests dan por existente —la foto original del 2026-07-30, que sigue valiendo—:

| Qué | Valor |
|---|---|
| Packages | 1: `DEVtest` ("DEV test"), `Mode=EDIT_ALLOWED` |
| iFlows | 1: `test` (dentro de `DEVtest`) — desde el 2026-08-12 con el mapping importado del ESR |
| Artefactos deployados | 1: `test` |
| Mensajes procesados | ≥1, el último `COMPLETED` sobre el iFlow `test` |
| `ServiceEndpoints` | 0 — el iFlow `test` no expone endpoint HTTP |
| `UserCredentials` | 1 |
| `KeystoreEntries` | 14 |
| DataStores / Variables / SecureParameters | 0 |

## 🔑 Hallazgo estructural: la API es un grafo, no 131 colecciones

Los 131 EntitySets del `$metadata` **no son 131 endpoints consultables**. La mayoría responde
`501 Not implemented` si la pedís directo, y solo se alcanza **navegando** desde un puñado de puntos de
entrada. El propio API lo dice cuando le pegás a `MessageProcessingLogRuns`:

> `500 — Only retrievable via navigation from MessageProcessingLogs entity`

Y `$metadata` incluso **sobre-declara**: `IntegrationFlows` figura ahí pero da `404 Could not find an
entity set`. Conclusión operativa: **ni la doc ni `$metadata` alcanzan — hay que probar cada path.**

**Puntos de entrada reales (200 en query directa):**

| EntitySet | Campos | Notas |
|---|---|---|
| `IntegrationPackages` | 30 | raíz de todo el diseño |
| `IntegrationRuntimeArtifacts` | 7 | lo que está deployado |
| `MessageProcessingLogs` | 31 | raíz de todo el monitoreo |
| `UserCredentials` | 7 | ⚠️ ver advertencia abajo |
| `KeystoreEntries` | 23 | rechaza `$format=json` |
| `SecureParameters`, `DataStores`, `Variables`, `ServiceEndpoints` | — | 200 pero 0 registros hoy |

**Mapa de navegación verificado:**

```
IntegrationPackages('DEVtest')
  ├─ IntegrationDesigntimeArtifacts        -> 13 campos, incluye ArtifactContent (ZIP base64)
  │    ├─ Resources                         (archivos internos del iFlow; /$value da el contenido)
  │    ├─ Configurations                    (parámetros externalizados)
  │    └─ DesignGuidelineExecutionResults
  ├─ MessageMappingDesigntimeArtifacts     (0 al 2026-07-30; desde el 2026-08-08 hay MM_TEST_TRIVIAL)
  ├─ ScriptCollectionDesigntimeArtifacts   (0 al 2026-07-30)
  └─ ValueMappingDesigntimeArtifacts       (0 al 2026-07-30)

IntegrationRuntimeArtifacts('test')
  └─ ErrorInformation                       -> la navegación pelada da 404 SIEMPRE, también con
                                               Status=ERROR. El detalle sale de .../ErrorInformation/$value
                                               con Accept: application/xml (2026-08-10, ver abajo)

MessageProcessingLogs('<guid>')
  ├─ Runs                                   -> Id, RunStart, RunStop, LogLevel, OverallState, ProcessId
  │    └─ RunSteps                          (traza paso a paso — el camino del debug trace)
  ├─ ErrorInformation                       -> 204 No Content si el mensaje no falló
  ├─ AdapterAttributes
  ├─ CustomHeaderProperties
  ├─ MessageStoreEntries
  └─ Attachments
```

## Campos que importan

**`IntegrationDesigntimeArtifacts`** (el iFlow):
`Id, Version, PackageId, Name, Description, Sender, Receiver, CreatedBy, CreatedAt, ModifiedBy, ModifiedAt, ArtifactContent, Comment`

`ArtifactContent` es el **ZIP del iFlow en base64**. Es a la vez el camino de lectura y el de creación.

**`MessageProcessingLogs`** (31 campos, los útiles para filtrar):
`MessageGuid, CorrelationId, ApplicationMessageId, LogStart, LogEnd, Sender, Receiver, IntegrationFlowName, Status, LogLevel, CustomStatus, TransactionId, AlternateWebLink`

**`IntegrationRuntimeArtifacts`**: `Id, Version, Name, Type, DeployedBy, DeployedOn, Status`

## Gotchas verificados (van al CLAUDE.md)

1. **`$top` no es universal.** `DataStores`, `DataStoreEntries`, `Variables`, `UserCredentials` y
   `SecureParameters` responden `400/501 — The query option $top is not supported`.
2. **`$format=json` tampoco.** `KeystoreEntries` lo rechaza explícitamente. **Regla: pedir JSON por el
   header `Accept: application/json`, nunca por `$format`.** Funcionó en el 100% de los casos.
3. **`204 No Content`** es respuesta normal en navegaciones vacías (`…/ErrorInformation` de un mensaje
   OK). El cliente tiene que tratarlo como "vacío", no como error.
4. **403 sin mensaje** en `IntegrationDesigntimeLocks`, `AuditLogs`, `CustomTagConfigurations` — faltan
   scopes. El body viene con `"value": null`, así que el error hay que inferirlo del código.
5. **`⚠️ UserCredentials devuelve un campo `Password`.** El registro incluye
   `Name, Kind, Description, User, Password, CompanyId, SecurityArtifactDescriptor`. La tool **debe
   proyectar explícitamente** (`$select=Name,Kind,Description,User`) y nunca reenviar el registro crudo.
   Whitelist, no blacklist.

## Anatomía del ZIP de un iFlow (verificado sobre `test`)

Descarga: `GET IntegrationDesigntimeArtifacts(Id='test',Version='active')/$value` → `200 application/zip`,
4.661 bytes. **Ojo: `/$value` devuelve el binario; sin `/$value` devolvés el registro JSON.**

```
src/main/resources/scenarioflows/integrationflow/test.iflw   22.462 B  BPMN2 + extensiones <ifl:property>
src/main/resources/parameters.prop                               30 B  valores de params externalizados
src/main/resources/parameters.propdef                            98 B  definición de esos params
.project                                                        476 B  descriptor de proyecto Eclipse
META-INF/MANIFEST.MF                                          1.900 B  manifiesto OSGi
metainfo.prop                                                    70 B  description
```

**`META-INF/MANIFEST.MF` es un bundle OSGi**, no un archivo de metadata trivial:

```
Bundle-SymbolicName: test; singleton:=true
Bundle-Version: 1.0.0
SAP-BundleType: IntegrationFlow
SAP-NodeType: IFLMAP
SAP-RuntimeProfile: iflmap
Import-Package: <~1.5 KB de paquetes Camel/CXF/SAP ESB>
```

> **Conclusión de diseño: no generar iFlows desde cero.** El `Import-Package` es una lista larga de
> internals de Camel/CXF que no tiene sentido sintetizar. El patrón correcto es **clonar y mutar**:
> partir de un iFlow válido como esqueleto, reemplazar el `.iflw` y ajustar `Bundle-Name` /
> `Bundle-SymbolicName` / `.project`. Encaja perfecto con una migración PI/PO, donde hay N interfaces
> parecidas a partir de pocos arquetipos.

## Cómo se dispara un iFlow — y qué se puede probar sin la key de `integration-flow`

> **Actualizado el 2026-08-04:** la key del plan `integration-flow` llegó y está verificada, y el
> `test` se rehízo con sender HTTPS. Lo de abajo describe cómo era antes; sigue valiendo como
> referencia de qué se puede hacer **sin** esa key. El resultado nuevo está al final de la sección.

El iFlow `test` resultó ser **timer-triggered**, no HTTP-triggered:

```
bpmn2:startEvent "Start Timer 1"  (StartTimerEvent + timerEventDefinition)
   └─> CallActivity  activityType=ExternalCall
         adapter HTTP, direction=Receiver, httpMethod=GET   <- llama HACIA AFUERA
   + 2 Enrichers (Content Modifier)
```

El adapter HTTP es **Receiver** (saliente), no Sender. Por eso `ServiceEndpoints` da 0 registros: este
iFlow no expone ningún endpoint entrante. Los dos hallazgos son consistentes.

**Implicancia:** la key del plan `integration-flow` hace falta **solo para iFlows con sender HTTP/SOAP**.
Para los disparados por timer, file/SFTP, JMS o IDoc — buena parte de una migración PI/PO — el ciclo
`deployar → esperar/disparar → leer MessageProcessingLogs` funciona **solo con la key del plan `api`**.

| Paso del ciclo | Estado |
|---|---|
| Crear / actualizar iFlow | ✅ `ArtifactContent` (ZIP base64) |
| Deployar | ✅ scopes `NodeManager.deploycontent` + `GenerationAndBuild…` |
| Disparar — iFlow **timer / file / JMS / IDoc** | ✅ se dispara solo o por su mecanismo propio |
| Disparar — iFlow **sender HTTP/SOAP** | ✅ desde el 2026-08-04, con la key del plan `integration-flow` |
| Leer resultado y traza | ✅ `MessageProcessingLogs(guid)/Runs/RunSteps` |
| Activar `LogLevel=Trace` por API | ❌ no se puede: se prende a mano en la UI (ver seccion de payloads) |
| Leer el payload de cada paso | ✅ con el run en TRACE, via `RunSteps/TraceMessages/$value` — pero el payload **caduca antes que el MPL** (ver abajo) |

### Invocar un iFlow — verificado end-to-end el 2026-08-04 (`scripts/probe-invoke.js`)

El `test` se rehízo con **sender HTTPS**, y la cadena completa quedó probada:

```
key plan integration-flow  ->  POST /oauth/token          -> Bearer
GET https://<tenant>.it-cpi008-rt.cfapps.<region>…/http/iflowtest
  -> el iFlow llama al backend (Receiver HTTP, Basic)
  -> HTTP 200, 31 KB de $metadata OData
```

Tres cosas que no eran obvias:

1. **El host del runtime es otro**: `it-cpi008-rt.cfapps…` contra `it-cpi008.cfapps…` del API de
   administración. Sale del campo `url` de la key del plan `integration-flow`.
2. **La ruta es `/http/<address>`**, donde `<address>` sale de `ServiceEndpoints` con la forma
   `<id>$endpointAddress=<address>` — hay que partir por el `=`, no es el Id del iFlow.
   Fila real, leída el 2026-08-05 (antes la entidad tenía 0 registros):

   ```json
   { "Name": "test", "Id": "test$endpointAddress=iflowtest", "Title": "test",
     "Version": "1.0.0", "Protocol": "REST" }
   ```

   El dato viaja en **`Id`**, no en un campo propio. `resolveEndpoint()` igual barre todos los
   campos string de la fila en vez de leer `Id`: si SAP lo mueve de campo, lo sigue encontrando.
3. **Los scopes de esa key son otro xsappname**: `it-rt-<tenant>!b106.ESBMessaging.send`, no
   `it!b106.…`. Comparar por sufijo, no por string completo.

**Cuarta, verificada el 2026-08-05 con `cpi_invoke`: el puente al monitor se corta justo cuando falla.**
En una invocación exitosa vuelven headers de correlación, pero en una fallida **no vino
`sap-messageprocessinglogid`** — el guid llegó adentro del cuerpo del error:

```
HTTP 500, content-type: text/plain
An internal server error occured: The MPL ID for the failed message is : AGpyvUXKUZJ-xCKXdYXps-l8FDTq
```

Es decir: el dato que más se necesita para diagnosticar aparece en el único lugar donde nadie lo
busca. `cpi_invoke` lo extrae del cuerpo cuando el header no está.

### ⚠️ La ruta NO es siempre `/http/` — un sender SOAP va por `/cxf/` (2026-08-27)

`/http/` alcanzó mientras todos los senders probados fueron HTTPS. Con el primer sender **SOAP 1.x**
—`ZMOLDE_ARQ1_CLEARINGS`— la misma construcción falla:

```
GET  <runtime>/http/<address>   -> 404, HTML de Tomcat        (iFlow STARTED, sin MPL)
POST <runtime>/cxf/<address>    -> responde el iFlow
```

**El runtime tiene dos servlets y el sender decide cuál lo atiende:** los SOAP los sirve CXF, los
HTTPS/REST el de `http`. Lo que hacía falta para elegir ya venía en la fila y se estaba tirando:

```json
{ "Name": "ZMOLDE_ARQ1_CLEARINGS", "Id": "ZMOLDE_ARQ1_CLEARINGS$endpointAddress=…",
  "Protocol": "SOAP" }
```

⚠️ **Este 404 es de los caros de diagnosticar**, porque miente en las dos direcciones: viene del
Tomcat, así que el iFlow ni se entera y **no queda nada en el MPL**, mientras `cpi_deployed` muestra
el artefacto perfectamente `STARTED`. Leído sin sospechar del servlet parece "el iFlow no está
escuchando" y se sale a revisar un deploy que está sano.

`prefixForProtocol()` en `core/runtime-client.js` mapea `SOAP → cxf` y todo lo demás a `http`.
**Solo `SOAP` está verificado**: un protocolo desconocido cae en `http` para no romper lo que ya
andaba, y el texto del 404 de `cpi_invoke` nombra el otro prefijo para que el próximo caso se note
en un intento y no en una sesión.

En `cpi_invoke` el parámetro `address` acepta el prefijo escrito a mano (`cxf/<address>`), y cuando
viene, manda sobre el protocolo: es la forma en que se copia una URL de la UI, y volver a prefijar
daría `/http/cxf/…`.

### ⚠️ El CSRF del **sender adapter** sí existe — no confundirlo con el del API

El mismo `test`, mismo token, mismo endpoint:

```
GET  /http/iflowtest   -> 200 OK
POST /http/iflowtest   -> 403 Forbidden (HTML de Tomcat, sin cuerpo JSON)
```

No es un problema de rol: el sender tenía `senderAuthType=RoleBased` y `userRole=ESBMessaging.send`,
que es exactamente lo que trae la key. Lo que lo rechaza es **`xsrfProtection=1`** en el sender
adapter, que exige `X-CSRF-Token` para los métodos que modifican.

**Esto NO contradice la sección siguiente**, contradice leerla de más: el API de administración no
pide CSRF, pero cada sender adapter del runtime trae su propia protección, configurable por iFlow.
Un `403` con cuerpo HTML al invocar es CSRF; un `403` por rol viene distinto.

Para invocar con POST hay dos caminos: apagar `xsrfProtection` en el sender (razonable para un
consumidor máquina-a-máquina que ya se autentica por OAuth), o hacer el handshake — `GET` con
`X-CSRF-Token: Fetch`, guardar token y cookies, y mandarlos en el `POST`.

**El handshake quedó verificado el 2026-08-05** con `xsrfProtection=1` prendido en el sender del
`test`. El intercambio completo:

```
POST /http/iflowtest  (sin CSRF)     -> 403,  X-CSRF-Token: required  + HTML de Tomcat + 3 cookies
GET  /http/iflowtest  X-CSRF-Token: Fetch -> 200, X-CSRF-Token: <tok> + 3 cookies
POST /http/iflowtest  con <tok> + cookies -> 200, 31 KB
```

**El `403` trae `X-CSRF-Token: required` en los headers.** Esa es la señal para distinguirlo de un
`403` por rol — el cuerpo HTML no alcanza, porque un rechazo por rol también puede venir en HTML y
dispararía un handshake al pedo. `RuntimeClient.isCsrf()` mira el header primero.

**Implicancia para el arquetipo:** ya no hace falta elegir. El MCP funciona con `xsrfProtection`
prendido o apagado, así que la decisión pasa a ser de seguridad y no de herramienta.

### El puente al monitor se corta justo cuando sale bien

Verificado el 2026-08-05: de una invocación **exitosa** no se puede llegar al MPL.

| Caso | Qué vuelve | Sirve para llegar al MPL |
|---|---|---|
| Invocación **fallida** | el guid en el **cuerpo** del error | ✅ `cpi_message_detail(messageGuid=…)` |
| Invocación **exitosa** | solo `x-correlationid` | ❌ no matchea `CorrelationId` **ni** `MessageGuid` |

El `x-correlationid` es un uuid interno del runtime; los guids del MPL son formato `AGpy…`. Se
comparó contra los mensajes reales del iFlow y no matchea ningún campo.

**Único camino en el caso exitoso: iFlow + ventana de tiempo.** Por eso `cpi_invoke` devuelve el
timestamp del disparo y sugiere `cpi_messages(iflow=…, since=<ts>)`, que sí devuelve el run exacto
(verificado: 1 de 1).

## Payloads y LogLevel=Trace — verificado el 2026-08-04 (`scripts/probe-trace-cycle.js`)

Respuesta en dos mitades, y son opuestas.

### Prender el Trace por API: NO se puede

De los 131 entity sets no hay **ninguno** de configuración de log. `LogLevel` existe solo como
propiedad **de lectura** en `MessageProcessingLog` y `MessageProcessingLogRun`: informa con qué nivel
corrió el mensaje, no lo cambia. `ExternalLoggingActivationStatus` es otra cosa (logging externo).

Se prende a mano: **Monitor → Manage Integration Content → el iFlow → Log Level = Trace**. Caduca
solo (~1 h) y **no es retroactivo**: los runs anteriores no se recuperan.

> Alcance de la afirmación: vale para esta API OData. Que no exista otra vía fuera de ella no está
> verificado.

### Leer los payloads por API: SÍ

Con el run en `TRACE`, la cadena completa —cada eslabón verificado con 200:

```
MessageProcessingLogs('<guid>')/Runs
  -> MessageProcessingLogRuns('<runId>')/RunSteps
    -> MessageProcessingLogRunSteps(<clave compuesta>)/TraceMessages
      -> TraceMessages(<id>L)/$value        <- el payload crudo
```

Dos trampas:

1. **La clave del RunStep es compuesta** y no se arma a ojo. Sale del `__metadata.uri` que viene en
   cada fila; hay que recortarlo desde `MessageProcessingLogRunSteps`.
2. **`TraceMessages` necesita el sufijo `L`** del literal `Edm.Int64`: `TraceMessages(104L)`, no
   `TraceMessages(104)`.

Detalles de la corrida real sobre `test` (6 steps): `EndEvent_2` trajo los 31.607 bytes de la
respuesta, `MessageFlow_23` el mismo contenido en otro punto, y los demás 0 bytes porque un `GET` no
lleva cuerpo. El `MimeType` viene como `application/octet-stream` aunque el contenido sea XML: **no
sirve para decidir cómo parsear.**

Sin Trace, `…/Attachments` y `…/MessageStoreEntries` responden 200 con 0 filas — existen, están
vacías. Con un paso **Persist** en el modelo, `MessageStoreEntries` sí guarda el payload de forma
permanente y sin depender del nivel de log.

#### ⚠️ `LogLevel=TRACE` en el MPL **no** garantiza que el payload siga estando (2026-08-11)

El payload se purga **antes** que el MPL, así que un run viejo queda marcado `TRACE` y sin
contenido. Verificado sobre `IF_Ventas`, run de 10 pasos con `LogLevel=TRACE`, **12 h
después** de ejecutado:

```
MessageProcessingLogRunSteps(RunId='AGp5-tB-…',ChildCount=10)/TraceMessages
  -> 200  {"d":{"results":[]}}     en los 10 pasos
```

**Y la navegación no avisa.** Devuelve 200 con lista vacía, exactamente igual que un paso que de
verdad no llevaba cuerpo. Es un falso negativo perfecto: leído sin contexto, un run entero vacío
dice "el mensaje iba sin datos" en vez de "la traza caducó".

Por eso `cpi_trace` **cuenta las trazas y el nivel de log por separado**, y distingue los dos
casos en el texto: "ningún run corrió en TRACE" manda a prender el Trace; "corrió en TRACE y no
quedó ninguna traza" manda a volver a ejecutar. Decir el primero cuando pasa el segundo mandaría
a arreglar una configuración que ya estaba bien.

> Alcance: lo verificado es que a las 12 h ya no estaban, y que el 2026-08-10 sí estaban minutos
> después de la corrida. **La ventana exacta de retención no está medida** — no asumir un número.

Lo que sí quedó confirmado en esa misma corrida es la **navegación**: la key compuesta que sale
del `__metadata.uri` es de la forma `MessageProcessingLogRunSteps(RunId='…',ChildCount=10)` —dos
campos, no los cuatro que uno adivinaría— y el tenant la acepta tal cual.

#### La cadena entera, re-verificada con `cpi_trace` (2026-08-11)

Verificada **en las dos direcciones**, con el Trace recién prendido en `test`:

| Qué se leyó | Cómo | Resultado |
|---|---|---|
| La **entrada** | `POST` de 100 bytes por `cpi_invoke` | `TraceMessages(414L)/$value` devolvió los mismos 100 bytes, byte por byte |
| La **salida** | `GET` con el receiver andando | `TraceId=432` en `EndEvent_2` con los **31.607 bytes** del `$metadata` del backend |

La tool cierra el círculo sin salir del MCP: invocar, encontrar el MPL, bajar el payload de cada
paso.

Dos cosas que la corrida dejó claras y que el probe del 2026-08-10 no mostraba:

- **En un mismo run conviven trazas con cuerpo y sin cuerpo**, y las de 0 bytes no son un fallo:
  dependen del punto del flujo. Ese run tuvo cuatro trazas de 100 bytes y dos de 0.
- **El `MimeType` sigue siendo `application/octet-stream` para XML plano.** Confirmado por segunda
  vez: no sirve para decidir cómo parsear, y por eso `isBinary()` mira el contenido.

**Y la mitad de entrada se puede verificar sin el backend.** Mientras el receiver daba 503 la
entrada se trazó igual, así que mandar un cuerpo propio por `POST` alcanza para probar la cadena
cuando el otro extremo no contesta.

#### Un `503` del receiver es el Cloud Connector, no el backend

Síntoma, tal como llega al MPL:

```
HTTP operation failed invoking
http://backend-dev:443/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/$metadata with statusCode: 503
```

**`backend-dev` es el host virtual del Cloud Connector**, no un hostname real, así que el 503 habla
del camino y no del sistema. Con el ECC DEV online el error seguía; **la causa era el Cloud
Connector apagado**.

⚠️ **Y prenderlo no alcanza en el mismo instante**: después de arrancarlo hubo dos invocaciones más
con 503 antes de que el túnel quedara arriba y la tercera diera 200. O sea que un 503 recién
prendido el CC **no significa que la configuración esté mal** — conviene reintentar antes de salir
a diagnosticar nada.

## Paginación — qué acepta cada entidad (verificado el 2026-08-04)

| Entidad | `$top` | `$skip` | `$inlinecount=allpages` |
|---|---|---|---|
| `IntegrationPackages` | ✅ | ✅ | ❌ `501 "$count is not supported"` |
| `IntegrationPackages(…)/…DesigntimeArtifacts` | ✅ | ⚠️ **se ignora en silencio** | ❌ se ignora |
| `IntegrationRuntimeArtifacts` | ✅ | ✅ | ❌ |
| `MessageProcessingLogs` | ✅ | ✅ | ✅ devuelve `d.__count` |

### ⚠️ En las navegaciones, `$skip` se ignora sin avisar

Con **un solo** artefacto en el package:

```
IntegrationPackages('DEVtest')/IntegrationDesigntimeArtifacts?$top=1&$skip=1
  -> 200, 1 fila   (deberia ser 0)
```

No devuelve error: devuelve la primera página otra vez. Paginar ahí confiando en `$skip` daría un
bucle infinito silencioso. **Por eso `listArtifacts` pagina del lado del cliente**: trae todo lo del
package y corta con `slice`. El costo es traer decenas de filas; la ventaja es que el total es exacto.

### Cómo saber si hay más

Tres estrategias distintas, una por entidad, según lo que cada una permita:

- `MessageProcessingLogs` → `$inlinecount=allpages` y leer `d.__count`. Total exacto.
- `IntegrationPackages` → pedir `$top = top + 1` y descartar el sobrante. Da un `hasMore` fiable
  sin total.
- Navegaciones → traer todo y cortar en memoria. Total exacto.

Lo que **no** hay que hacer es inferir "puede haber más" de `filas === top`: miente cuando la última
página cae justa. La primera versión de `more()` en `_render.js` hacía eso; se reemplazó por
`paging()`, que solo informa hechos.

## Escritura — contrato verificado (`scripts/probe-write-csrf.js`)

### ❗ El CSRF **NO** es requerido con autenticación Bearer

```
POST /IntegrationDesigntimeArtifacts   sin ningún header X-CSRF-Token
  -> HTTP 201 Created
```

Probado en vivo: el artefacto se creó al primer intento, sin token de CSRF y sin cookie de sesión. La
respuesta ni siquiera trae un header `x-csrf-token`. **Esto contradice al PLAN y a la doc general de
SAP**, que asumen CSRF obligatorio para toda escritura — esa doc aplica a la autenticación por sesión
con cookie, no a OAuth Bearer.

Implicancia de diseño: el cliente HTTP **no necesita cookie jar ni fetch previo de CSRF**. Se simplifica
bastante respecto de `mcp-sap`. Se mantiene igual el manejo defensivo de `403 + X-CSRF-Token: Required`
(refetch + un reintento) por si SAP cambia de opinión en alguna operación: cuesta poco y evita un fallo
silencioso.

### Contrato de creación

```http
POST /api/v1/IntegrationDesigntimeArtifacts
Authorization: Bearer <token>
Content-Type: application/json

{ "Id": "...", "Name": "...", "PackageId": "...", "ArtifactContent": "<zip en base64>" }
```

- Devuelve **`201`** con la entidad creada. **SAP asigna `Version='1.0.0'`**, no `active`.
- Para leer/borrar después se usa `Version='active'`: `DELETE IntegrationDesigntimeArtifacts(Id='…',Version='active')` → **`200`**.
- El ZIP subido tenía `Bundle-SymbolicName: test` mientras el `Id` era `zz_mcp_probe`, y **SAP lo aceptó
  igual**: en designtime no valida el manifiesto contra el Id. ⚠️ **La sospecha de que fallaría en
  deploy quedó refutada el 2026-08-10**: el deploy también lo acepta y el iFlow anda. Lo que sí rechaza
  es el `PUT`. Ver *"`Bundle-SymbolicName`: inmutable después de crear"* más abajo.

### ⚠️ Los errores de negocio vienen como HTTP 500

```
POST con un Id que ya existe
  -> HTTP 500  "An integration flow zz_mcp_probe with the artifact ID zz_mcp_probe already exists
                in the DEV test package. To create /upload an integration flow, use a different ID."
```

No es `409 Conflict`. **`500` no significa "error transitorio, reintentá"** en esta API: el mensaje útil
viene en `error.message.value` y hay que mostrarlo tal cual al usuario. Nunca reintentar un 500 a ciegas.

## FunctionImports disponibles (del `$metadata` del tenant)

| FunctionImport | Parámetros | Uso |
|---|---|---|
| `DeployIntegrationDesigntimeArtifact` | `Id`, `Version` | deployar |
| **`ValidateIntegrationDesigntimeArtifact`** | `Id`, `Version` | **validar sin deployar** |
| `ExecuteIntegrationDesigntimeArtifactsGuidelines` | `Id`, `Version` | chequeo de design guidelines |
| `IntegrationDesigntimeArtifactSaveAsVersion` | `Id`, `SaveAsVersion` | versionar |
| `CopyIntegrationPackage` | — | clonar un package entero |
| `CancelMessageProcessingLog` | `Id` | cancelar un mensaje en curso |
| `activateExternalLogging` / `deactivateExternalLogging` | — | logging **externo**, NO es el LogLevel del iFlow |

`ValidateIntegrationDesigntimeArtifact` habilita un loop **generar → validar → corregir** sin ensuciar el
runtime. Es la pieza más valiosa para la migración.

## Contrato documentado (help.sap.com, cruzado con el tenant)

- **Actualizar**: `PUT IntegrationDesigntimeArtifacts(Id='…',Version='active')` con `{Name, ArtifactContent}`.
- **Parámetros externalizados**: `PUT IntegrationDesigntimeArtifacts(Id,Version)/$links/Configurations('<ParameterKey>')`
  con `{ParameterValue, DataType}`. Soporta **batch** (`multipart/mixed` + changeset).
- **Recursos internos** (XSLT, Groovy…): `POST IntegrationDesigntimeArtifacts(Id,Version)/Resources`
  con `{Name, ResourceType, ResourceContent}` en base64. `Name` y `ResourceType` no pueden ser null.

> `api.sap.com` y `help.sap.com` son SPAs: `WebFetch` devuelve vacío. Hay que leerlas con browser.

## Ciclo clonar-y-configurar — verificado (`npm run smoke:write`)

Corrido end-to-end el 2026-07-30 sobre `test` → `zz_clone_probe`, con limpieza confirmada:

| Paso | Resultado |
|---|---|
| Clonar reescribiendo `MANIFEST.MF` + `.project` | ✅ bundle de 4.552 B, 6 archivos, `Import-Package` intacto |
| Releer el clon y auditar el manifiesto | ✅ `Bundle-Name` / `Bundle-SymbolicName` apuntan al Id nuevo, sin rastro del original |
| Leer `Configurations` | ✅ `SAP_ProfileId` |
| `PUT …/$links/Configurations('…')` | ✅ |
| **`ValidateIntegrationDesigntimeArtifact`** | ✅ **`Check execution result: Passed`** |
| `DELETE …(Version='active')` | ✅ sin residuos en el package |

La validación del propio tenant sobre un bundle rearmado por `src/core/zip.js` es la prueba de que el
escritor de ZIP produce artefactos que CPI acepta — más fuerte que verificar que el ZIP sea legible.

## Deploy y undeploy — verificado (`npm run smoke:deploy`)

Ciclo completo el 2026-07-30 sobre `zz_deploy_probe`, clonado de `test`:

```
clonar -> validar -> deployar -> ejecutar -> leer el log -> undeploy -> borrar
```

### Contrato

| Operación | Contrato |
|---|---|
| Deployar | `POST DeployIntegrationDesigntimeArtifact?Id='…'&Version='active'` → devuelve un **TaskId** (GUID) en texto plano |
| Estado del build | `GET BuildAndDeployStatus(TaskId='…')` → `{TaskId, Status}`. **Solo funciona con la key**: como colección da 501 |
| **Undeploy** | `DELETE IntegrationRuntimeArtifacts('<id>')`. **No hay FunctionImport de undeploy** en el `$metadata` |

El undeploy **no** borra el artefacto de designtime: queda para redeployar.

### ⚠️ Estados transitorios — la trampa

Ambos recursos pasan por estados intermedios antes de asentarse:

```
BuildAndDeployStatus:  DEPLOYING  ->  SUCCESS
Runtime (Status):      STARTING   ->  STARTED
                       STOPPING   ->  (desaparece)
```

**Tratar `DEPLOYING`/`STARTING` como finales produce falsos errores.** El primer probe reportó "el
artefacto no quedó en STARTED" sobre un deploy que estaba arrancando perfectamente, y "quedó basura en
el tenant" sobre un undeploy que estaba saliendo bien. Hay que **esperar dos veces**: primero a que el
task salga de `DEPLOYING`, después a que el runtime salga de `STARTING`. Resuelto en `waitForDeploy()` y
`waitForRuntime()` de `ops/write.js`.

### Otros hallazgos

- El bundle rearmado por `src/core/zip.js` **deploya y ejecuta**, no solo valida.
- El iFlow `test` tiene el timer en `fireNow=true`, `noOfSchedules=1` (**Run Once**): dispara una vez al
  deployar. No es recurrente.
- El deploy **sí** acepta un `Bundle-SymbolicName` reescrito por nosotros. Y el 2026-08-10 se cerró el
  otro caso: uno **mal etiquetado** —símbolo que no coincide con el `Id`— también deploya y funciona.
  El tenant nunca compara los dos; ver la sección de `Bundle-SymbolicName` más abajo.

## ⚠️ El backend ABAP (`backend-dev`, host virtual del Cloud Connector) falla de forma intermitente

El iFlow `test` (y por lo tanto cualquier clon suyo) llama a:

```
http://backend-dev:443/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/$metadata
```

y recibe **401 de forma intermitente**: de dos ejecuciones del clon el 2026-07-30, una dio `FAILED`
y la otra `COMPLETED`. El texto del error sale por
`MessageProcessingLogs('<guid>')/ErrorInformation/$value`:

```
org.apache.camel.component.ahc.AhcOperationFailedException: HTTP operation failed invoking
http://backend-dev:443/... with statusCode: 401
```

**No es un problema del MCP ni de los iFlows clonados.** Importa porque contamina cualquier prueba de
migración: un iFlow nuevo puede parecer roto cuando en realidad falló la conectividad al backend.
Conviene descartarlo antes de dar por malo un iFlow migrado.

## Leer el contenido de un recurso — por el ZIP, no por `Resources`

> ✅ **Actualizado el 2026-08-10: `Resources(Name='…',ResourceType='…')/$value` SÍ devuelve el
> contenido** (ver la sección homónima más abajo). Lo que sigue explica por qué, aun así, el MCP lee
> por el ZIP — la decisión no cambió, el motivo sí.

`IntegrationDesigntimeArtifacts(…)/Resources` sin `/$value` sirve para saber **qué** recursos hay
(`Name`, `ResourceType`). Cuando se escribió esta sección no estaba verificado que diera el contenido,
y comprobarlo parecía exigir crear un artefacto con recursos — es decir, escribir en el tenant.

Como el bundle completo ya se baja con `/$value` del artefacto y `core/zip.js` ya lo abre, el
contenido se lee de ahí. El precio es traer el bundle entero para ver un archivo; con bundles de
pocos KB (el `test` pesa 4,5 KB comprimido) el intercambio conviene, y además el ZIP **no exige
conocer el `ResourceType`**, que la navegación sí pide. Queda anotado por si algún día aparece un
bundle lo bastante grande como para justificar el cambio.

## Externalizar parámetros — verificado el 2026-08-05

**El bloqueante del arquetipo se resuelve con código.** Convertir un iFlow hecho a mano en un molde
clonable no exige abrir el editor web: se hace reescribiendo el bundle.

La operación es más chica de lo que parecía. Son **dos archivos**:

```
.iflw                 <value>/iflowtest</value>  ->  <value>{{SenderPath}}</value>
parameters.prop       SenderPath=/iflowtest
```

**`parameters.propdef` NO hace falta.** Se externalizaron cuatro parámetros dejándolo intacto con su
`<param_references/>` vacío, y los cuatro aparecieron igual en `Configurations` con `DataType`
`xsd:string`. Parece ser metadata del editor de Eclipse, no del tenant.

⚠️ Matiz del 2026-08-29: no hace falta *declarar el parámetro* ahí, pero **el archivo tiene que
existir si `parameters.prop` existe** — un bundle con el `.prop` y sin el `.propdef` se rechaza al
subir. Ver *Eliminar archivos del bundle*.

El `.iflw` es BPMN2 plano: las propiedades de cada componente son pares
`<ifl:property><key>K</key><value>V</value></ifl:property>`, y un valor vacío se escribe `<value/>`.

**Las cuatro claves que un arquetipo necesita variables** (verificadas en el `test`):

| Clave | Qué es |
|---|---|
| `urlPath` | address del sender HTTPS |
| `httpAddressWithoutQuery` | URL del receiver |
| `credentialName` | alias de credencial |
| `locationID` | location ID del Cloud Connector |

⚠️ **Las claves se repiten entre componentes.** `componentVersion` aparece 8 veces en un iFlow de
cuatro pasos. Reemplazar "la primera que aparezca" tocaría un componente al azar, así que
`externalizeProperty()` **falla ante una clave ambigua** y exige `currentValue` para desambiguar.

### El runtime sí sustituye al deployar

Probado end-to-end: clon → externalizar → `SenderPath=/iflowarquetipo` → deploy. El endpoint quedó
expuesto en `/iflowarquetipo`, no en el default ni en el literal `{{SenderPath}}`, y la invocación
devolvió 200 con la respuesta del backend. Es decir: **clonar-y-configurar cierra**.

### ⚠️ ServiceEndpoints tarda en reflejar un deploy

En esa misma prueba el endpoint **tardó 30 segundos** en aparecer, con el artefacto ya en `STARTED`.
La primera corrida dio un falso negativo por consultar inmediatamente después del deploy.

Es la misma clase de trampa que `DEPLOYING`/`STARTING`, pero en otra entidad: acá el estado del
artefacto ya es final y lo que va atrasado es la entidad de endpoints. Invocar justo después de
deployar puede parecer "este iFlow no expone endpoint".

⚠️ **Los 30 s no son un techo.** El 2026-08-27, con un iFlow de sender **SOAP** recién deployado y
ya en `STARTED`, el registro tardó **más de tres minutos** en aparecer en `ServiceEndpoints`. Así que
el número no sirve como timeout: lo que se puede afirmar es que la demora existe y que se midió entre
30 s y 3 min. Antes de concluir "no expone endpoint" hay que reintentar, no cronometrar.

## Colas JMS — declaradas en el `$metadata`, inusables en este tenant (2026-08-06)

Sondeadas todas las entidades de colas. **Ninguna sirve:**

| Entidad | Resultado |
|---|---|
| `JmsBrokers`, `JmsQueues`, `JmsMessages`, `MessagingQueues`, `Queues` | `500` con `message.value: null` |
| `JmsArtifacts`, `QueueStates`, `XiDataStores`, `XiDataStoreArtifacts` | `404` — no existen |
| `MessageStoreEntries` | `501` — solo por navegación desde un mensaje |
| `DataStores` | `200`, 0 filas |

Otra vez la sobre-declaración del `$metadata`, igual que `IntegrationFlows`.

La diferencia entre `404` y `500` importa: el `404` dice que la ruta no existe, el `500` que existe y
falló del lado del servidor. Como el mensaje viene `null` — no es un error de negocio con explicación
—, la lectura probable es que **este tenant no tiene el broker JMS aprovisionado**. Es inferencia, no
verificación: desde el API no se distingue "no aprovisionado" de "endpoint roto".

**Lo que NO limita.** Un iFlow que *usa* JMS, IDoc, timer o file se clona, lee, externaliza,
configura, valida, deploya y diagnostica igual que cualquier otro: todo eso opera sobre el bundle y
sobre `IntegrationDesigntimeArtifacts`, y el MPL registra la corrida sea cual sea el adapter. Lo único
que no aplica es `cpi_invoke`, porque esos flujos no exponen endpoint HTTP — y se disparan por su
propio mecanismo.

**Fuera de alcance.** bgRFC/qRFC son del lado ABAP (`SMQ1`/`SMQ2`, `SM58`): no los toca este MCP ni
puede. Eso es territorio de `mcp-sap`.

## Message mappings — formato, deploy y referencia desde un iFlow (2026-08-08)

Verificado sobre `MM_TEST_TRIVIAL` (package `DEVtest`), el primer message mapping del tenant, creado
a mano en la UI para destrabar esto. Sondas: `scripts/probe-mapping-bundle.js` y
`scripts/probe-deploy-mapping.js`.

### Las cuatro familias de artefacto son gemelas para leerlas

`MessageMappingDesigntimeArtifacts` se lee **exactamente igual** que `IntegrationDesigntimeArtifacts`:
misma key compuesta `(Id='…',Version='…')`, mismo `/$value` con el bundle en ZIP. Por eso alcanzó con
parametrizar el entity set (`kind` en `ops/design.js`) en vez de duplicar las operaciones.

Dos diferencias reales:

| | iFlow | Message mapping |
|---|---|---|
| `Configurations` | sí | **no aplica** (no tiene parámetros externalizados) |
| `Resources` | sí | **404** — la navegación no existe |

⚠️ Lo de `Resources` **corrige** lo que decía el ROADMAP, que la daba por su única navegación.

**La key funciona con `Version='active'` aunque el registro reporte otra cosa.** Recién creado, la
navegación del package lo lista con `Version: Draft`; después de "Save as Version" pasa a `1.0.1`. En
los dos casos `active` resuelve a la última guardada.

### Anatomía del bundle de un message mapping

```
src/main/resources/mapping/MM_TEST_TRIVIAL.mmap    ← el mapeo
src/main/resources/xsd/MM_TEST_Origen.xsd          ← los esquemas, adentro del bundle
src/main/resources/xsd/MM_TEST_Destino.xsd
META-INF/MANIFEST.MF
.project
metainfo.prop
```

### El `.mmap` es el formato del ESR de PI, no uno nuevo

Abre con `<xiObj xmlns="urn:sap-com:xi">`, la key es `typeID="XI_TRAFO"` y adentro trae
`<mappingtool version="XI7.1">`. Incluso conserva `swcGuid` y `vc caption="LOCAL"`, que son conceptos
de *software component version* del ESR y no significan nada en CPI: son vestigios. **CPI no inventó
un formato de mapping, reusó el objeto del ESR.**

El mapeo vive en `<transformation>` como un árbol de `<brick>`. Cada campo destino es un brick `Dst`
con sus entradas en `<arg>`:

```xml
<brick type="Dst" path="/ns3:Orden/ns3:Id">
  <arg><brick type="Src" path="/ns1:Pedido/ns1:Numero"/></arg>
</brick>
```

Las funciones son bricks `Func`, y sus propiedades van en `<bindings>`:

```xml
<brick fname="concat" fns="dflt" type="Func">
  <arg><brick type="Src" path="/ns1:Pedido/ns1:Cliente"/></arg>
  <arg pin="1"><brick type="Src" path="/ns1:Pedido/ns1:Numero"/></arg>
  <bindings><param name="delimeter"><value/></param></bindings>
</brick>
```

Una constante es `fname="const"` con `<param name="value">`. Los XSD se enlazan por `<lnkRole
role="SOURCE_IFR_MESS">` / `TARGET_IFR_MESS`, con nombre de archivo, ruta, elemento raíz y namespace.
Los UDF irían en `<functionstorage>` como `<implementation type="udf"><javaText/>`.

**Por qué esto importa para la migración:** el grafo **no usa GUIDs** —los nodos se identifican por su
path XML, que sale del XSD— y las coordenadas `viewData x/y` son cosméticas, todas con el mismo
default. Un mapeo de nodo repetitivo (`Item` → `Linea`) es un brick igual a los demás: el contexto no
aparece como estructura aparte. Todo eso apunta a que **generar y convertir `.mmap` es mecanizable**.

✅ **Confirmado después:** los dos TPZ del ESR se leyeron el 2026-08-08 y traen el mismo bloque, y el
2026-08-12 el *Import from ES Repository* mostró que SAP mueve el objeto **tal cual**, con el `modifBy`
de 2018 incluido. Ya no es una inferencia por parecido.

### Se deploya solo, y el FunctionImport no devuelve TaskId

`POST DeployMessageMappingDesigntimeArtifact?Id='…'&Version='…'` deploya, y el artefacto aparece en
`IntegrationRuntimeArtifacts` con **`Type=MESSAGE_MAPPING`**: es un artefacto de runtime de primera
clase, no un anexo del iFlow.

⚠️ **Devuelve el body vacío**, no un TaskId como `DeployIntegrationDesigntimeArtifact`. Así que para
este no se puede consultar `BuildAndDeployStatus`: hay que ir a `IntegrationRuntimeArtifacts` directo.
Dar el body vacío por error genera un **falso negativo** sobre un deploy que salió bien (pasó en la
primera corrida de la sonda).

**No hay auto-deploy del mapping referenciado**: deployar el iFlow no deploya el mapping que usa. El
orden es mapping primero, iFlow después.

### Referenciar un mapping desde un iFlow toca DOS archivos

Un iFlow puede usar un mapping **embebido** (el `.mmap` adentro de su propio bundle) o **referenciado**
(apuntando al artefacto del package). En la UI son las pestañas `Local Resources` y `Global Resources`
del paso; la referencia se da de alta antes en la vista **Resources → References → Add Reference**.

Con la referencia puesta, el bundle del iFlow **sigue sin contener el `.mmap`** — es un puntero de
verdad, no una copia. Lo que cambia es:

**1. Las propiedades del paso en el `.iflw`:**

```
mappinguri             = dir://mmap/src/main/resources/mapping/MM_TEST_TRIVIAL.mmap
mappingname            = MM_TEST_TRIVIAL
mappingpath            = src/main/resources/mapping/MM_TEST_TRIVIAL
messageMappingBundleId = MM_TEST_TRIVIAL
mappingType            = MessageMapping
mappingReference       = static
```

**2. Un header nuevo en `META-INF/MANIFEST.MF`:**

```
Require-Capability: messagemapping.MM_TEST_TRIVIAL;resolution:=optional;
                    bundleType:String="MessageMapping";source:String="reference"
```

Ese `source:String="reference"` es lo que distingue el caso referenciado del embebido. Cualquier tool
que enganche un mapping a un iFlow por código tiene que escribir **las dos cosas**: con solo el `.iflw`
el bundle OSGi no declara la dependencia.

### El caso EMBEBIDO se reconoce por `messageMappingBundleId` vacío (2026-08-10)

Confirmado sobre `IF_Ventas` (nombre cambiado), un iFlow de negocio real de otra persona del
equipo —un escenario migrado del PO—. Tiene **dos pasos de mapping**, y los dos son embebidos:

| | referenciado (`test`) | embebido (`IF_Ventas`) |
|---|---|---|
| `mappingname` | `MM_TEST_TRIVIAL` | `MM_Request_Ventas` |
| `mappingType` | `MessageMapping` | `MessageMapping` |
| `messageMappingBundleId` | `MM_TEST_TRIVIAL` | **vacío** |
| el `.mmap` | en el bundle del *mapping* | en el bundle del *iFlow* |
| artefacto de mapping en el package | sí | **ninguno** |

O sea que **`messageMappingBundleId` es el discriminador**: con valor, es un puntero a un artefacto
del package; vacío, el `.mmap` viaja adentro del propio bundle del iFlow (acá,
`src/main/resources/mapping/MM_Request_Ventas.mmap`). `mappingname` no sirve para distinguirlos:
está puesto en los dos casos.

Importa para la migración porque **el camino embebido ya se está usando en el tenant**: los mapeos que
vinieron del PO entraron adentro del iFlow, no como artefacto aparte. Enganchar por referencia es la
otra opción, y es la que permite reusar un mapping en varios iFlows.

### El formato del enganche está verificado sin escribir (2026-08-10)

`scripts/probe-mapping-reference.js` reaplica el enganche del MCP sobre el bundle que la **UI** dejó
escrito en `test`, y compara. Resultado: **no-op byte a byte** en los dos archivos — el `.iflw` queda
idéntico y el `MANIFEST.MF` también, incluido el corte del `Require-Capability` a los 72 bytes, que
cae exactamente en el mismo lugar (`…resolution:=optional;` termina en el byte 72 justo).

Es la prueba fuerte que se puede hacer sin tocar el tenant: si lo que produciríamos coincide con lo
que produjo SAP, el formato está bien.

### Y el ciclo completo también, escribiendo (2026-08-10)

Sobre descartables en `DEVtest`, ya borrados: se clonó `MM_TEST_TRIVIAL` → `ZZ_REF_MM`, se clonó
`test` → `ZZ_REF_IF`, se le **vació** la referencia al paso, se la volvió a escribir con la tool
apuntando al mapping clonado, y se deployaron los dos en orden. Resultado: `Build & deploy: SUCCESS`,
runtime `STARTED`, e invocando el endpoint el mapeo **corrió de verdad** —`Pedido`→`Orden`, la
constante, el `concat` y los dos `Item`→`Linea`—, con el MPL confirmando que atendió `ZZ_REF_IF`.

⚠️ **STARTED no habría alcanzado como prueba.** La cláusula lleva `resolution:=optional`, así que
OSGi **no falla** si la capability no resuelve: un iFlow mal enganchado igual deploya y arranca. La
única evidencia concluyente es invocarlo y ver el payload transformado.

### El tenant RENOMBRA el `.mmap` al ingerir un mapping (2026-08-10)

Se subió `ZZ_REF_MM` con `src/main/resources/mapping/MM_TEST_TRIVIAL.mmap` adentro —el clon copia el
bundle tal cual— y quedó guardado como **`src/main/resources/mapping/ZZ_REF_MM.mmap`**. El bundle
además cambió de tamaño (3716 → 3800 bytes) y la versión salió `1.0.1` en vez de `1.0.0`: SAP no
guarda el ZIP que le mandás, lo reescribe.

**El iFlow no se comporta igual**: `ZZ_REF_IF`, clonado de `test`, conservó `test.iflw` con el nombre
del original. O sea que la normalización es por familia y no general.

Consecuencia práctica: **el nombre de un archivo dentro de un bundle no se puede predecir desde
afuera**, ni asumiendo que se conserva ni asumiendo que se renombra. Hay que leerlo.

### `Bundle-SymbolicName`: inmutable después de crear, pero nunca validado contra el `Id` (2026-08-10)

Tres pruebas sobre descartables, que corrigen lo que se suponía:

| Operación | Con un `Bundle-SymbolicName` que no coincide con el `Id` |
|---|---|
| `POST` (crear) | **acepta** — ya estaba verificado |
| `PUT` (actualizar) | **HTTP 400** — `Could not update artifact of the package; due to change in the Bundle-symbolicName` |
| `Deploy` | **acepta**: `SUCCESS`, runtime `STARTED`, y el iFlow **funciona** al invocarlo |

O sea que el tenant **nunca** compara el símbolo contra el `Id`; lo que hace es **congelarlo**: una
vez creado el artefacto, el `PUT` rechaza cualquier cambio de esa clave.

⚠️ Esto **desmiente** la explicación que traía `ops/write.js` ("clonar sin reescribir el manifiesto
funciona hasta que se deploya"). El deploy no se queja. La razón real para que `cloneArtifact()`
reescriba el manifiesto es otra y sigue en pie: **dos bundles OSGi con el mismo `Bundle-SymbolicName`
colisionan** cuando los dos están deployados. Y como el `PUT` lo congela, reescribirlo **al clonar**
es la única oportunidad de hacerlo.

## Pendiente de verificar contra el tenant

**Solo van acá preguntas sobre cómo se comporta el API.** Lo que falta *construir* en el MCP vive en
[ROADMAP.md](ROADMAP.md).

**No queda ninguna abierta.** Las cuatro que arrastraba este documento se respondieron el
2026-08-10, y la de los `_content` no-iFlow en el export (abierta y cerrada el 2026-08-26) está
respondida en la sección de descarga, abajo.

Resueltos, con el detalle en las secciones de arriba: la service key del plan `integration-flow`
(2026-08-04), el `POST` contra un sender con `xsrfProtection=1` (2026-08-05), si `LogLevel=Trace`
se puede prender por API — no se puede (2026-08-04) —, `Resources/$value` (abajo),
`Bundle-SymbolicName` (arriba), `ErrorInformation` y `POST IntegrationPackages` (abajo).

### `ErrorInformation` sí informa, pero hay que pedírselo bien (2026-08-10)

Provocado con un deploy fallido de verdad: un iFlow con el `.iflw` mal cerrado, que da
`BuildAndDeployStatus = FAIL` y runtime `Status = ERROR`.

| Camino | Resultado |
|---|---|
| `IntegrationRuntimeArtifacts('X')/ErrorInformation` | **404** — la navegación pelada no existe |
| `…/ErrorInformation/$value` con `Accept: application/json` | **406** Not Acceptable |
| `…/ErrorInformation/$value` con `Accept: application/xml` | **200**, y el cuerpo viene en **JSON** |

Hay que pedir XML para que te devuelva JSON. El cuerpo:

```json
{"message":{"subsystemName":"CONTENT","subsytemPartName":"CONTENT_DEPLOY",
 "messageId":"GenerationFailed","messageText":""},
 "parameter":["The generation and build of the artifact were unsuccessful. …"]}
```

Dos detalles que importan al leerlo: **`messageText` viene vacío** y el texto útil está en
`parameter`, y **`BuildAndDeployStatus` no aporta nada** más allá de `Status: FAIL` — no trae
mensaje. `ErrorInformation` es el único lugar con detalle.

⚠️ Esto estaba **roto en el MCP**: `deployedErrorInfo()` pegaba contra la navegación pelada, se
comía el 404 como "sin error registrado" y devolvía `null` siempre. El síntoma era `cpi_deploy`
diciendo "quedó en estado ERROR" sin explicar por qué. Arreglado el 2026-08-10.

### `POST IntegrationPackages` funciona (2026-08-10)

Se creó `ZZPKGPRUEBA` con `Id` + `Name` + `ShortText` + `Version` y se borró con
`DELETE IntegrationPackages('ZZPKGPRUEBA')`. Las dos operaciones andan. **Crear packages desde el
MCP es viable**: es lo que destraba el punto de packages del ROADMAP.

#### ⚠️ El Id de un package es más estricto que el de un artefacto (2026-08-11)

**No admite guion bajo.** Verificado al construir `cpi_package_create`:

```
POST IntegrationPackages   Id='ZZ_PKG_PROBE'
  -> 400 — Property 'Id' value cannot have a special character. Enter a valid Id.
POST IntegrationPackages   Id='ZZPKGPROBE'
  -> 201
```

Y el mismo tenant acepta `zz_clone_probe` como Id de **iFlow**, así que las dos reglas conviven y
no se pueden compartir. `cpi_package_create` valida `^[A-Za-z0-9]+$` del lado del MCP para que el
rebote llegue como frase y no como viaje perdido al tenant.

> Alcance: lo verificado es que el guion bajo se rechaza y que el alfanumérico se acepta. **Qué
> otros caracteres pasan no está probado** — el mensaje de SAP dice "special character" sin listar.

Verificado además que el package recién creado **sirve para lo único que importa**: se clonó un
iFlow adentro y el artefacto quedó con `PackageId: ZZPKGPROBE`. Está en el ciclo de
`scripts/test-write-cycle.js`, que lo crea al empezar y lo borra al terminar.

⚠️ **`CopyIntegrationPackage` NO sirve para eso.** Contra un package del propio tenant devuelve
`404 — Copy not successful from content hub to workpace. An error occurred while fetching the
integration package DEVtest from the Integration Content Catalog`. Copia desde el **Content Hub** de
SAP —el catálogo de contenido estándar—, no desde tu workspace. El ROADMAP la daba como atajo para
clonar un package plantilla; no lo es.

### `Resources(Name,ResourceType)/$value` SÍ devuelve el contenido (2026-08-10)

Probado sobre `IF_Ventas` con tres tipos distintos:

```
GET IntegrationDesigntimeArtifacts(Id='…',Version='active')
    /Resources(Name='response.xsd',ResourceType='xsd')/$value
```

| Recurso | Tipo | Bytes |
|---|---|---|
| `response.xsd` | `xsd` | 560 |
| `MM_Request_Ventas.mmap` | `mmap` | 14160 |
| `Payload_Logging_ActiveLog.groovy` | `groovy` | 3845 |

Los tres coinciden **exactamente** con el tamaño de su entrada en el ZIP, así que es el mismo
contenido y no una representación distinta. La key de `Resources` es compuesta (`Name` +
`ResourceType`), y sin `/$value` devuelve el registro JSON, igual que en los artefactos.

**Qué habilita.** Hoy `readBundleFile()` baja el bundle entero para leer un archivo; con esto se
podría pedir solo el archivo. Con bundles de 14 KB da igual, así que **no es motivo para cambiar
nada todavía** — queda anotado para cuando aparezca un iFlow grande. El costo de cambiarlo es que
la navegación exige el `ResourceType`, que el ZIP no necesita.

## Descarga de contenido de diseño — los dos `/$value` (2026-08-26, `scripts/probe-package-download.js`)

Los dos endpoints de descarga que usa `cpi_download`:

```
GET IntegrationPackages('<Id>')/$value                               -> zip del package entero
GET IntegrationDesigntimeArtifacts(Id='<id>',Version='<v>')/$value   -> bundle de un artefacto
```

El segundo ya estaba verificado (es el que usa `cpi_iflow_read` por adentro, para las cuatro
familias). El primero **anda y es el mismo zip que el botón Export de la UI** — reimportable con
Import. Verificado sobre 6 packages del tenant; `PKGTM1` y `PKGBI` quedaron diseccionados.

### Anatomía del zip de export

```
575eaf492d7a4b22bee0e8338a084a00_content    <- UNO por artefacto: su bundle
resources.cnt                               <- JSON en base64: el índice del export
contentmetadata.md                          <- properties en base64 (versiones del formato)
hash                                        <- array JSON de hashes
ExportInformation.info                      <- texto plano: Name= y Date=
```

- **Los nombres de las entradas son GUIDs, no Ids.** El mapa guid → Id está en `resources.cnt`:
  base64 de un JSON cuyo array `resources` trae `id` (el guid), `uniqueId` (el Id del artefacto),
  `name` (`<Id>.zip`) y el **tipo** (`IFlow`, `MessageMapping`, `ScriptCollection`). Ojo: el
  **package mismo** también tiene su entrada en ese array, con tipo `ContentPackage`.
- **Las familias no-iFlow entran igual que el iFlow**: un message mapping y una script collection
  tienen su propio `<guid>_content` (mismo formato: el bundle sin `metainfo.prop`). Verificado el
  2026-08-26 dos veces: con un package descartable (`ZZEXPORTPROBE`, clones de un mapping y un
  script, creado y borrado en la misma sonda) y con `DEVtest` real una vez que quedó sin drafts.
  **Value mapping sigue sin verificar**: no hay ningún espécimen en el tenant.
- **El `<guid>_content` es el bundle del artefacto, casi byte a byte.** Comparado contra el
  `/$value` directo de un iFlow de negocio real: mismas entradas con los mismos tamaños, salvo
  que el bundle directo trae un `metainfo.prop` (118 bytes) que el export no incluye.
- **Un package vacío también exporta**: zip de ~1,7 KB con solo la metadata (verificado con
  dos packages vacíos de otras personas del equipo).

### ⚠️ Un draft bloquea el export del package ENTERO

```
GET IntegrationPackages('DEVtest')/$value
  -> 500 — Package export failed. It contains the following artifacts are in draft state:
     [ {Type=IFlow, Name=ZVALIDACION_ESR_PRD ...} ]
```

No hay export parcial: **un** artefacto sin versionar tumba el package completo. El día de la
verificación, **5 de los 11 packages del tenant no se podían exportar** por esto. Consecuencias:

- **El draft no siempre dice `Draft`.** En el listado OData, un artefacto editado en la UI y nunca
  versionado lista `Version: 'Active'`; uno creado por API sin versión lista `'Draft'` (eso ya
  estaba visto en `probe-mapping-bundle.js`). Ambos bloquean el export. `'Active'` es fácil de
  confundir con la key `'active'` de designtime, que es otra cosa: la key funciona siempre.
- **El bundle individual de un draft SÍ se baja**: `/$value` del artefacto con `Version='active'`
  (o `'Active'`, da igual) devuelve el zip normalmente. Es la vía de escape para un backup:
  package con drafts → bajar los artefactos de a uno.
- `downloadPackage()` en `ops/design.js` detecta este 500 por el texto `draft state` y le agrega
  el hint con las dos salidas (versionar en la UI, o de a uno).
- **Un clon fresco NO arrastra el problema**: el POST de creación deja el artefacto versionado
  (`Version=1.0.0` — es el PUT de update el que degrada a draft), así que un package armado por
  API con clones exporta sin pasar por la UI. Es lo que permitió verificar los `_content`
  no-iFlow con `ZZEXPORTPROBE`. Curiosidad de esa corrida: el clon del mapping respondió
  `1.0.0` al crearse y la navegación del package ya lo listaba `1.0.1`.

### Errores de los `/$value`: 404 en XML

Un Id inexistente da **404 limpio** en ambos endpoints (`Integration package {X} does not exist.` /
`Integration design time artifact not found.`) — no un 500 ni un zip vacío. Pero con
`Accept: application/octet-stream` (toda descarga raw) **el error OData llega en XML, no en
JSON**: `client.js` tiene desde hoy un fallback que extrae el `<message>` para que el error llegue
como frase y no como volcado de XML.

## Eliminar archivos del bundle — verificado el 2026-08-29 (`scripts/probe-remove-file.js`)

No hay DELETE de un archivo individual; la vía es la misma del update: **resubir el bundle entero
sin el archivo**. La sonda corrió una matriz sobre clones frescos de `test` (que trae un `.mmap`
referenciado por el `.iflw` y dos WSDL referenciados por el `.mmap`), y el contrato quedó así:

| Se elimina | PUT | Validate |
|---|---|---|
| archivo no referenciado por nada | 200 | Passed |
| `parameters.propdef` solo | **500 — `InputStream cannot be null`** | (no llega) |
| `parameters.prop` solo | 200 | Passed |
| `parameters.prop` + `parameters.propdef` | 200 | Passed |
| el `.mmap` que el `.iflw` referencia | 200 | **Failed**: `Mapping file '…' not found` |
| un WSDL que el `.mmap` referencia | 200 | **Failed**: `TARGET_CONTENT_NOT_FOUND` |

Tres conclusiones:

- **El PUT no chequea referencias.** Un bundle al que le falta un recurso que el `.iflw` o el
  `.mmap` siguen nombrando se sube sin protestar; el que lo atrapa es **Validate**, con un error
  preciso que nombra el archivo y el paso. Por eso `cpi_iflow_update` recomienda validar después
  de un `removeFiles`, y por eso eliminar de más no es catastrófico: se detecta antes de deployar.
- **La única coherencia que el PUT sí exige es el par `parameters.prop`/`parameters.propdef`, y es
  asimétrica**: `.prop` sin `.propdef` → `500 — InputStream cannot be null` (el ingest parsea los
  parámetros y busca el `.propdef`); `.propdef` sin `.prop`, o ninguno de los dos, se aceptan.
  El 500 no nombra al culpable, así que `updateArtifactFiles` lo ataja antes del PUT con un error
  que sí lo nombra.
- **El rechazo es atómico.** Tras el 500, el bundle re-descargado estaba intacto: un PUT fallido
  no deja el artefacto a medio escribir.

La eliminación es real, no un merge: el archivo no está al re-descargar. `cpi_iflow_update` expone
esto como `removeFiles`, con una whitelist de intocables (`MANIFEST.MF`, `.project`,
`metainfo.prop`, el `.iflw`) y error ante una ruta inexistente, para atrapar el typo en vez de
"no borrar y no avisar".