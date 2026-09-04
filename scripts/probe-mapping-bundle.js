#!/usr/bin/env node
/**
 * Sonda: baja el bundle de un artefacto que NO es un iFlow y lista/vuelca su contenido.
 *
 * Existe porque el bloqueo del punto 3 del ROADMAP era de datos: sin un message mapping en el
 * tenant no se podia ver el formato del `.mmap`. Esta sonda es lo primero que se corre cuando
 * aparece uno, y valida de paso que la parametrizacion del entity set (`kind`) funcione contra
 * el tenant real y no solo en los unitarios.
 *
 *   node scripts/probe-mapping-bundle.js [kind] [id]
 *
 * Default: mapping MM_TEST_TRIVIAL. Escribe los archivos en discovery-raw/<id>/ (gitignoreado).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config/local.js";
import { CpiClient } from "../src/core/client.js";
import { readArtifact, downloadArtifact, listResources } from "../src/core/ops/design.js";
import { readZip } from "../src/core/zip.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const kind = process.argv[2] ?? "mapping";
const id = process.argv[3] ?? "MM_TEST_TRIVIAL";

// El artefacto recien creado figura con Version "Draft" en la navegacion del package, pero la
// key canonica de designtime es 'active'. Se prueban las dos antes de darlo por perdido.
const VERSIONES = ["active", "Draft", "1.0.0"];

const log = (...a) => console.log(...a);

async function main() {
  const config = loadConfig();
  const client = new CpiClient({ oauth: config.oauth, label: config.label });
  log(`Tenant: ${config.label} (${client.apiBase})\n`);

  let version = null;
  let meta = null;
  for (const v of VERSIONES) {
    meta = await readArtifact(client, id, { kind, version: v }).catch(() => null);
    if (meta) {
      version = v;
      break;
    }
    log(`  Version='${v}' -> no responde`);
  }
  if (!meta) throw new Error(`No se pudo leer ${kind} "${id}" con ninguna de: ${VERSIONES.join(", ")}`);

  log(`\n== metadata (Version='${version}') ==`);
  for (const [k, v] of Object.entries(meta)) log(`  ${k}: ${v}`);

  const resources = await listResources(client, id, { kind, version }).catch((e) => {
    log(`\n(Resources fallo: ${e.message})`);
    return [];
  });
  if (resources.length) {
    log(`\n== Resources (${resources.length}) ==`);
    for (const r of resources) log(`  ${r.Name}  [${r.ResourceType ?? "?"}]`);
  }

  const zip = await downloadArtifact(client, id, { kind, version });
  const entries = readZip(zip, { content: true });
  log(`\n== bundle: ${zip.length} bytes, ${entries.length} archivos ==`);
  for (const e of entries) log(`  ${String(e.size).padStart(8)}  ${e.name}`);

  const outDir = join(ROOT, "discovery-raw", id);
  mkdirSync(outDir, { recursive: true });
  for (const e of entries) {
    const dest = join(outDir, e.name.replace(/\//g, "__"));
    writeFileSync(dest, e.data);
  }
  log(`\nArchivos volcados en discovery-raw/${id}/`);
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  if (err.url) console.error(`  URL: ${err.url}`);
  process.exit(1);
});
