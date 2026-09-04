#!/usr/bin/env node
/**
 * Sonda SOLO LECTURA: compara el enganche que escribio la UI contra el que genera el MCP.
 *
 * `cpi_iflow_mapping` escribe dos archivos del bundle, y un error ahi no falla al escribir:
 * falla al deployar, con un error de resolucion OSGi que no menciona el mapping. La prueba
 * fuerte seria escribir y deployar; esta sonda consigue casi lo mismo sin tocar el tenant,
 * porque el tenant YA tiene un iFlow que la UI dejo enganchado. Si lo que produciriamos
 * coincide con lo que produjo SAP, el formato esta bien.
 *
 *   node scripts/probe-mapping-reference.js [iflowId] [mappingId]
 *
 * Default: test / MM_TEST_TRIVIAL. NO escribe nada, ni en el tenant ni en disco.
 */

import { loadConfig } from "../src/config/local.js";
import { CpiClient } from "../src/core/client.js";
import { downloadArtifact } from "../src/core/ops/design.js";
import { readZip } from "../src/core/zip.js";
import { mappingSteps, setMappingReference } from "../src/core/iflw.js";
import { addRequireCapability, messageMappingCapability } from "../src/core/ops/write.js";

const iflowId = process.argv[2] ?? "test";
const mappingId = process.argv[3] ?? "MM_TEST_TRIVIAL";

const log = (...a) => console.log(...a);
let fallos = 0;

function comparar(titulo, esperado, obtenido) {
  const ok = esperado === obtenido;
  if (!ok) fallos++;
  log(`${ok ? "  OK  " : "  ✗   "} ${titulo}`);
  if (!ok) {
    log(`        UI  : ${JSON.stringify(esperado)}`);
    log(`        MCP : ${JSON.stringify(obtenido)}`);
  }
}

async function main() {
  const config = loadConfig();
  const client = new CpiClient({ oauth: config.oauth, label: config.label });
  log(`Tenant: ${config.label}`);
  log(`iFlow "${iflowId}" vs mapping "${mappingId}"\n`);

  const mzip = await downloadArtifact(client, mappingId, { kind: "mapping" });
  const mmapPath = readZip(mzip).find((e) => e.name.endsWith(".mmap"))?.name;
  if (!mmapPath) throw new Error(`El bundle de "${mappingId}" no tiene .mmap`);
  log(`.mmap en el bundle del mapping: ${mmapPath}\n`);

  const zip = await downloadArtifact(client, iflowId);
  const entries = readZip(zip, { content: true });
  const iflwEntry = entries.find((e) => e.name.endsWith(".iflw"));
  const iflwUI = iflwEntry.data.toString("utf8");

  const pasos = mappingSteps(iflwUI);
  log(`== pasos de mapping en el modelo (${pasos.length}) ==`);
  for (const p of pasos) {
    log(`  ${p.id} "${p.name}" -> bundleId=${p.messageMappingBundleId || "(vacio: embebido)"}`);
  }

  const referenciado = pasos.find((p) => p.messageMappingBundleId === mappingId);
  if (!referenciado) {
    log(`\nNingun paso referencia a "${mappingId}": no hay contra que comparar.`);
    log(`Si los pasos figuran como embebidos, el .mmap vive adentro del bundle del iFlow y`);
    log(`la comparacion no aplica — ese es otro caso, no un enganche por referencia.`);
    return;
  }

  // Reaplicamos NUESTRO enganche sobre el modelo que ya escribio la UI. Si el formato coincide,
  // tiene que ser un no-op: mismo texto, byte por byte.
  log(`\n== .iflw: paso ${referenciado.id} ==`);
  const r = setMappingReference(iflwUI, { step: referenciado.id, mappingId, mmapPath });
  comparar("el modelo entero queda igual (nuestro enganche es un no-op)", iflwUI, r.xml);
  for (const [k, v] of Object.entries(r.values)) log(`        ${k} = ${v}`);
  if (r.agregadas.length) log(`        (claves que la UI no tenia: ${r.agregadas.join(", ")})`);

  log(`\n== MANIFEST.MF ==`);
  const manUI = entries.find((e) => e.name === "META-INF/MANIFEST.MF").data.toString("utf8");
  const man = addRequireCapability(manUI, messageMappingCapability(mappingId));
  comparar("la capability ya estaba y no se duplica", false, man.changed);
  comparar("el manifiesto queda igual", manUI.replace(/\r\n/g, "\n"), man.text);

  const header = manUI.split(/\r?\n/).filter((l) => l.startsWith("Require-Capability:"));
  log(`        UI escribio: ${header[0]}`);

  log(`\n${fallos ? `✗ ${fallos} diferencia(s)` : "✓ el bundle que generariamos es el que ya esta"}`);
  process.exitCode = fallos ? 1 : 0;
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  if (e.hint) console.error("Sugerencia:", e.hint);
  process.exitCode = 1;
});
