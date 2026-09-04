// Resolucion del systems.json: es lo que hace al server instalable como dependencia de otro
// repo. Sin CPI_SYSTEMS se lee de la raiz del server (desarrollo); con ella, de donde diga
// (uso desde otro repo, donde `node_modules/mcp-cpi/systems.json` se perderia con cada npm ci).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, sep } from "node:path";

import { loadConfig, resolveSystemsPath } from "../src/config/local.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EJEMPLO = join(ROOT, "systems.example.json");

test("sin CPI_SYSTEMS, el systems.json es el de la raiz del server", () => {
  assert.equal(resolveSystemsPath(undefined), join(ROOT, "systems.json"));
  assert.equal(resolveSystemsPath(""), join(ROOT, "systems.json"));
});

test("una ruta relativa en CPI_SYSTEMS se resuelve contra el cwd, no contra el server", () => {
  const p = resolveSystemsPath("systems.json");
  assert.equal(p, resolve("systems.json"));
  assert.ok(p.startsWith(process.cwd() + sep), `esperaba una ruta bajo el cwd, vino ${p}`);
});

test("una ruta absoluta en CPI_SYSTEMS se usa tal cual", () => {
  assert.equal(resolveSystemsPath(EJEMPLO), EJEMPLO);
});

test("systems.example.json es una config valida: el boot arranca con ella", () => {
  const cfg = loadConfig({ profile: undefined, systemsPath: EJEMPLO });
  assert.equal(cfg.profile, "dev", "el _default del ejemplo");
  assert.equal(cfg.policy, "readonly", "el ejemplo arranca inofensivo");
  assert.ok(cfg.oauth?.url, "trae el plano de administracion");
  assert.ok(cfg.runtime?.tokenurl, "trae el plano de runtime");
});

test("un archivo inexistente explica como elegir la ruta", () => {
  const nada = join(ROOT, "no-existe-3f9a.json");
  assert.throws(
    () => loadConfig({ systemsPath: nada }),
    (err) => err.message.includes(nada) && err.message.includes("CPI_SYSTEMS")
  );
});

test("un profile que no esta nombra el archivo donde se busco", () => {
  assert.throws(
    () => loadConfig({ profile: "no-existe", systemsPath: EJEMPLO }),
    (err) => err.message.includes(EJEMPLO) && err.message.includes("dev")
  );
});
