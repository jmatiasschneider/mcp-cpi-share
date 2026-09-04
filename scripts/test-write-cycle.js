#!/usr/bin/env node
/**
 * Ciclo de escritura end-to-end contra el tenant REAL.
 *
 * ⚠️ ESCRIBE: crea un package descartable, clona adentro el iFlow indicado bajo un Id
 *    descartable, lo lee, lo configura, lo valida y BORRA las dos cosas. NO deploya nada:
 *    no toca el runtime.
 *
 * El package se crea de verdad y el clon va adentro a proposito: es lo que prueba que un
 * package recien creado sirve para lo unico que importa, que es alojar artefactos.
 *
 * Uso: node scripts/test-write-cycle.js [sourceId] [packageId]
 *      (default: test / uno descartable que se crea y se borra)
 */

import { loadConfig } from "../src/config/local.js";
import { CpiClient } from "../src/core/client.js";
import { readZip } from "../src/core/zip.js";
import { downloadArtifact } from "../src/core/ops/design.js";

import * as packageCreate from "../src/tools/cpi-package-create.js";
import * as clone from "../src/tools/cpi-iflow-clone.js";
import * as read from "../src/tools/cpi-iflow-read.js";
import * as configure from "../src/tools/cpi-iflow-configure.js";
import * as validate from "../src/tools/cpi-iflow-validate.js";
import * as del from "../src/tools/cpi-iflow-delete.js";

const SOURCE = process.argv[2] || "test";
// Sin guion bajo: el Id de un package es mas estricto que el de un artefacto (400 si no).
const PROBE_PKG = "ZZPKGPROBE";
// Sin argumento, el package destino se crea y se borra en esta misma corrida.
const PKG = process.argv[3] || PROBE_PKG;
const CREAR_PKG = PKG === PROBE_PKG;
const TARGET = `zz_clone_probe`;

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

async function step(n, mod, args, title) {
  console.log(`\n${"─".repeat(70)}\n[${n}] ${mod.definition.name} — ${title}\n${"─".repeat(70)}`);
  const res = await mod.handler(args, ctx);
  const text = res.content?.map((c) => c.text).join("\n") ?? "";
  if (res.isError) {
    failures++;
    console.log(`✗ ${text}`);
  } else {
    console.log(text);
  }
  return text;
}

/**
 * Borra un package. Va crudo contra el cliente A PROPOSITO: no hay `cpi_package_delete` y no
 * es un olvido. Borrar un package se lleva puesto TODO lo que tiene adentro, y esa es una
 * palanca que no queremos a mano del modelo. Aca la usa un script que borra un package que
 * el propio script acaba de crear.
 */
const borrarPackage = (id) => client.del(`IntegrationPackages('${id}')`);

async function main() {
  if (config.policy === "readonly") {
    console.log(`El profile "${config.profile}" esta en readonly: este test no aplica.`);
    return;
  }

  console.log(`Ciclo de escritura en ${config.label}`);
  console.log(`plantilla=${SOURCE}  package=${PKG}  clon=${TARGET}`);

  // Por si quedo colgado de una corrida anterior
  await del.handler({ id: TARGET, confirm: true }, ctx).catch(() => {});
  if (CREAR_PKG) await borrarPackage(PROBE_PKG).catch(() => {});

  if (CREAR_PKG) {
    await step(
      0,
      packageCreate,
      { id: PROBE_PKG, name: "Probe del ciclo de escritura", shortText: "Descartable" },
      "crear el package destino"
    );
  }

  await step(1, clone, { sourceId: SOURCE, targetId: TARGET, targetPackageId: PKG }, "clonar");

  // Verificacion independiente: el manifiesto del clon TIENE que apuntar al Id nuevo
  console.log(`\n${"─".repeat(70)}\n[2] verificacion del bundle clonado\n${"─".repeat(70)}`);
  try {
    const zip = await downloadArtifact(client, TARGET);
    const entries = readZip(zip, { content: true });
    const mf = entries.find((e) => e.name === "META-INF/MANIFEST.MF")?.data.toString("utf8") ?? "";
    const proj = entries.find((e) => e.name === ".project")?.data.toString("utf8") ?? "";

    const checks = [
      [`Bundle-SymbolicName apunta a ${TARGET}`, new RegExp(`Bundle-SymbolicName:\\s*${TARGET}`).test(mf)],
      [`Bundle-Name apunta a ${TARGET}`, new RegExp(`Bundle-Name:\\s*${TARGET}`).test(mf)],
      [`.project renombrado`, proj.includes(`<name>${TARGET}</name>`)],
      [`no quedo rastro del Id original en el manifiesto`, !/Bundle-SymbolicName:\s*test;/.test(mf)],
      [`Import-Package intacto`, /Import-Package:/.test(mf) && mf.length > 1200],
      [`el bundle sigue teniendo ${entries.length} archivos`, entries.length === 6],
    ];
    for (const [label, okc] of checks) {
      if (!okc) failures++;
      console.log(`  ${okc ? "✓" : "✗"} ${label}`);
    }
  } catch (e) {
    failures++;
    console.log(`✗ no se pudo releer el clon: ${e.message}`);
  }

  await step(3, read, { id: TARGET }, "leer parametros externalizados");
  await step(4, configure, { id: TARGET, parameters: { SAP_ProfileId: "iflmap" } }, "setear un parametro");
  await step(5, validate, { id: TARGET }, "validar sin deployar");
  await step(6, del, { id: TARGET, confirm: true }, "borrar el clon");

  // Confirmar que no quedo basura
  const list = await import("../src/tools/cpi-iflow-list.js");
  const after = await list.handler({ packageId: PKG }, ctx);
  const txt = after.content.map((c) => c.text).join("");
  const clean = !txt.includes(TARGET);
  if (!clean) failures++;
  console.log(`\n${clean ? "✓" : "✗"} limpieza: ${clean ? "no quedo basura en el tenant" : "QUEDO EL CLON"}`);

  if (CREAR_PKG) {
    try {
      await borrarPackage(PROBE_PKG);
      console.log(`✓ limpieza: package ${PROBE_PKG} borrado`);
    } catch (e) {
      failures++;
      console.log(`✗ quedo el package ${PROBE_PKG}: ${e.message}`);
    }
  }

  console.log(`\n${"═".repeat(70)}`);
  console.log(failures ? `✗ ${failures} problema(s).` : `✓ Ciclo de escritura completo y limpio.`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => {
  console.error(`\nERROR fatal: ${e.stack ?? e.message}`);
  process.exitCode = 1;
});
