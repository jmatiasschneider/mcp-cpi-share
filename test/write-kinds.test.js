/**
 * Unitarios de la parametrizacion por `kind` en ops/write.js.
 *
 * Escribir contra el entity set equivocado no da lista vacia: da 404, o peor, crea el artefacto
 * en la familia que no era. Como no se puede probar contra el tenant sin escribir, se verifica
 * la URL y el cuerpo con un cliente doble.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  createArtifact,
  updateArtifact,
  deleteArtifact,
  validateArtifact,
  deployArtifact,
  deployDevuelveTaskId,
} from "../src/core/ops/write.js";

/** Cliente falso: registra method+path+body y responde vacio. */
function spy(respuesta = { rows: [] }) {
  const calls = [];
  const rec = (method) => (path, body) => {
    calls.push({ method, path, body });
    return Promise.resolve(respuesta);
  };
  return {
    calls,
    get: rec("GET"),
    post: rec("POST"),
    put: rec("PUT"),
    del: rec("DELETE"),
    request: (method, path, opts) => {
      calls.push({ method, path, opts });
      return Promise.resolve(Buffer.from(""));
    },
  };
}

const KINDS = {
  iflow: "IntegrationDesigntimeArtifacts",
  mapping: "MessageMappingDesigntimeArtifacts",
  script: "ScriptCollectionDesigntimeArtifacts",
  valuemapping: "ValueMappingDesigntimeArtifacts",
};

test("createArtifact postea contra el entity set de su familia", async () => {
  for (const [kind, set] of Object.entries(KINDS)) {
    const c = spy();
    await createArtifact(c, { id: "X", packageId: "P", content: Buffer.from("zip"), kind });
    assert.equal(c.calls[0].method, "POST");
    assert.equal(c.calls[0].path, set);
    assert.equal(c.calls[0].body.ArtifactContent, Buffer.from("zip").toString("base64"));
  }
});

test("sin kind, todo sigue yendo al iFlow", async () => {
  const c = spy();
  await createArtifact(c, { id: "X", packageId: "P", content: Buffer.from("z") });
  assert.equal(c.calls[0].path, "IntegrationDesigntimeArtifacts");

  const c2 = spy();
  await deleteArtifact(c2, { id: "X" });
  assert.equal(c2.calls[0].path, "IntegrationDesigntimeArtifacts(Id='X',Version='active')");
});

test("updateArtifact y deleteArtifact usan la key de su familia", async () => {
  const c = spy();
  await updateArtifact(c, { id: "MM", version: "1.0.1", content: Buffer.from("z"), kind: "mapping" });
  assert.equal(c.calls[0].method, "PUT");
  assert.equal(c.calls[0].path, "MessageMappingDesigntimeArtifacts(Id='MM',Version='1.0.1')");

  const c2 = spy();
  await deleteArtifact(c2, { id: "MM", kind: "mapping" });
  assert.equal(c2.calls[0].method, "DELETE");
  assert.equal(c2.calls[0].path, "MessageMappingDesigntimeArtifacts(Id='MM',Version='active')");
});

test("updateArtifact solo manda los campos que le pasaron", async () => {
  const c = spy();
  await updateArtifact(c, { id: "X", name: "Nuevo" });
  assert.deepEqual(Object.keys(c.calls[0].body), ["Name"], "sin content no manda ArtifactContent");
});

test("cada familia deploya con SU FunctionImport", async () => {
  const esperado = {
    iflow: "DeployIntegrationDesigntimeArtifact",
    mapping: "DeployMessageMappingDesigntimeArtifact",
    script: "DeployScriptCollectionDesigntimeArtifact",
    valuemapping: "DeployValueMappingDesigntimeArtifact",
  };
  for (const [kind, fn] of Object.entries(esperado)) {
    const c = spy();
    await deployArtifact(c, { id: "X", kind });
    assert.match(c.calls[0].path, new RegExp(`^${fn}\\?`));
    assert.match(c.calls[0].path, /Id='X'&Version='active'/);
  }
});

test("solo el iFlow informa TaskId — el resto obliga a esperar sobre el runtime", () => {
  // Es la trampa que genero un falso negativo sobre un deploy que habia salido bien.
  assert.equal(deployDevuelveTaskId("iflow"), true);
  for (const k of ["mapping", "script", "valuemapping"]) {
    assert.equal(deployDevuelveTaskId(k), false, `${k} no devuelve TaskId`);
  }
});

test("un kind sin deploy conocido falla nombrando las opciones", async () => {
  await assert.rejects(
    () => deployArtifact(spy(), { id: "X", kind: "mapeo" }),
    /No hay FunctionImport de deploy para "mapeo"/
  );
});

test("validar un artefacto que no es iFlow falla con hint, sin pegarle al tenant", () => {
  const c = spy();
  assert.throws(
    () => validateArtifact(c, { id: "MM", kind: "mapping" }),
    (err) => {
      assert.match(err.message, /No existe validacion/);
      assert.match(err.hint, /el deploy es la primera verificacion/);
      return true;
    }
  );
  assert.equal(c.calls.length, 0, "ni siquiera intenta la llamada");
});
