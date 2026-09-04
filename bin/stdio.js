#!/usr/bin/env node
/**
 * Entrypoint del transporte stdio (v1, el unico).
 *
 * Lo unico que hace: cargar config -> construir el cliente -> createServer -> conectar.
 * Toda la logica vive en src/. Si esto crece, algo esta mal ubicado.
 *
 * ⚠️ En stdio, `stdout` es el canal JSON-RPC. TODO el logging va por stderr.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../src/config/local.js";
import { CpiClient } from "../src/core/client.js";
import { RuntimeClient } from "../src/core/runtime-client.js";
import { createServer, toolNames } from "../src/server.js";

const log = (...a) => console.error("[mcp-cpi]", ...a);

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    log("ERROR de configuracion:", err.message);
    process.exit(1);
  }

  // Todas las tools menos cpi_invoke viven en el plano de administracion, y cpi_invoke igual
  // necesita el plano `api` para resolver el address del endpoint. Un profile que solo trae
  // el bloque `runtime` es config valida, pero no hay nada que servir con ella.
  if (!config.oauth) {
    log(
      `ERROR de configuracion: el profile "${config.profile}" solo tiene el bloque "runtime" ` +
        `(plan 'integration-flow'). Las tools necesitan el bloque "oauth" (plan 'api').`
    );
    process.exit(1);
  }

  const client = new CpiClient({ oauth: config.oauth, label: config.label });

  // El segundo plano: solo si el profile trae la key del plan `integration-flow`.
  // Sin el, cpi_invoke se niega con un mensaje que dice que falta; el resto anda igual.
  const runtimeClient = config.runtime
    ? new RuntimeClient({ runtime: config.runtime, label: config.label })
    : null;

  log(
    `Configuracion cargada desde ${config.systemsPath}#${config.profile} ` +
      `(${config.label}, policy=${config.policy}, api=${client.apiBase})`
  );
  log(
    runtimeClient
      ? `Plano de runtime disponible (plan 'integration-flow'): ${runtimeClient.base ?? "sin url"}`
      : `Sin plano de runtime: cpi_invoke no va a poder ejecutar iFlows (falta el bloque "runtime").`
  );
  log(`${toolNames().length} tools registradas: ${toolNames().join(", ")}`);

  const server = createServer({ config, client, runtimeClient });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log("Servidor MCP listo sobre stdio.");
}

main().catch((err) => {
  log("Fallo al arrancar:", err?.stack ?? err);
  process.exit(1);
});
