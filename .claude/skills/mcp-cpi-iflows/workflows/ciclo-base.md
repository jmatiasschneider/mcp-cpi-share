# El ciclo base de un iFlow nuevo

Parte de la skill `mcp-cpi-iflows`. Las reglas transversales están en `SKILL.md`.

Sirve para cualquier forma. Lo específico de cada una está en su propio archivo.

### 0. No se genera un iFlow desde cero: se clona

El `MANIFEST.MF` es un bundle OSGi con ~1,5 KB de `Import-Package` de internals de Camel y CXF.
Sintetizarlo no es viable, y no hace falta: `cpi_iflow_clone` baja el bundle de una plantilla,
reescribe `MANIFEST.MF` y `.project` con el Id nuevo, y lo sube.

Elegí el molde por **forma**, no por parecido de nombre. Ver el archivo del arquetipo que corresponda.

### 1. El package donde va a vivir

```
cpi_packages()                                  # ver qué hay y de quién es
cpi_package_create({ id: "PKGLoQueSea", ... })  # solo letras y números en el Id
```

**No hay `cpi_package_delete`, y es a propósito:** borrar un package se lleva puesto todo lo que tiene
adentro. Si hace falta de verdad, está crudo en `scripts/test-write-cycle.js`.

### 2. Clonar

```
cpi_iflow_clone({ sourceId: "<molde>", targetId: "<nuevo>", targetPackageId: "<package>" })
```

Después, `cpi_iflow_read({ id, includeContent: true })` para ver qué trajo: los XSD, los `.mmap`, el
Groovy y los parámetros ya externalizados del molde.

⚠️ **El `.iflw` conserva el nombre de archivo del original**, no se renombra al clonar. Un molde que
a su vez se clonó de una interfaz real lleva el nombre de esa interfaz, y todos sus clones también —
no es un error, es la huella del tronco común. **Leé el modelo, no el nombre del archivo.**

**El clon trae TODO lo que el molde tenía adentro**, incluidos los `.mmap`, XSD y WSDL que este iFlow
no va a usar — en una migración, los de la interfaz que se migró con ese molde antes. No rompen nada
mientras el modelo no los referencie, pero ensucian el bundle y confunden al que lo lea después. Se
eliminan con la misma tool que escribe:

```
cpi_iflow_update({ id, removeFiles: [
  "src/main/resources/mapping/MM_DeLaInterfazAnterior.mmap",
  "src/main/resources/wsdl/MT_DeLaInterfazAnterior.wsdl",
]})
```

El momento correcto es **después** de enganchar los recursos propios (pasos 3 en adelante, o
`mapeos.md` si lleva mapping): recién ahí sabés qué quedó huérfano de verdad. Una ruta inexistente es
error —atrapa el typo—, los archivos estructurales no se pueden eliminar, y `parameters.prop` no puede
quedar sin `parameters.propdef` (la tool ataja los tres casos).

⚠️ Eliminar algo que el `.iflw` o un `.mmap` todavía referencian **se sube sin protestar**: el upload
no chequea referencias. Lo atrapa `cpi_iflow_validate`, con el archivo y el paso exactos — por eso
después de limpiar se valida, siempre.

### 3. Externalizar lo que el molde trae hardcodeado

Sin `params` la tool no escribe: lista las propiedades candidatas del modelo.

```
cpi_iflow_externalize({ id })                          # ver qué hay
cpi_iflow_externalize({ id, params: [
  { key: "urlPath",                        name: "SenderPath",          default: "/lo-que-sea" },
  { key: "additionalRootElementName",      name: "RootElementName",     default: "MT_request" },
  { key: "additionalRootElementNamespace", name: "RootElementNamespace",
    default: "xmlns:ns0=urn:tu:namespace" },
  { key: "namespaceMapping",               name: "NamespaceMapping",
    default: "xmlns:ns0=urn:tu:namespace" },
]})
```

Si una clave aparece en varios componentes, la tool **tira error** en vez de elegir: hay que pasar
`currentValue` para decir cuál.

**El `namespaceMapping` y el `additionalRootElementNamespace` tienen que declarar el mismo URI para el
mismo prefijo.** Si no, el validate falla con
`Namespace URI '…' is different than the one configured for this prefix`.

### 4. Configurar los parámetros de la interfaz

```
cpi_iflow_configure({ id, parameters: { CC_Sender: "…", SI_Namespace: "…", Address: "…" } })
```

Queda en designtime: **no toma efecto hasta redeployar**.

### 5. Validar

```
cpi_iflow_validate({ id })
```

`Passed` es el permiso para deployar. Si falla, el mensaje trae `sourceObject` con el paso y el
atributo exactos.

### 6. Deployar

```
cpi_deploy({ id })
```

Espera el task **y** el runtime: `BuildAndDeployStatus` pasa por `DEPLOYING` y el runtime por
`STARTING`. Darlos por finales genera falsos errores.

**El deploy compila los mappings embebidos**, porque el `.mmap` viaja sin bytecode. Un `SUCCESS`
prueba que CPI supo generar el Java del modelo — es mucho más fuerte que el validate.

⚠️ Deployar un iFlow **no** deploya los mappings que referencia. Si el enganche es por referencia:
mapping primero, iFlow después.

### 7. Invocar y mirar la traza

```
cpi_invoke({ iflow: "<id>", method: "POST", body: "…" })     # o address: "<path>" si no figura
cpi_message_detail({ messageGuid })                          # cabecera, error, qué pasos corrieron
cpi_trace({ messageGuid })                                   # el payload de cada paso
```

Si el endpoint no aparece en `ServiceEndpoints` todavía, invocá por `address` con el path del sender.
Ahí el prefijo lo ponés vos: **un sender SOAP va como `address: "cxf/<path>"`**, y sin prefijo se
asume `/http/`, que es lo correcto para un sender HTTPS/REST. Con `iflow` se elige solo.

⚠️ La entidad tarda en reflejar el deploy — se midió desde 30 s hasta más de 3 minutos, con el
artefacto ya `STARTED`. "No expone endpoint" recién después de reintentar.

⚠️ Un **404 con el iFlow `STARTED` y sin nada en el monitor** casi siempre es el prefijo equivocado,
no el iFlow: ese 404 lo devuelve el Tomcat antes de que el flujo arranque.

**Los dos niveles no son intercambiables.** `cpi_message_detail` dice si falló y dónde; `cpi_trace` es
el único que muestra qué payload entró y salió de cada paso — que es lo que hace falta cuando el iFlow
completa en verde y devuelve datos equivocados.

### 8. Limpiar, si era descartable

```
cpi_undeploy({ id, confirm: true })     # pediselo al usuario antes
cpi_iflow_delete({ id, confirm: true })  # `confirm` es obligatorio en las dos
```

⚠️ **`cpi_iflow_update` reemplaza y agrega archivos, pero no borra.** Si cambiaste los `.mmap` o los
XSD por otros con nombre nuevo, los viejos quedan adentro del bundle como peso muerto. No rompen nada
—el modelo ya no los referencia— pero conviene saberlo antes de mirar el listado y confundirse.
