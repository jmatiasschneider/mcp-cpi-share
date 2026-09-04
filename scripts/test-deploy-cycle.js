#!/usr/bin/env node
/**
 * Ciclo de DEPLOY end-to-end contra el tenant real.
 *
 * ⚠️ ESCRIBE EN EL RUNTIME. Clona un iFlow, lo deploya, sigue el BuildAndDeployStatus,
 *    lo saca del runtime y borra el clon. Autolimpiante: si algo falla igual intenta limpiar.
 *
 * Efecto colateral: el iFlow `test` tiene el timer en fireNow=true (Run Once), asi que el
 * deploy dispara UNA ejecucion. Va a aparecer un mensaje en el monitor.
 *
 * Uso: node scripts/test-deploy-cycle.js [sourceId] [packageId]
 */

import { loadConfig } from "../src/config/local.js";
import { CpiClient } from "../src/core/client.js";
import { deployStatus } from "../src/core/ops/write.js";

import * as clone from "../src/tools/cpi-iflow-clone.js";
import * as validate from "../src/tools/cpi-iflow-validate.js";
import * as deploy from "../src/tools/cpi-deploy.js";
import * as undeploy from "../src/tools/cpi-undeploy.js";
import * as del from "../src/tools/cpi-iflow-delete.js";
import * as deployed from "../src/tools/cpi-deployed.js";

const SOURCE = process.argv[2] || "test";
const PKG = process.argv[3] || "DEVtest";
const TARGET = "zz_deploy_probe";

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

async function cleanup() {
  console.log(`\n${"─".repeat(70)}\nlimpieza\n${"─".repeat(70)}`);
  await undeploy.handler({ id: TARGET, confirm: true }, ctx).catch(() => {});
  await del.handler({ id: TARGET, confirm: true }, ctx).catch(() => {});

  const res = await deployed.handler({}, ctx);
  const txt = res.content.map((c) => c.text).join("");
  const clean = !txt.includes(TARGET);
  if (!clean) failures++;
  console.log(clean ? `✓ no quedo nada de ${TARGET} en el runtime` : `✗ QUEDO ${TARGET} deployado`);
  console.log(txt.split("\n").slice(0, 6).join("\n"));
}

async function main() {
  if (config.policy === "readonly") {
    console.log(`El profile "${config.profile}" esta en readonly: este test no aplica.`);
    return;
  }

  console.log(`Ciclo de DEPLOY en ${config.label}`);
  console.log(`plantilla=${SOURCE}  package=${PKG}  clon=${TARGET}\n`);

  // Restos de una corrida anterior
  await undeploy.handler({ id: TARGET, confirm: true }, ctx).catch(() => {});
  await del.handler({ id: TARGET, confirm: true }, ctx).catch(() => {});

  try {
    await step(1, clone, { sourceId: SOURCE, targetId: TARGET, targetPackageId: PKG }, "clonar");
    await step(2, validate, { id: TARGET }, "validar antes de deployar");

    const out = await step(3, deploy, { id: TARGET }, "deployar y esperar");

    // Contrato de BuildAndDeployStatus: verificar que responda con la key
    const taskId = /TaskId:\s*(\S+)/.exec(out)?.[1];
    console.log(`\n${"─".repeat(70)}\n[4] contrato de BuildAndDeployStatus\n${"─".repeat(70)}`);
    if (!taskId) {
      failures++;
      console.log("✗ el deploy no devolvio un TaskId parseable");
    } else {
      console.log(`TaskId = ${taskId}`);
      const st = await deployStatus(client, taskId).catch((e) => ({ error: e.message }));
      console.log(st ? JSON.stringify(st, null, 2) : "(sin estado)");
    }

    await step(5, deployed, { id: TARGET }, "estado en el runtime");
  } finally {
    await cleanup();
  }

  console.log(`\n${"═".repeat(70)}`);
  console.log(failures ? `✗ ${failures} problema(s).` : `✓ Ciclo de deploy completo y limpio.`);
  process.exitCode = failures ? 1 : 0;
}

main().catch(async (e) => {
  console.error(`\nERROR fatal: ${e.stack ?? e.message}`);
  await cleanup().catch(() => {});
  process.exitCode = 1;
});
