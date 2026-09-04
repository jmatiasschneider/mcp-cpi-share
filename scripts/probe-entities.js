#!/usr/bin/env node
/**
 * Fase 0 (parte 2) - Prueba de lectura real por entidad.
 *
 * Para cada EntitySet candidato hace `?$top=1&$format=json` y reporta:
 *   - status HTTP (200 / 400 / 403 / 501 ...)
 *   - cantidad de registros devueltos
 *   - los NOMBRES de los campos del primer registro
 *
 * Solo lectura. Nunca imprime valores de campos que puedan ser sensibles
 * (UserCredentials / SecureParameters: solo nombres de campo, nunca contenido).
 *
 * Uso:  node scripts/probe-entities.js
 *       node scripts/probe-entities.js IntegrationPackages ServiceEndpoints
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Entidades candidatas, agrupadas por el paso del ciclo de desarrollo que sirven. */
const CANDIDATES = [
  ["diseño", "IntegrationPackages"],
  ["diseño", "IntegrationDesigntimeArtifacts"],
  ["diseño", "IntegrationFlows"],
  ["diseño", "MessageMappingDesigntimeArtifacts"],
  ["diseño", "ScriptCollectionDesigntimeArtifacts"],
  ["diseño", "ValueMappingDesigntimeArtifacts"],
  ["diseño", "IntegrationDesigntimeLocks"],
  ["deploy", "IntegrationRuntimeArtifacts"],
  ["deploy", "BuildAndDeployStatus"],
  ["deploy", "RuntimeArtifactErrorInformations"],
  ["probar", "ServiceEndpoints"],
  ["monitor", "MessageProcessingLogs"],
  ["monitor", "MessageProcessingLogErrorInformations"],
  ["monitor", "MessageProcessingLogRuns"],
  ["monitor", "MessageProcessingLogRunSteps"],
  ["monitor", "MessageProcessingLogAdapterAttributes"],
  ["trace", "TraceMessages"],
  ["trace", "TraceMessageProperties"],
  ["trace", "MessageStoreEntries"],
  ["trace", "LogFiles"],
  ["runtime", "DataStores"],
  ["runtime", "DataStoreEntries"],
  ["runtime", "Variables"],
  ["runtime", "JmsQueues"],
  ["seguridad", "UserCredentials"],
  ["seguridad", "SecureParameters"],
  ["seguridad", "KeystoreEntries"],
  ["gobierno", "AuditLogs"],
  ["gobierno", "CustomTagConfigurations"],
];

function loadProfile() {
  const systems = JSON.parse(readFileSync(join(ROOT, "systems.json"), "utf8"));
  const name = process.env.CPI_PROFILE || Object.keys(systems)[0];
  return systems[name].oauth;
}

async function fetchToken({ clientid, clientsecret, tokenurl }) {
  const basic = Buffer.from(`${clientid}:${clientsecret}`).toString("base64");
  const res = await fetch(tokenurl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`Token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).access_token;
}

async function probe(apiBase, token, entity) {
  const url = `${apiBase}/api/v1/${entity}?$top=1&$format=json`;
  let res, text;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    text = await res.text();
  } catch (e) {
    return { entity, status: "ERR", note: e.message.slice(0, 80) };
  }

  if (!res.ok) {
    // OData v2 mete el mensaje util en error.message.value
    let note = text.slice(0, 120).replace(/\s+/g, " ");
    try {
      note = JSON.parse(text)?.error?.message?.value ?? note;
    } catch {}
    return { entity, status: res.status, note };
  }

  let rows;
  try {
    rows = JSON.parse(text)?.d?.results ?? [];
  } catch {
    return { entity, status: res.status, note: "respuesta no-JSON" };
  }

  // Solo nombres de campo. Nunca valores: alguna de estas entidades es sensible.
  const fields = rows[0]
    ? Object.keys(rows[0]).filter((k) => k !== "__metadata")
    : [];
  return { entity, status: res.status, count: rows.length, fields };
}

async function main() {
  const oauth = loadProfile();
  const token = await fetchToken(oauth);
  const apiBase = oauth.url;

  const filter = process.argv.slice(2);
  const list = filter.length
    ? CANDIDATES.filter(([, e]) => filter.includes(e))
    : CANDIDATES;

  console.log(`\n=== probe de entidades (${list.length}) ===\n`);

  let grupo = null;
  for (const [g, entity] of list) {
    if (g !== grupo) {
      grupo = g;
      console.log(`--- ${g} ---`);
    }
    const r = await probe(apiBase, token, entity);
    const head = `  ${String(r.status).padEnd(4)} ${entity.padEnd(38)}`;

    if (r.status !== 200) {
      console.log(`${head} ${r.note ?? ""}`);
      continue;
    }
    if (r.count === 0) {
      console.log(`${head} OK pero 0 registros (sin datos en el tenant)`);
      continue;
    }
    console.log(`${head} ${r.fields.length} campos`);
    console.log(`       ${r.fields.join(", ")}`);
  }
  console.log();
}

main().catch((e) => {
  console.error(`\nERROR: ${e.message}\n`);
  process.exitCode = 1;
});
