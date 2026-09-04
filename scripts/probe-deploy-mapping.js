#!/usr/bin/env node
/**
 * ⚠️ ESCRIBE EN EL RUNTIME. Sonda: deploya un message mapping por su cuenta.
 *
 * Pregunta abierta del ROADMAP: el $metadata declara `DeployMessageMappingDesigntimeArtifact`
 * pero nunca se ejercito. Si responde con un TaskId, los mappings se deployan solos y no
 * dependen del iFlow que los use.
 *
 *   node scripts/probe-deploy-mapping.js [id] [version]
 */

import { loadConfig } from "../src/config/local.js";
import { CpiClient } from "../src/core/client.js";
import { odataQuote } from "../src/core/client.js";
import { deployStatus, waitForDeploy } from "../src/core/ops/write.js";

const id = process.argv[2] ?? "MM_TEST_TRIVIAL";
const version = process.argv[3] ?? "active";

async function main() {
  const config = loadConfig();
  const client = new CpiClient({ oauth: config.oauth, label: config.label });
  console.log(`Tenant: ${config.label}\nDeployando mapping ${id} (Version='${version}')...\n`);

  const buf = await client.request(
    "POST",
    `DeployMessageMappingDesigntimeArtifact?Id='${odataQuote(id)}'&Version='${odataQuote(version)}'`,
    { raw: true, headers: { Accept: "application/json" } }
  );
  const texto = Buffer.isBuffer(buf) ? buf.toString("utf8").trim() : String(buf ?? "");
  console.log(`Respuesta cruda: ${texto || "(vacia)"}`);

  // El FunctionImport devuelve el TaskId, a veces pelado y a veces envuelto en {"d":{...}}.
  let taskId = texto.replace(/^"|"$/g, "");
  try {
    const d = JSON.parse(texto)?.d;
    if (d && typeof d === "object") taskId = Object.values(d).find((v) => typeof v === "string") ?? taskId;
  } catch {
    /* texto pelado */
  }

  if (!taskId) throw new Error("No devolvio TaskId.");
  console.log(`TaskId: ${taskId}\n`);

  const final = await waitForDeploy(client, taskId, { timeoutMs: 90000 });
  console.log("Estado final del task:");
  console.log(final ? JSON.stringify(final, null, 2) : "(sin estado — el task no respondio)");

  // Y despues, si aparece en el runtime como artefacto propio.
  const { rows } = await client.get("IntegrationRuntimeArtifacts").catch(() => ({ rows: [] }));
  const hit = rows.find((r) => r.Id === id);
  console.log(
    `\nEn IntegrationRuntimeArtifacts: ${hit ? `SI — Status=${hit.Status}, Type=${hit.Type}` : "NO aparece"}`
  );
}

main().catch(async (err) => {
  console.error(`\n✗ ${err.message}`);
  if (err.url) console.error(`  URL: ${err.url}`);
  process.exit(1);
});
