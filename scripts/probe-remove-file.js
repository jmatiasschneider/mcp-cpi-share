#!/usr/bin/env node
/**
 * Sonda: ¿el tenant acepta resubir un bundle con MENOS archivos? (la base de removeFiles)
 *
 * ⚠️ ESTE SCRIPT ESCRIBE EN EL TENANT. Crea un package y clones descartables y los borra.
 *    No deploya nada. No toca artefactos existentes.
 *
 * Corre una matriz de escenarios sobre clones frescos de la plantilla:
 *   1. eliminar un archivo agregado por nosotros (no referenciado por nada)
 *   2. eliminar parameters.propdef solo
 *   3. eliminar parameters.prop + parameters.propdef juntos
 *   4. eliminar el .mmap que el .iflw referencia (mappinguri embebido)
 *   5. eliminar un WSDL que referencia el .mmap
 * y para cada uno registra: ¿el PUT acepto? si no, ¿el bundle quedo intacto? si si,
 * ¿que dice Validate?
 *
 * Uso: node scripts/probe-remove-file.js [sourceId]   (default: test)
 */

import { loadConfig } from "../src/config/local.js";
import { CpiClient } from "../src/core/client.js";
import { readZip } from "../src/core/zip.js";
import { downloadArtifact, createPackage } from "../src/core/ops/design.js";
import {
  cloneArtifact,
  updateArtifactFiles,
  validateArtifact,
  deleteArtifact,
} from "../src/core/ops/write.js";

const SOURCE = process.argv[2] || "test";
const PKG = "ZZPKGREMOVE"; // sin guion bajo: el Id de package es mas estricto
const TARGET = "zz_remove_probe";
const EXTRA = "src/main/resources/xsd/zz_probe_huerfano.xsd";

const log = (...a) => console.log(...a);

async function main() {
  const config = loadConfig();
  if (config.policy === "readonly") {
    log(`El profile "${config.profile}" esta en readonly: esta sonda no aplica.`);
    return;
  }
  const client = new CpiClient({ oauth: config.oauth, label: config.label });
  log(`Tenant: ${config.label}\nplantilla=${SOURCE}  package=${PKG}  clon=${TARGET}\n`);

  // Por si quedo colgado de una corrida anterior
  await deleteArtifact(client, { id: TARGET }).catch(() => {});
  await client.del(`IntegrationPackages('${PKG}')`).catch(() => {});
  await createPackage(client, { id: PKG, name: "Probe de removeFiles", shortText: "Descartable" });

  const nombres = async () => readZip(await downloadArtifact(client, TARGET)).map((e) => e.name);

  const clonFresco = async () => {
    await deleteArtifact(client, { id: TARGET }).catch(() => {});
    await cloneArtifact(client, { sourceId: SOURCE, targetId: TARGET, targetPackageId: PKG });
  };

  await clonFresco();
  const base = await nombres();
  log(`bundle de la plantilla (${base.length} archivos):\n  ${base.join("\n  ")}\n`);

  const mmap = base.find((n) => n.endsWith(".mmap"));
  const wsdl = base.find((n) => n.endsWith(".wsdl"));

  const escenarios = [
    { titulo: "archivo agregado por nosotros (huerfano de verdad)", prep: true, remove: [EXTRA] },
    { titulo: "parameters.propdef solo", remove: ["src/main/resources/parameters.propdef"] },
    { titulo: "parameters.prop solo", remove: ["src/main/resources/parameters.prop"] },
    {
      titulo: "parameters.prop + parameters.propdef juntos",
      remove: ["src/main/resources/parameters.prop", "src/main/resources/parameters.propdef"],
    },
    ...(mmap ? [{ titulo: `el .mmap referenciado por el .iflw (${mmap})`, remove: [mmap] }] : []),
    ...(wsdl ? [{ titulo: `un WSDL referenciado por el .mmap (${wsdl})`, remove: [wsdl] }] : []),
  ];

  try {
    for (const [i, esc] of escenarios.entries()) {
      log(`${"─".repeat(70)}\n[${i + 1}] eliminar: ${esc.titulo}\n${"─".repeat(70)}`);
      await clonFresco();
      if (esc.prep) {
        await updateArtifactFiles(client, {
          id: TARGET,
          files: [{ name: EXTRA, data: "<xsd:schema/>" }],
        });
      }

      let putOk = true;
      try {
        await updateArtifactFiles(client, { id: TARGET, removeFiles: esc.remove });
      } catch (e) {
        putOk = false;
        log(`  PUT RECHAZADO: ${e.message}`);
      }

      const despues = await nombres();
      const quedaron = esc.remove.filter((n) => despues.includes(n));
      if (putOk) {
        log(`  PUT acepto. Al re-descargar ${quedaron.length ? `SIGUEN: ${quedaron.join(", ")}` : "no estan (eliminados de verdad)"}`);
        try {
          const v = await validateArtifact(client, { id: TARGET });
          log(`  Validate: ${String(v).replace(/\s+/g, " ").slice(0, 400)}`);
        } catch (e) {
          log(`  Validate FALLO: ${e.message}`);
        }
      } else {
        log(`  bundle despues del rechazo: ${quedaron.length === esc.remove.length ? "INTACTO (el PUT es atomico)" : `INCONSISTENTE — quedaron ${quedaron.join(", ")} de ${esc.remove.join(", ")}`}`);
      }
      log("");
    }
  } finally {
    log(`${"─".repeat(70)}\nlimpieza`);
    await deleteArtifact(client, { id: TARGET })
      .then(() => log("  ✓ clon borrado"))
      .catch((e) => log(`  ✗ quedo el clon: ${e.message}`));
    await client
      .del(`IntegrationPackages('${PKG}')`)
      .then(() => log("  ✓ package borrado"))
      .catch((e) => log(`  ✗ quedo el package: ${e.message}`));
  }
}

main().catch((e) => {
  console.error(`\nERROR fatal: ${e.stack ?? e.message}`);
  process.exitCode = 1;
});
