#!/usr/bin/env node
/**
 * Sonda: los DOS endpoints de descarga de contenido de diseño (verificados el 2026-08-26).
 *
 *   GET IntegrationPackages('<Id>')/$value                              -> zip del package (Export de la UI)
 *   GET IntegrationDesigntimeArtifacts(Id='<id>',Version='<v>')/$value  -> bundle del artefacto
 *
 * Lo que dejo verificado (detalle en DISCOVERY.md):
 *   - El zip del package trae un `<guid>_content` por artefacto (el bundle, sin `metainfo.prop`)
 *     y la metadata del export; `resources.cnt` es JSON en base64 con el mapa guid -> Id.
 *   - Un package con CUALQUIER artefacto sin versionar (draft) NO exporta: 500 listando los
 *     drafts. En el listado OData el draft se reconoce por Version='Active' (o 'Draft').
 *   - El bundle individual de un artefacto en draft SI se baja.
 *   - Id inexistente: 404 en ambos, con el error OData en XML (no JSON).
 *
 * Solo lectura contra el tenant. Escribe los zips en discovery-raw/ (gitignoreado).
 *
 *   node scripts/probe-package-download.js [packageId]   (default: el primero que exporte OK)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config/local.js";
import { CpiClient, odataQuote } from "../src/core/client.js";
import { listPackages, listArtifacts, artifactKinds, artifactKey, downloadPackage } from "../src/core/ops/design.js";
import { readZip } from "../src/core/zip.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "discovery-raw");

// El draft no dice "Draft" siempre: un artefacto editado en la UI y nunca versionado lista
// Version='Active'; uno creado por API sin version lista 'Draft'. Ambos bloquean el export.
const esDraft = (a) => a.Version === "Active" || a.Version === "Draft";

const log = (...a) => console.log(...a);

async function main() {
  const config = loadConfig();
  const client = new CpiClient({ oauth: config.oauth, label: config.label });
  log(`Tenant: ${config.label} (${client.apiBase})\n`);
  mkdirSync(OUT, { recursive: true });

  // -- inventario + intento de export de cada package --------------------------------------
  const { rows: pkgs } = await listPackages(client, { top: 100 });
  const drafts = [];
  const exportables = [];

  for (const p of pkgs) {
    const arte = [];
    for (const kind of artifactKinds()) {
      const { rows } = await listArtifacts(client, p.Id, { kind, top: 200 }).catch(() => ({ rows: [] }));
      for (const a of rows) {
        arte.push(`${kind}:${a.Id}@${a.Version}${esDraft(a) ? " ⚠️draft" : ""}`);
        if (esDraft(a)) drafts.push({ kind, id: a.Id, pkg: p.Id });
      }
    }

    let estado;
    try {
      const buf = await downloadPackage(client, p.Id);
      exportables.push({ id: p.Id, buf });
      estado = `✓ exporta (${buf.length} bytes)`;
    } catch (e) {
      estado = `✗ ${e.message.slice(0, 130)}`;
    }
    log(`${p.Id}  ${estado}`);
    for (const a of arte) log(`    ${a}`);
  }

  // -- estructura del zip de un export exitoso ----------------------------------------------
  const elegido = process.argv[2]
    ? exportables.find((e) => e.id === process.argv[2])
    : exportables[0];
  if (elegido) {
    const entries = readZip(elegido.buf, { content: true });
    log(`\n== zip de ${elegido.id}: ${elegido.buf.length} bytes, ${entries.length} entradas ==`);
    for (const e of entries) log(`  ${String(e.size).padStart(9)}  ${e.name}`);
    const cnt = entries.find((e) => e.name === "resources.cnt");
    if (cnt) {
      const json = JSON.parse(Buffer.from(cnt.data.toString("utf8"), "base64").toString("utf8"));
      log(`  resources.cnt (guid -> Id):`);
      for (const r of json.resources ?? []) log(`    ${r.id} -> ${r.uniqueId} (${r.name})`);
    }
    const dest = join(OUT, `package-${elegido.id}.zip`);
    writeFileSync(dest, elegido.buf);
    log(`  guardado en ${dest}`);
  } else {
    log(`\n(ningun package exporta OK hoy: todos tienen drafts)`);
  }

  // -- bundle directo de un draft -----------------------------------------------------------
  log(`\n== bundle directo de un draft ==`);
  if (drafts.length) {
    const d = drafts[0];
    try {
      const buf = await client.get(`${artifactKey(d.kind, d.id, "active")}/$value`, { raw: true });
      log(`  ${d.kind} ${d.id} (draft, package ${d.pkg}) /$value -> ${buf.length} bytes ✓`);
    } catch (e) {
      log(`  ${d.kind} ${d.id} /$value -> HTTP ${e.status}`);
    }
  } else {
    log(`  (no hay ningun draft en el tenant hoy)`);
  }

  // -- Ids inexistentes ---------------------------------------------------------------------
  log(`\n== Ids inexistentes ==`);
  for (const [titulo, path] of [
    ["package ZZNOEXISTE", `IntegrationPackages('ZZNOEXISTE')/$value`],
    ["iflow ZZNOEXISTE  ", `IntegrationDesigntimeArtifacts(Id='ZZNOEXISTE',Version='active')/$value`],
  ]) {
    try {
      const buf = await client.get(path, { raw: true });
      log(`  ${titulo} -> ${buf.length} bytes (!!)`);
    } catch (e) {
      log(`  ${titulo} -> ${e.message}`);
    }
  }
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  if (err.url) console.error(`  URL: ${err.url}`);
  process.exit(1);
});
