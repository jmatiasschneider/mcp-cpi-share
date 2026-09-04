# Las formas que faltan: RFC→SOAP, SOAP→SOAP y los dos casos únicos

Parte de la skill `mcp-cpi-iflows`. El ciclo mecánico está en `ciclo-base.md`.

**Ninguna de estas está probada.** Este archivo dice lo que ya se sabe y, sobre todo, **qué es lo que
todavía no se sabe**, para que nadie lo dé por resuelto.

---

## Arquetipo 2 — RFC → SOAP (SAP consumer) 🔴 no es un problema de molde

**Acá SAP es el CONSUMER:** el ABAP dispara el RFC, o sea que está del lado del sender.

**[EN CPI] no existe adapter RFC sender.** El RFC en CPI existe **sólo como receiver**. Así que un ICO
donde el ABAP llama al PI por RFC **no se migra clonando un iFlow**.

Lo que hay que hacer es invertir quién llama: el ABAP tiene que **consumir un web service** en vez de
disparar un RFC.

1. El iFlow se arma con **sender SOAP** (o sea, la forma del arquetipo 1 de la cintura para arriba).
2. Se toma el **WSDL que emite ese iFlow**.
3. En ABAP se genera un **consumer proxy outside-in** contra ese WSDL, con `SPROXY`.
4. Se crea el **logical port** en SOAMANAGER, apuntando al endpoint del iFlow.
5. El código ABAP que hoy hace `CALL FUNCTION … DESTINATION` pasa a llamar al proxy.

**Eso es trabajo del lado ABAP, no del MCP**, y es la razón por la que esta forma no entra en el plan
de "clonar y configurar".

⚠️ **Y suele venir acompañada.** Donde el ABAP dispara un RFC contra un organismo fiscal, es probable
que el mapping además haga **lookup por canal** para resolver autenticación — algo que en CPI un
mapping **no puede hacer**. Esa parte se rediseña, no se convierte.

⚠️ **Ojo con el contrato acá:** con SAP consumer el que sirve es **CPI**, así que el **provider del
contrato es el iFlow**. Si su WSDL cambia, hay que **regenerar el consumer proxy** en ABAP. Es lo
opuesto al arquetipo 3, donde sirve el ABAP.

**Lo que falta averiguar:** si el WSDL que emite un sender SOAP de CPI se deja consumir sin retoques
por `SPROXY`. Es una prueba de media hora y destraba **toda la familia donde SAP consume por RFC** —
en un parque con mucho RFC saliente, la porción más cara. Cuánto pesa lo dice el censo del proyecto.

---

## Arquetipo 4 — SOAP → SOAP (SAP provider)

**Acá SAP es el PROVIDER:** el receiver es SAP, igual que en el arquetipo 3.

**No hay molde en el tenant.** En teoría es la forma **más simple de todas**: SOAP de un lado, SOAP del
otro, y ninguna conversión JSON en el medio.

El camino más corto sería partir del piloto del arquetipo 3 y **sacarle los dos pasos de conversión**
(`JSON to XML` y `XML to JSON`), cambiando el sender HTTPS por uno SOAP. Sacar pasos del modelo no lo
hace ninguna tool: es editor web.

Aplica lo mismo del arquetipo 3 para la pata del receiver: binding de SOAMANAGER, nodo `xip` activo.

---

## Los dos casos únicos

| Forma | Rol de SAP | Qué implica |
|---|---|---|
| **REST → RFC** | **SAP provider** | el receiver RFC **sí existe** en CPI. Es la única forma que lo usa |
| **RFC → REST** | **SAP consumer** | mismo problema que el arquetipo 2: no hay RFC sender. Hay que invertir la llamada |

Se llaman "únicos" porque en el parque donde se escribió esto había **uno de cada uno**, y con ese
volumen no justifican arquetipo: se resuelven a mano cuando toque. Cuántos hay en el tuyo lo dice el
censo del proyecto — si son muchos, dejan de ser casos únicos.

---

## Sobre el conteo

**[EN PI]** Las formas salen de cruzar el inventario de ICOs con el de canales. Los nombres de las
formas son **adapters de PI**, y varios no existen con ese nombre en CPI — por eso cada arquetipo
necesita una traducción y no un mapeo uno a uno. **Cuántos ICOs cae en cada forma es dato del
proyecto**, no de esta skill.

Tres cosas que conviene medir en cualquier parque antes de diseñar los moldes:

- **Si hay multicast.** Un ICO con más de un receiver no se migra con el mismo molde.
- **Cuántos llevan mapping.** Si es casi todos, el paso de Message Mapping va en el molde base.
- **Cuántas operaciones lleva cada ICO.** Un ICO puede llevar varias, cada una con su interfaz
  inbound, su operation mapping y su canal — y ahí la unidad de migración deja de ser el ICO.

🔴 **Y una trampa: la QoS del inventario de ICOs no sirve como dato de diseño.** Puede decir `EO`
incluso para interfaces sincrónicas. El modo sync/async es propiedad del **Service Interface** y sale
del ESR (`<operation isSynchronous="true">`), no del Directory.
