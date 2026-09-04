---
name: mcp-cpi-iflows
description: Cómo se crea un iFlow en SAP Integration Suite con las tools del server mcp-cpi, y cómo se migra una interfaz de PI/PO a CPI según su forma. Usar para CREAR o CLONAR un iFlow, para MIGRAR un ICO del PI —sea SAP provider (REST→SOAP, SOAP→SOAP, REST→RFC) o SAP consumer (SOAP→REST, RFC→SOAP, RFC→REST)—, para meterle un message mapping traído del ESR, y para entender por qué un iFlow deployado falla contra el backend ABAP. Cubre el ciclo clonar → externalizar → configurar → validar → deployar → invocar → leer la traza.
---

# Crear iFlows y migrar interfaces de PI

Orquestaciones que encadenan varias tools de `mcp-cpi`. Cada tool sola está documentada en su
`description`; acá está lo que **no** cabe ahí: el orden, qué se le pregunta al usuario, y las trampas
medidas contra el tenant real.

## Cuál leer

| Si la tarea es… | Abrir |
|---|---|
| Cualquier iFlow nuevo — el ciclo mecánico, sirve para todos | `workflows/ciclo-base.md` |
| Migrar un ICO — **clasificalo primero por el rol de SAP** | la tabla *Las seis formas*, más abajo |
| Meter un message mapping del ESR adentro del iFlow | `workflows/mapeos.md` |

🔴 **Esta skill describe FORMAS, no un parque concreto.** Cuántas interfaces cae en cada forma, qué
iFlow hace de molde para cada una y en qué package vive **son datos del proyecto, no de la skill**:
viven en el documento de arquetipos del workspace donde la estés usando. Un arquetipo es una
**forma**, no una interfaz.

⚠️ **Si un workflow nombra un iFlow concreto, es un ejemplo del proyecto donde se escribió.** Lo
que hay que reusar es la tabla de *qué forma tiene ese molde* —sender, receiver, autenticación—, no
el nombre.

**La fuente de esta skill vive en el repo `mcp-cpi`**, en `.claude/skills/`. Si estás leyéndola dentro
de un workspace, es una copia hecha por `npm run skills:sync`: editala allá, no acá, o el próximo sync
te pisa el cambio.

## Reglas transversales

Valen para todos. Están acá porque son las que más caro salen cuando se olvidan.

**Esta skill dice en qué orden usar las tools; no es la fuente de verdad de nada más.** Si algo de acá
contradice a un documento, gana el documento — y son dos, según de qué se trate: **cómo se comporta el
API** manda el `DISCOVERY.md` de este repo; **qué hay que migrar y con qué molde** manda la
documentación de hallazgos del workspace.

**Decí siempre de qué lado sale cada afirmación: PI o CPI.** Son dos sistemas con vocabularios
distintos. "Receiver XI" es correcto en PI —adapter SOAP con message protocol XI— y engañoso leído en
CPI, donde el molde usa SOAP 1.x. Callar la fuente hace que una descripción correcta parezca un error
y manda a "arreglar" un iFlow sano.

**Una interfaz se describe por el rol de SAP: `SAP provider` o `SAP consumer`.** Es el vocabulario del
usuario — usalo siempre que describas el sentido de una interfaz. SAP es **provider** cuando le pegan
a SAP, y **consumer** cuando SAP llama para afuera.

**Para clasificar, mirá de qué lado del ICO está SAP:** en el **receiver**, SAP es provider; en el
**sender**, consumer. Ése es el único criterio confiable.

🔴 **El prefijo del ESR NO decide el rol.** `SI_IS_…` nombra la punta receiver y `SI_OS_…` la sender,
pero **cada escenario tiene una de cada una**: en un escenario donde SAP consume, la `SI_IS_` es la
del tercero, no la de SAP. El prefijo sirve sólo si ya sabés de quién es esa interfaz.

🔴 **Por lo mismo, no uses "entrada" ni "salida" para el sentido de una interfaz:** en el ESR la
dirección es relativa al sistema que la implementa, así que la palabra se da vuelta según qué punta
mires. Si alguien las usa, preguntá qué quiso decir antes de escribirlo. (Para el source y el target
de un **mapping** no hay ambigüedad — ahí decí `source`/`target`, y no está prohibido.)

**El rol de SAP fija el del iFlow, invertido — y por eso "provider" a secas es ambiguo.** Con SAP
**consumer**, el que sirve es **CPI**: el iFlow publica el endpoint, es dueño del contrato y emite el
WSDL. Con SAP **provider**, sirve el ABAP y el WSDL sale de SOAMANAGER. **Decí siempre "SAP provider"
o "SAP consumer"**, con el sujeto adelante.

**Las seis formas** posibles, y por dónde entrar:

| Rol de SAP | Forma | Workflow |
|---|---|---|
| **provider** | `REST→SOAP` | `workflows/arquetipo-3-rest-soap.md` — **el único probado end-to-end** |
| **provider** | `SOAP→SOAP` | `workflows/arquetipos-sin-probar.md` |
| **provider** | `REST→RFC` | `workflows/arquetipos-sin-probar.md` — caso único, el receiver RFC sí existe |
| **consumer** | `SOAP→REST` | `workflows/arquetipo-1-soap-rest.md` |
| **consumer** | `RFC→SOAP` | `workflows/arquetipos-sin-probar.md` — 🔴 obliga a tocar el ABAP |
| **consumer** | `RFC→REST` | `workflows/arquetipos-sin-probar.md` — caso único, 🔴 ídem |

ℹ️ **La flecha nombra los adapters `sender→receiver` del ICO; no dice dónde está SAP.** Son dos ejes
distintos, y el nombre de la forma sólo lleva el primero: `REST→SOAP` es SAP provider y `SOAP→REST` es
SAP consumer, pero eso sale de esta tabla, no de leer la flecha. Traducí siempre al rol antes de
hablar con el usuario.

ℹ️ Y los números (`arquetipo 1`, `arquetipo 3`) son **vocabulario del proyecto** que los enumeró, no
un orden de esta skill: la forma es el dato, el número es el alias con el que se habla.

🔴 **Y el corte que decide el esfuerzo es cómo llama SAP hoy, no el rol.** Donde SAP consume por
**SOAP**, se migra clonando un molde. Donde consume por **RFC**, hay que tocar el ABAP: en CPI no
hay adapter RFC sender. Cuántas caen en cada lado lo dice el censo del proyecto.

**🔴 El tenant no es un banco de pruebas libre.** Puede haber trabajo de otras personas adentro. **No
se crea ni se borra nada en un package ajeno sin preguntar.** Para probar, package descartable
propio.

**Validá siempre antes de deployar.** `cpi_iflow_validate` no toca el runtime y atrapa cosas que el
deploy no explica bien — por ejemplo un prefijo de namespace que no coincide con el Namespace Mapping,
con la ubicación exacta del atributo. Existe **sólo para iFlows**: en mappings, scripts y value
mappings el deploy es la primera verificación y cada intento sale más caro.

**Externalizá todo lo que varíe, antes de clonar.** Cada valor hardcodeado es abrir el editor web
después. Como mínimo: el `urlPath` del sender, el `Address` del receiver, el root element y el
namespace del `JSON to XML`, el `namespaceMapping` de la Runtime Configuration, y el **`userRole`
del sender**.

🔴 **El `userRole` merece su propia línea porque no parece variable y lo es.** Si queda literal en
el `.iflw`, cambiar el modelo de autorización obliga a **editar el modelo de cada iFlow deployado,
uno por uno**; externalizado, es un `cpi_iflow_configure`. `cpi_iflow_externalize` lo lista como
candidato (y también `senderAuthType`).

⚠️ **`cpi_iflow_validate` NO comprueba que el rol exista.** Un rol inventado pasa la validación:
el problema aparece al deployar o al invocar.

**⚠️ El `urlPath` del sender es lo primero.** Si clonás un molde deployado y no lo cambiás, el clon
expone **el mismo endpoint** que el original y pelea ese path con él. Si el molde está deployado,
cambiar el `urlPath` es el primer paso después de clonar, antes de cualquier otra cosa.

**🔴 `STARTED` no prueba que ande.** El deploy exitoso y el estado del runtime dicen que el bundle
resolvió, no que el mapping transforme ni que el receiver conteste. La cláusula del mapping lleva
`resolution:=optional`, así que OSGi no falla si no resuelve. **La prueba es invocar y mirar el
payload.**

**El `LogLevel=Trace` se prende a mano en la UI y no es retroactivo.** Sin eso no hay payloads por
paso. Y **se resetea al redeployar**: si redeployaste, hay que volver a prenderlo antes de invocar.

**Cero payloads tiene dos causas y no son intercambiables:** o el run no corrió en Trace, o corrió y
las trazas ya se purgaron (el payload caduca antes que el MPL). `cpi_trace` las distingue en el texto.

**El Id de un package no admite guion bajo**, aunque el de un iFlow sí. `PKGDemo` va; `PKG_Demo`
da `400`.

**Un `500` es error de negocio, no un fallo transitorio.** Nunca reintentar a ciegas.

**Un `503` del receiver suele ser el Cloud Connector, no el backend.** El mensaje nombra el location
ID. Si el túnel está recién levantado, puede tardar en tomar.
