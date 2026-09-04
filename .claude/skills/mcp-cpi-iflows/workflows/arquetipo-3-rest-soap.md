# Arquetipo 3 — REST → SOAP (SAP provider)

Parte de la skill `mcp-cpi-iflows`. El ciclo mecánico está en `ciclo-base.md`.

**✅ Es el arquetipo probado end-to-end** — `HTTP 200` contra un proxy ABAP real. Si el proyecto tiene
un piloto de esta forma deployado, **mirarlo en vez de reconstruirlo de memoria**.

## La forma

**Acá SAP es el PROVIDER:** está del lado del receiver —le pegan a SAP— y el que llama es un sistema
externo. Por eso el trabajo del lado ABAP es de exposición (binding de SOAMANAGER, nodo ICF), no de
consumo.

**El dueño del contrato es el ABAP**, no el iFlow: el WSDL sale de SOAMANAGER y CPI lo consume. Es el
eje invertido que explica `SKILL.md` — con SAP provider, CPI hace de consumer.

**[EN PI]** un adapter REST recibe JSON de un sistema externo y sale por SOAP con message protocol XI
contra el proxy inbound del ABAP.

**[EN CPI]** el REST sender **no existe**. La traducción es:

```
sender HTTPS  →  JSON to XML  →  MM_request  →  receiver SOAP 1.x  →  MM_response  →  XML to JSON
```

Adentro todo es XML porque el Message Mapping trabaja sobre XML. La forma se conserva, el adapter no.

**El molde de esta forma trae los dos pasos de mapping** —request y response—, los XSD y un Groovy de
payload logging. Cuál es el iFlow concreto lo dice el censo del proyecto.

## 🔴 Lo que hay que arreglar del molde antes de clonarlo 15 veces

Estos defectos estaban tapados porque el molde **nunca completó un mensaje** (21 de 21 fallados). Salen
a la luz recién cuando el receiver funciona:

1. **El Groovy no define `payloadResponseXML()`**, y el modelo la llama desde un paso. Revienta con
   `No signature of method: …payloadResponseXML() is applicable for argument types`.
2. **`payloadResponseJson()` no devuelve el `message`.** Todo script de CPI tiene que retornarlo.
   Además chequea `== "TRUE"` mientras el parámetro del molde de Ventas vale `X`.

Los dos están corregidos en el clon del piloto. Lo más barato es **clonar del piloto**, no del molde
original.

## El receiver: contra SOAMANAGER, no contra el XI engine

⚠️ **Ésta es la decisión que hace que funcione.** Un molde clonado suele apuntar al **XI engine**,
`/sap/xi/engine?type=receiver&sap-client=<mandante>`, y por ahí **nunca completa**: el XI engine exige
la cabecera XI (`SAP XI Extension` en el SOAP Header) y el adapter SOAP de CPI **no la arma**.
El fault es `XIProtocol / PARSER / ITEM_MISSING`.

Los cuatro parámetros del molde que parecen servir para eso —`SI_Namespace`, `Service_Interface`,
`CC_Sender`, `CC_Receiver`— **no los referencia nada** en el bundle. Son cabos sueltos.

La pata que sí anda es el **binding de SOAMANAGER** del mismo proxy:

```
Address = http://<host virtual del Cloud Connector>/sap/bc/srt/xip/sap/<servicio>/<mandante>/<binding>/<binding>
```

`xip` es la rama de los servicios basados en **proxy** (`rfc` sería la de los basados en módulo de
funciones). El path lo genera SAP, no se elige.

## Lo que hace falta del lado ABAP

**Normalmente no hay que generar nada:** un proxy inbound ya trae su definición de servicio
autogenerada (`WEBI`). Lo que falta es:

1. **Activar el nodo ICF `xip`** — en `SICF`, `default_host/sap/bc/srt/xip`, con subárbol.
   **Se paga una sola vez por sistema**, habilita las 15. Si está apagado, el endpoint devuelve
   `403 Forbidden — Service cannot be reached` aunque los nodos de abajo estén activos, porque en ICF
   un padre inactivo hace inalcanzable todo el subárbol.
2. **Crear el binding en SOAMANAGER**, uno por interfaz. Es **configuración: no se transporta**, así
   que se rehace en DEV, QAS y PRD.

⚠️ **El binding se recrea al tocarlo.** Cada cambio borra los nodos ICF y crea otros. Si cambiaste
algo, re-copiá el `soap:address` del WSDL antes de invocar.

## Cómo diagnosticar el 403 sin la UI, si hay MCP de ABAP

El flag de activación **no está en `ICFSERVICE`**: vive en `ICFSERVLOC.ICFACTIVE`. Y los `ICF_NAME`
están en **mayúsculas** (`SRT`, `XIP`) — buscarlos en minúscula devuelve vacío sin error.

```sql
-- los nodos del binding, por su alias
SELECT icf_name, icfnodguid, icfparguid, icfaltnme FROM icfservice WHERE icfaltnme LIKE '%ZSI_IS%'
-- caminar hacia arriba por icfparguid hasta la raíz, y después:
SELECT icf_name, icfactive FROM icfservloc WHERE icf_name IN ( … )
```

Que el WSDL se baje bien y el servicio no atienda **no es contradictorio**: `wsdl` es hermano de `xip`
bajo `srt`, y puede estar activo mientras `xip` no.

## Los parámetros a configurar

| Parámetro | De dónde sale |
|---|---|
| `Address` | el binding de SOAMANAGER, por el host virtual del Cloud Connector |
| `Credential-Name` / `Credential_Name` | alias del Security Material (`cpi_credentials` lista los nombres) |
| `CC` | location ID del Cloud Connector |
| `SenderPath` | lo elegís vos — **tiene que ser único en el tenant** |
| `RootElementName` / `RootElementNamespace` | el message type **source** del mapping de request: `MT_request` y su namespace |
| `NamespaceMapping` | el mismo prefijo y URI que `RootElementNamespace` |

`SI_Namespace`, `Service_Interface`, `CC_Sender` y `CC_Receiver` se pueden **borrar** yendo por SOAP:
no los usa nadie.

## Antes de dar por buena la prueba

Una respuesta vacía puede ser correcta. Caso medido: el function module levantaba `not_found` cuando
no había datos y la clase proxy **no propagaba la excepción** — devolvía el output vacío. Desde CPI,
**"no hay datos" y "falló" se ven igual**. Verificá con datos que existan antes de concluir.
