# Meter un message mapping del ESR adentro del iFlow

Parte de la skill `mcp-cpi-iflows`. El ciclo mecánico está en `ciclo-base.md`.

Hay **dos caminos**, y no compiten: uno es el oficial y el otro es el que queda cuando el PO no está.

## Camino 1 — Import from ES Repository (el decidido)

Es un diálogo de la **UI**, no hay API: dentro del iFlow, `References → Local → Add → Mapping →
Message Mapping`, con *Source* = **ES Repository**.

- **No convierte nada**: trae el objeto del ESR tal cual, mismo `XI_TRAFO`, con el `modifBy` de 2018.
- **Cubre el 100% de los message mappings vivos.** Del censo de 99 en el TPZ lista 93; los 6 restantes
  **están borrados en el ESR** (verificado 2026-08-23), así que el importador no los ve y no hay nada
  que rehacer. Detalle en `hallazgos/cpi/import-esr.md`, en el workspace de la migración.

  ⚠️ **Un `.tpz` exportado con "incluir borrados" trae objetos que no existen**, y el archivo no los
  distingue de los vivos. Si el censo del TPZ no cuadra con lo que lista el importador, es por ahí.
- **Necesita el PO prendido y conectado** por Cloud Connector. Si el host del PO no responde en su
  puerto HTTP (`Test-NetConnection <host> -Port <puerto>`), este camino no existe hoy.
- ⚠️ **El tenant puede tener registrado más de un PO** (`Settings → Integrations → System`), y el
  wizard ofrece todos: **elegir el sistema correcto es parte del procedimiento** — importar del
  ambiente equivocado no da ningún error, solo trae otra versión.
- ⚠️ **Importa del ESR VIVO que el tenant tenga conectado — que puede no ser la fuente de verdad
  del proyecto.** Si el tenant apunta a un ambiente (p.ej. desarrollo) y el patrón de la migración
  es otro (p.ej. un export de producción), el import trae la versión de ese ambiente **sin ningún
  aviso**, y los mappings divergen entre ambientes y siguen cambiando. **Verificar cada `.mmap`
  importado contra el export confiable antes de darlo por bueno**: bajarlo del bundle
  (`cpi_iflow_read` con `file=` y `saveTo=`, que lo guarda a disco byte a byte — la salida de
  texto de la tool no sirve para re-tipearlo) y comparar el árbol de bricks contra el export —
  si el workspace tiene un lector de `.tpz`, esa comparación es un comando. Si difiere: camino 2
  desde el export, o documentar por qué la diferencia está bien.

🔴 **Es un reloj, no una opción.** El día que apaguen el PI, esta puerta se cierra para siempre.
Importar todo lo que se pueda mientras el PO viva.

## Camino 2 — escribir el `.mmap` desde el TPZ (probado el 2026-08-18)

Verificado end-to-end: `Validate` Passed, `Build & deploy` SUCCESS, y el mapping **corrió** en una
invocación real. No depende del PO: son archivos en disco, el export `.tpz` del ESR que tenga el
workspace — por ejemplo `insumos/esr-prd/`.

**No hay conversión de lógica.** El `<mappingtool version="XI7.1">` del ESR entra tal cual. Lo que
cambia es el envoltorio, y son cuatro cosas:

| | en el ESR (`.tpz`) | en CPI (`.mmap`) |
|---|---|---|
| prefijo XML | `<p1:xiObj xmlns:p1="urn:sap-com:xi">` | `<xiObj xmlns="urn:sap-com:xi">`, con `xmlns=""` adentro |
| origen y destino | `lnks` con `typeID="ifmmessage"` | `lnks` con `typeID="xsd"`: **archivo, carpeta, elemento raíz, namespace** |
| el modelo | comprimido en `<tr:blob type="zip">!zip!…` | **inline** en `<tr:MetaData>`, sin la declaración `<?xml?>` |
| el bytecode | `<tr:ByteCodeJar>!jar!…` + `SourceCode` + `AdditionalMetaData` | **`<tr:ByteCodeJar/>` vacío** — CPI compila al deployar |

⚠️ **`<textInfo/>` vacío rompe la validación con un NPE**, no con un mensaje de formato
(`ParserUtil.fillTextInfo`). Hay que replicar lo que escribe la UI, aunque los textos vayan en blanco:

```xml
<textInfo loadedL="EN"><textObj id="<32 hex>" masterL="EN" type="0">
  <texts lang="EN"><text label=""/></texts></textObj></textInfo>
```

**Los XSD también salen del ESR, pero hay que aplanarlos.** El `ifmtypedef` trae un `<xsd:schema>` de
verdad; lo que CPI no entiende es cómo el ESR une los data types entre sí:

```xml
<xsd:include schemaLocation="ifr://schema?keyelements=DT_saldo_request|urn:…&amp;swc=…"/>
```

Hay que resolver eso recursivamente e **inlinear** los `complexType` en un solo archivo, más la
declaración del elemento raíz (`<xsd:element name="MT_request" type="DT_request"/>`), que vive en el
`ifmmessage` y no en el `ifmtypedef`.

**Qué prueba y qué no:** que el deploy compile es la prueba fuerte, porque el bytecode no viaja. Pero
lo probado es un mapping **1:1 de 10 bricks**. Un mapeo con UDF o con lookup RFC **no está probado por
este camino**.

## Embebido o referenciado

| | embebido | referenciado |
|---|---|---|
| dónde vive el `.mmap` | adentro del bundle del iFlow | en un artefacto de mapping del package |
| discriminador en el `.iflw` | `messageMappingBundleId` **vacío** | con valor |
| cambiarlo | hay que tocar cada iFlow | un solo lugar, N iFlows |
| deploy | va con el iFlow | **el mapping primero**, después el iFlow |

**Si casi todas las interfaces tienen mapeo propio, embebido alcanza** y la decisión no importa
demasiado. Conviene medirlo antes: el caso donde una referencia compartida paga es el mapping que
usan muchos iFlows.

Para enganchar por referencia:

```
cpi_iflow_mapping({ iflowId })                          # sin mappingId: lista los pasos y a qué apuntan
cpi_iflow_mapping({ iflowId, mappingId, step: "…" })    # escribe
```

Toca **dos** archivos: las propiedades del paso en el `.iflw` **y** el `Require-Capability` del
`MANIFEST.MF`. Con uno solo, el bundle OSGi no declara la dependencia.

⚠️ **Que quede `STARTED` no prueba que el enganche resuelva** — la cláusula lleva
`resolution:=optional`. Hay que invocar y mirar el payload.

## Y la trampa que no perdona

🔴 **Un prefijo de namespace que no coincide hace que el mapping devuelva vacío, sin error y en
verde.** Por eso el `RootElementNamespace` del `JSON to XML` y el `NamespaceMapping` de la Runtime
Configuration tienen que declarar el mismo URI para el mismo prefijo, y por eso hay que **verificar
con qué prefijo manda el XML cada consumidor** antes de dar una interfaz por migrada.
