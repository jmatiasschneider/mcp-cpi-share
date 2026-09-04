/**
 * Unitarios de la parametrizacion del entity set por tipo de artefacto.
 *
 * Las cuatro familias (iflow, mapping, script, valuemapping) son gemelas para leerlas, pero
 * viven en entity sets distintos: pedir un message mapping como si fuera un iFlow da 404. Eso
 * paso de verdad el 2026-08-08 y es lo que motivo el refactor.
 *
 * El cliente es un doble que solo registra el path. No hay red: lo que se verifica es que la
 * URL construida sea la correcta, que es donde una regresion vuelve a costar un 404.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  artifactKinds,
  readArtifact,
  downloadArtifact,
  listArtifacts,
  listConfigurations,
  listResources,
} from "../src/core/ops/design.js";

/** Cliente falso: guarda los paths pedidos y devuelve vacio. */
function spyClient() {
  const paths = [];
  return {
    paths,
    get(path) {
      paths.push(path);
      return Promise.resolve({ rows: [] });
    },
  };
}

test("estan las cuatro familias", () => {
  assert.deepEqual(artifactKinds().sort(), ["iflow", "mapping", "script", "valuemapping"]);
});

test("cada kind pega contra su propio entity set", async () => {
  const esperado = {
    iflow: "IntegrationDesigntimeArtifacts",
    mapping: "MessageMappingDesigntimeArtifacts",
    script: "ScriptCollectionDesigntimeArtifacts",
    valuemapping: "ValueMappingDesigntimeArtifacts",
  };

  for (const [kind, set] of Object.entries(esperado)) {
    const c = spyClient();
    await readArtifact(c, "X", { kind });
    assert.equal(c.paths[0], `${set}(Id='X',Version='active')`);
  }
});

test("sin kind sigue siendo iFlow — la compatibilidad no se rompe", async () => {
  const c = spyClient();
  await readArtifact(c, "test");
  assert.equal(c.paths[0], "IntegrationDesigntimeArtifacts(Id='test',Version='active')");
});

test("un kind desconocido falla nombrando las opciones", async () => {
  await assert.rejects(
    () => readArtifact(spyClient(), "X", { kind: "mapeo" }),
    (err) => {
      assert.match(err.message, /kind "mapeo" no valido/);
      assert.match(err.message, /valuemapping/);
      return true;
    }
  );
});

test("downloadArtifact pide el /$value del entity set correcto", async () => {
  const c = { get: (p, o) => Promise.resolve({ p, o }) };
  const r = await downloadArtifact(c, "MM_TEST", { kind: "mapping" });

  assert.equal(r.p, "MessageMappingDesigntimeArtifacts(Id='MM_TEST',Version='active')/$value");
  assert.equal(r.o.raw, true, "el bundle se pide crudo, no como JSON");
});

test("la navegacion del package tambien va por kind", async () => {
  const c = spyClient();
  await listArtifacts(c, "DEVtest", { kind: "mapping" });
  assert.equal(c.paths[0], "IntegrationPackages('DEVtest')/MessageMappingDesigntimeArtifacts");
});

test("Resources va por kind; Configurations es exclusiva del iFlow", async () => {
  const c = spyClient();
  await listResources(c, "MM_TEST", { kind: "mapping" });
  assert.equal(c.paths[0], "MessageMappingDesigntimeArtifacts(Id='MM_TEST',Version='active')/Resources");

  // Un mapping no tiene parametros externalizados: mejor un mensaje que un 404 del tenant.
  await assert.rejects(
    () => listConfigurations(spyClient(), "MM_TEST", { kind: "mapping" }),
    /no tienen parametros externalizados/
  );
});

test("el Id y la Version se escapan como literales OData", async () => {
  const c = spyClient();
  await readArtifact(c, "con'comilla", { kind: "mapping", version: "1.0.1" });
  assert.equal(
    c.paths[0],
    "MessageMappingDesigntimeArtifacts(Id='con''comilla',Version='1.0.1')",
    "la comilla simple se duplica, o la URL queda rota"
  );
});
