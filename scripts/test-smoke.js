#!/usr/bin/env node
/**
 * Prueba de humo end-to-end contra el tenant REAL, solo lectura.
 *
 * Ejercita cada tool por su handler (misma ruta de codigo que usa el server MCP,
 * salteando el transporte) y muestra la salida tal cual la veria Claude.
 *
 * Secuencia del PLAN: ping -> packages -> iFlow test -> ultimos mensajes.
 *
 * Uso: node scripts/test-smoke.js
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config/local.js";
import { CpiClient } from "../src/core/client.js";

import * as ping from "../src/tools/cpi-ping.js";
import * as packages from "../src/tools/cpi-packages.js";
import * as iflowList from "../src/tools/cpi-iflow-list.js";
import * as iflowRead from "../src/tools/cpi-iflow-read.js";
import * as download from "../src/tools/cpi-download.js";
import * as messages from "../src/tools/cpi-messages.js";
import * as messageDetail from "../src/tools/cpi-message-detail.js";
import * as trace from "../src/tools/cpi-trace.js";
import * as deployed from "../src/tools/cpi-deployed.js";
import * as credentials from "../src/tools/cpi-credentials.js";

const config = loadConfig();
const client = new CpiClient({ oauth: config.oauth, label: config.label });
const ctx = {
  client,
  policy: config.policy,
  profile: config.profile,
  label: config.label,
  identity: config.oauth.clientid,
};

let failures = 0;

async function run(mod, args, title) {
  const name = mod.definition.name;
  console.log(`\n${"=".repeat(72)}\n${name}  ${title ? `— ${title}` : ""}\n${"=".repeat(72)}`);
  const t0 = Date.now();
  const res = await mod.handler(args, ctx);
  const ms = Date.now() - t0;
  const text = res.content?.map((c) => c.text).join("\n") ?? "";

  if (res.isError) {
    failures++;
    console.log(`✗ ERROR (${ms} ms)\n${text}`);
  } else {
    console.log(`✓ ${ms} ms\n\n${text}`);
  }
  return { res, text };
}

async function main() {
  await run(ping, {}, "conectividad y scopes");
  await run(packages, {}, "packages del tenant");
  await run(iflowList, { packageId: "DEVtest" }, "iFlows del package DEVtest");
  await run(iflowRead, { id: "test", includeContent: true }, "detalle + bundle del iFlow test");

  // Modo artefacto a proposito: el modo package depende de que NINGUN artefacto del package
  // este en draft, y eso cambia con el trabajo diario del equipo — seria un smoke que falla
  // por razones ajenas al server.
  const zipTmp = join(tmpdir(), `smoke-cpi-download-${process.pid}.zip`);
  await run(download, { id: "test", saveTo: zipTmp }, "bundle del iFlow test a disco");
  rmSync(zipTmp, { force: true });
  await run(deployed, { withEndpoints: true }, "runtime + endpoints");
  await run(credentials, {}, "nombres de credenciales");

  const { text } = await run(messages, { top: 5 }, "ultimos 5 mensajes");

  // Encadenar: sacar un MessageGuid de la salida anterior y pedir su detalle
  const guid = /\b([A-Za-z0-9_-]{28})\b/.exec(text)?.[1];
  if (guid) {
    await run(messageDetail, { messageGuid: guid }, `detalle del mensaje ${guid}`);
    // cpi_trace sobre el mismo mensaje. Que no haya payloads NO es un fallo: solo los hay si
    // ese run corrio con LogLevel=Trace, que se prende a mano en la UI y caduca en ~1 h. Lo que
    // esta prueba verifica es que la cadena entera navegue sin romperse.
    await run(trace, { messageGuid: guid, maxBytes: 400 }, `payload por paso de ${guid}`);
  } else {
    console.log("\n(no se encontro un MessageGuid en la salida anterior; se saltean cpi_message_detail y cpi_trace)");
  }

  console.log(`\n${"=".repeat(72)}`);
  if (failures) {
    console.log(`✗ ${failures} tool(s) fallaron.`);
    process.exitCode = 1;
  } else {
    console.log(`✓ Todas las tools respondieron OK contra ${config.label}.`);
  }
}

main().catch((e) => {
  console.error(`\nERROR fatal: ${e.stack ?? e.message}\n`);
  process.exitCode = 1;
});
