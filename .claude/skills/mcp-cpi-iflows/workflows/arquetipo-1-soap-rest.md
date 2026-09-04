# Arquetipo 1 — SOAP → REST (SAP consumer)

Parte de la skill `mcp-cpi-iflows`. El ciclo mecánico está en `ciclo-base.md`.

**⚠️ No probado end-to-end por nosotros.** Lo de acá sale de leer el `.iflw` del molde contra el
tenant (2026-08-18), no de haberlo ejecutado. El arquetipo 3 sí está probado: si podés empezar por uno,
empezá por ése.

## La forma

Es el arquetipo 3 al revés: **el que sirve es el iFlow** —sender SOAP, dueño del WSDL— y **el tercero
está del lado del receiver**, por REST.

**Acá SAP es el CONSUMER:** está del lado del sender —llama por SOAP— y el tercero está en el
receiver. **Es el bloque que no obliga a tocar el ABAP**, justamente porque SAP ya llama por SOAP.

⚠️ **No leerlo como "SAP expone".** El endpoint SOAP lo publica CPI, no el ABAP; quien lo *llama* es
SAP: el iFlow va **de SAP hacia el tercero**. "SAP expone" sería *SAP provider*, que es justo lo que
acá **no** pasa. Que haya un sender SOAP no significa que SAP provea: **el provider del contrato es
CPI**, y por eso hay que decir siempre de quién se habla.

```
sender SOAP  →  (mapping de request, si hace falta)  →  receiver HTTP/REST  →  MM_response  →  respuesta
```

**Qué forma tiene que tener el molde** — cuál es el iFlow concreto lo dice el censo del proyecto:

| | forma |
|---|---|
| sender | **SOAP 1.x**, `urlPath` propio, autenticación `RoleBased` |
| receiver | **HTTP** contra la API del tercero, `{{Address}}` externalizado, proxy `default` |
| mappings | **uno o dos**, según si el receiver lleva body — ver abajo |

ℹ️ El molde sobre el que se escribió esto era un `GET` sin body de request, con un solo mapping de
response. Es un caso, no la regla.

## 🔴 El molde no tiene paso de mapping de request

Su receiver es un `GET` con los parámetros en la query, así que no hay body que mapear. Si tu interfaz
manda un body —un `POST` contra la API del tercero—, **ese paso hay que agregarlo a mano en el editor
web**: `cpi_iflow_mapping` engancha sobre un paso que ya existe, no lo crea.

Es la diferencia práctica más importante con el arquetipo 3, cuyo molde ya trae los dos.

## Lo que hay que limpiar del molde

🔴 **Un molde que salió de clonar otro arrastra los parámetros del escenario original** —namespace,
service interface, description— apuntando al lugar equivocado. Los valores viejos sobreviven al
clonado porque nadie los limpia.

**Revisá cada parámetro externalizado antes de heredarlo**, y si alguno nombra un escenario que no
es el tuyo, preguntá: o está mal apuntado, o es ruido.

## Lo que cambia respecto del arquetipo 3

**El sender es SOAP, así que el iFlow emite WSDL.** Eso importa para el contrato: acá **el que sirve es
CPI**, así que el iFlow es el dueño del contrato y SAP genera su cliente contra ese WSDL. En el
arquetipo 3 es al revés — sirve el ABAP y el WSDL sale de SOAMANAGER.

**El `Address` del receiver es una URL de un tercero**, no del Cloud Connector. Si la API es pública,
`proxyType: default` y no interviene el SCC. Si es interna, `sapcc` y hace falta el mapeo.

**Externalizá el `httpAddressWithoutQuery`**, que es donde vive la URL del receiver en el adapter HTTP
(en el SOAP receiver la clave es `address`).

⚠️ **Un sender SOAP no se invoca por la misma ruta que uno HTTPS.** El runtime lo sirve bajo
`/cxf/<address>` y no bajo `/http/<address>`; `cpi_invoke` con `iflow` lo resuelve solo desde el
`Protocol` de `ServiceEndpoints`, pero con `address` a mano hay que escribir `cxf/<path>`. Por la
ruta equivocada contesta **404 el Tomcat**, con el iFlow `STARTED` y sin dejar rastro en el monitor.

## Qué falta verificar

- Que el sender SOAP invocado con `cpi_invoke` complete el flujo igual que uno HTTPS: la ruta ya está
  resuelta (`/cxf/`), falta confirmar el envelope —no JSON— y si hace falta un header `SOAPAction`.
- Cómo responde el molde cuando el tercero devuelve un error HTTP.
- Si el WSDL que emite el iFlow sirve tal cual para generar un consumer proxy en ABAP — eso es lo que
  destraba el arquetipo 2 (ver `arquetipos-sin-probar.md`).
