#!/usr/bin/env node
/**
 * Fase 0 (parte 3) - Navegacion.
 *
 * La ronda anterior mostro que la mayoria de las entidades NO son colecciones
 * consultables de primer nivel (501 "Not implemented"): solo se llegan navegando
 * desde un puñado de puntos de entrada. Este script recorre esos caminos con IDs
 * reales del tenant.
 *
 * Tambien reintenta sin `$top` / sin `$format` las entidades que los rechazaron.
 *
 * Solo lectura. De UserCredentials/SecureParameters imprime SOLO nombres.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadProfile() {
  const systems = JSON.parse(readFileSync(join(ROOT, "systems.json"), "utf8"));
  return systems[process.env.CPI_PROFILE || Object.keys(systems)[0]].oauth;
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
  if (!res.ok) throw new Error(`Token ${res.status}`);
  return (await res.json()).access_token;
}

let API, TOKEN;

/** GET crudo. `path` va despues de /api/v1/. Pide JSON por header (no por $format). */
async function get(path) {
  const res = await fetch(`${API}/api/v1/${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, ok: res.ok, json, text };
}

/** Normaliza la respuesta OData v2: puede venir d.results (coleccion) o d (single). */
function rowsOf(json) {
  const d = json?.d;
  if (!d) return [];
  if (Array.isArray(d.results)) return d.results;
  return [d];
}

function fieldsOf(row) {
  return Object.keys(row || {}).filter((k) => k !== "__metadata");
}

/** Separa campos de datos de propiedades de navegacion (las nav vienen como {__deferred}). */
function splitFields(row) {
  const data = [];
  const nav = [];
  for (const k of fieldsOf(row)) {
    if (row[k] && typeof row[k] === "object" && "__deferred" in row[k]) nav.push(k);
    else data.push(k);
  }
  return { data, nav };
}

async function show(label, path, { onlyFieldNames = false } = {}) {
  const r = await get(path);
  const head = `  ${String(r.status).padEnd(4)} ${label}`;
  if (!r.ok) {
    const msg = r.json?.error?.message?.value ?? r.text.slice(0, 110).replace(/\s+/g, " ");
    console.log(`${head}\n       ${msg}`);
    return null;
  }
  const rows = rowsOf(r.json);
  if (!rows.length) {
    console.log(`${head}  -> 200, 0 registros`);
    return rows;
  }
  const { data, nav } = splitFields(rows[0]);
  console.log(`${head}  -> ${rows.length} reg | ${data.length} campos`);
  console.log(`       campos: ${data.join(", ")}`);
  if (nav.length) console.log(`       nav:    ${nav.join(", ")}`);
  if (!onlyFieldNames && rows[0].Id) console.log(`       ej Id:  ${rows[0].Id}`);
  return rows;
}

async function main() {
  const oauth = loadProfile();
  API = oauth.url;
  TOKEN = await fetchToken(oauth);

  // --- 1. Diseño: packages -> artefactos --------------------------------
  console.log(`\n--- diseño: navegacion desde IntegrationPackages ---`);
  const pkgs = await get("IntegrationPackages?$top=50");
  const pkgRows = rowsOf(pkgs.json);
  console.log(`  200  IntegrationPackages  -> ${pkgRows.length} packages`);
  for (const p of pkgRows.slice(0, 12)) {
    console.log(`         ${String(p.Id).padEnd(42)} "${p.Name}"`);
  }

  // Elegir un package que no sea contenido estandar de SAP (Mode/PartnerContent)
  const custom = pkgRows.find((p) => p.Mode !== "READ_ONLY") ?? pkgRows[0];
  if (custom) {
    console.log(`\n  package elegido: ${custom.Id} (Mode=${custom.Mode})`);
    for (const nav of [
      "IntegrationDesigntimeArtifacts",
      "MessageMappingDesigntimeArtifacts",
      "ScriptCollectionDesigntimeArtifacts",
      "ValueMappingDesigntimeArtifacts",
    ]) {
      await show(`…/${nav}`, `IntegrationPackages('${custom.Id}')/${nav}`);
    }
  }

  // --- 2. Runtime: artefactos deployados --------------------------------
  console.log(`\n--- deploy / runtime ---`);
  const rt = await show("IntegrationRuntimeArtifacts", "IntegrationRuntimeArtifacts?$top=5");
  if (rt?.length) {
    const id = rt[0].Id;
    await show(`…('${id}')/ErrorInformation`, `IntegrationRuntimeArtifacts('${id}')/ErrorInformation`);
    await show(`ServiceEndpoints`, `ServiceEndpoints`);
  }

  // --- 3. Monitoreo: log -> runs/errores/store --------------------------
  console.log(`\n--- monitor / trace: navegacion desde MessageProcessingLogs ---`);
  const mpl = await get("MessageProcessingLogs?$top=1&$orderby=LogEnd desc");
  const mplRows = rowsOf(mpl.json);
  if (!mplRows.length) {
    console.log("  200  MessageProcessingLogs -> 0 registros (todavia no corrio ningun mensaje)");
  } else {
    const g = mplRows[0].MessageGuid;
    console.log(`  mensaje elegido: ${g} (status=${mplRows[0].Status}, iflow=${mplRows[0].IntegrationFlowName})`);
    for (const nav of [
      "Runs",
      "ErrorInformation",
      "AdapterAttributes",
      "CustomHeaderProperties",
      "MessageStoreEntries",
      "Attachments",
    ]) {
      await show(`…/${nav}`, `MessageProcessingLogs('${g}')/${nav}`);
    }
  }

  // --- 4. Los que rechazaron $top / $format -----------------------------
  console.log(`\n--- reintento sin \$top y sin \$format=json ---`);
  for (const e of ["UserCredentials", "SecureParameters", "DataStores", "Variables", "KeystoreEntries"]) {
    await show(e, e, { onlyFieldNames: true });
  }

  console.log();
}

main().catch((e) => {
  console.error(`\nERROR: ${e.message}\n`);
  process.exitCode = 1;
});
