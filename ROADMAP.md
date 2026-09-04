# ROADMAP

Lo que falta **en el MCP**, y lo que se decidió no hacer.

Este archivo existe porque lo pendiente no tenía dónde vivir: `DISCOVERY.md` registra lo verificado
contra el tenant, `CLAUDE.md` orienta el trabajo diario y el `PLAN` es el diseño original. Ninguno es
un backlog. Cuando algo de acá se hace, se borra de acá y el hallazgo técnico va a DISCOVERY.

🔴 **Backlog del server, no del proyecto de migración.** Lo que falta para migrar las interfaces
—arquetipos, mapeos, bindings, consumidores— vive en el workspace del proyecto que usa este server.
Acá solo entra trabajo que se resuelve **escribiendo código en este repo**.

**Estado al 2026-08-11:** 20 tools, **todas verificadas end-to-end contra el tenant**. El ciclo del iFlow está
cerrado (`crear el package → clonar → externalizar → configurar → enganchar el mapping → validar →
deployar → invocar → leer el log y los payloads → undeploy → borrar`). La lógica pura tiene **135
unitarios** en `test/` (contados el 2026-08-19), que corren con `npm test` sin tocar el tenant. El
`kind` llega hasta la superficie: las cuatro familias de artefacto se listan, leen, clonan,
actualizan, deployan y borran con las mismas tools.

**Y el DISCOVERY se quedó sin preguntas abiertas**: las cuatro que arrastraba se respondieron el
2026-08-10. Dos de las respuestas destaparon defectos propios, ya arreglados: `deployedErrorInfo()`
devolvía `null` siempre —un deploy en ERROR no decía por qué— y `cpi_iflow_validate` volcaba ~100
frames de stack de Java por una excepción.

### Por dónde seguir

**No queda nada construible en el MCP.** Los dos ítems que quedaban se hicieron el 2026-08-11
(`cpi_trace` y `cpi_package_create`); el hallazgo que salió de construir el primero —que el payload
caduca antes que el MPL— está en DISCOVERY.

**Y eso no es una pausa a la espera de prioridades: es que la ruta crítica no pasa por acá.** El
trabajo que sigue es de migración, y se hace *usando* estas tools, no agrandándolas. Si aparece
trabajo nuevo en el server, los dos candidatos naturales son:

- **Escribir credenciales.** Hoy un alias nuevo se crea a mano en la UI. No está acá como tarea
  porque **implica mandar un secreto por la API**, y eso merece decidirse aparte y no de paso. Ver
  la convención de `CREDENTIAL_SAFE_FIELDS` en `ops/runtime.js` antes de tocar nada.
- **`cpi_package_delete`.** Deliberadamente no existe: borrar un package se lleva puesto todo lo
  que tiene adentro. `scripts/test-write-cycle.js` lo hace crudo contra el cliente, que es el único
  lugar donde hace falta.

---

## Decidido NO hacer (por ahora)

Lo que sigue no está pendiente: está descartado a propósito. Si se revisita, que sea con un motivo
nuevo y no por olvido.

### Fase 2 — deploy remoto en BTP

Sigue sin razón concreta. El [PLAN](PLAN-mcp-integration-suite.md) ya advierte contra hacerlo "porque
se puede": un MCP remoto es una URL en internet con las tools de escritura de este proyecto.

Solo si aparece una de dos razones: que lo use más gente del equipo, o correrlo sin la laptop del
consultor. Y antes de construirlo, evaluar el **MCP Gateway** de SAP Integration Suite, que podría
cubrir la parte de CPI sin hostear nada propio.

### El conversor de mapeos del ESR

**Decidido el 2026-08-12: no se construye.** Quedan descartados `src/core/esr/tpz.js`,
`src/core/mapping.js` y `scripts/convertir.js`.

El porqué es del proyecto de migración y vive en su workspace, pero la
consecuencia para este repo se anota acá para que no se re-proponga: **el importador nativo de SAP
cubre el 94% y no requiere código**. Y si algún día se revisitara, **no iría como tool**: el
`$metadata` del tenant no tiene ninguna superficie de TPZ ni de migración, así que no hay nada que
consultar — sería **biblioteca + script**, con la salida revisada antes de acercarse al tenant.
