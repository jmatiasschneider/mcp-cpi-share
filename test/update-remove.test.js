/**
 * Unitarios del removeFiles de cpi_iflow_update: eliminar un archivo del bundle es resubir
 * el ZIP sin el — y todo lo que puede salir mal ahi es silencioso, asi que cada regla tiene
 * su test: la ruta inexistente es ERROR (un typo que "no borra nada y no avisa" es el sintoma
 * mas caro de depurar), los archivos estructurales no se tocan, y el rechazo llega ANTES de
 * gastar una descarga cuando el chequeo no depende del bundle.
 *
 * Igual que update-fromfile.test.js, invoca el handler real con un cliente doble que devuelve
 * un ZIP de verdad y captura el que se sube.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { writeZip, readZip } from "../src/core/zip.js";
import { handler } from "../src/tools/cpi-iflow-update.js";

const BUNDLE = [
  { name: "META-INF/MANIFEST.MF", data: "Manifest-Version: 1.0" },
  { name: ".project", data: "<projectDescription/>" },
  { name: "metainfo.prop", data: "description=x" },
  { name: "src/main/resources/scenarioflows/integrationflow/molde.iflw", data: "<iflw/>" },
  { name: "src/main/resources/mapping/placeholder.mmap", data: "huerfano" },
  { name: "src/main/resources/xsd/otraInterfaz.xsd", data: "huerfano" },
  { name: "src/main/resources/parameters.prop", data: "A=1" },
  { name: "src/main/resources/parameters.propdef", data: "<param_references/>" },
];

/** Cliente doble: get devuelve un bundle real, put captura el body subido. */
function dobleCliente() {
  const puts = [];
  let gets = 0;
  return {
    puts,
    getCount: () => gets,
    get: () => (gets++, Promise.resolve(writeZip(BUNDLE))),
    put: (path, body) => {
      puts.push({ path, body });
      return Promise.resolve({});
    },
  };
}

const subido = (c) => readZip(Buffer.from(c.puts[0].body.ArtifactContent, "base64"), { content: true });

test("removeFiles saca el archivo del bundle y conserva el resto intacto", async () => {
  const c = dobleCliente();
  const r = await handler(
    { id: "IF_X", removeFiles: ["src/main/resources/mapping/placeholder.mmap"] },
    { client: c }
  );

  assert.equal(r.isError, undefined, JSON.stringify(r.content));
  assert.equal(c.puts.length, 1);

  const nombres = subido(c).map((e) => e.name);
  assert.ok(!nombres.includes("src/main/resources/mapping/placeholder.mmap"), "sigue en el ZIP");
  assert.equal(nombres.length, BUNDLE.length - 1);
  assert.match(r.content[0].text, /ELIMINADO/);
});

test("files y removeFiles conviven en la misma llamada", async () => {
  const c = dobleCliente();
  const r = await handler(
    {
      id: "IF_X",
      files: [{ name: "src/main/resources/xsd/nueva.xsd", content: "<xsd/>" }],
      removeFiles: ["src/main/resources/xsd/otraInterfaz.xsd"],
    },
    { client: c }
  );

  assert.equal(r.isError, undefined, JSON.stringify(r.content));
  const nombres = subido(c).map((e) => e.name);
  assert.ok(nombres.includes("src/main/resources/xsd/nueva.xsd"));
  assert.ok(!nombres.includes("src/main/resources/xsd/otraInterfaz.xsd"));
});

test("una ruta que no existe en el bundle es error y no se sube nada", async () => {
  const c = dobleCliente();
  const r = await handler(
    { id: "IF_X", removeFiles: ["src/main/resources/xsd/typo.xsd"] },
    { client: c }
  );

  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /typo\.xsd/);
  assert.match(r.content[0].text, /includeContent/);
  assert.equal(c.puts.length, 0, "el bundle no tendria que haberse resubido");
});

test("los archivos estructurales se rechazan sin gastar la descarga", async () => {
  for (const ruta of [
    "META-INF/MANIFEST.MF",
    ".project",
    "metainfo.prop",
    "src/main/resources/scenarioflows/integrationflow/molde.iflw",
  ]) {
    const c = dobleCliente();
    const r = await handler({ id: "IF_X", removeFiles: [ruta] }, { client: c });

    assert.equal(r.isError, true, `"${ruta}" no se rechazo`);
    assert.match(r.content[0].text, /No se puede eliminar/);
    assert.equal(c.getCount(), 0, `"${ruta}" costo una descarga antes del rechazo`);
    assert.equal(c.puts.length, 0);
  }
});

// El tenant rechaza parameters.prop sin parameters.propdef con un 500 que no nombra al
// culpable (2026-08-29, probe-remove-file): estos dos tests cuidan que el guard lo atrape
// antes del PUT y que no bloquee de mas.
test("eliminar el propdef dejando el prop se ataja antes del PUT, con el culpable nombrado", async () => {
  const c = dobleCliente();
  const r = await handler(
    { id: "IF_X", removeFiles: ["src/main/resources/parameters.propdef"] },
    { client: c }
  );

  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /parameters\.propdef/);
  assert.match(r.content[0].text, /los dos juntos/);
  assert.equal(c.puts.length, 0, "el bundle invalido no tendria que haberse subido");
});

test("eliminar prop y propdef juntos (o el prop solo) pasa: el tenant los acepta", async () => {
  for (const remove of [
    ["src/main/resources/parameters.prop", "src/main/resources/parameters.propdef"],
    ["src/main/resources/parameters.prop"],
  ]) {
    const c = dobleCliente();
    const r = await handler({ id: "IF_X", removeFiles: remove }, { client: c });

    assert.equal(r.isError, undefined, JSON.stringify(r.content));
    const nombres = subido(c).map((e) => e.name);
    for (const n of remove) assert.ok(!nombres.includes(n), `${n} sigue en el ZIP`);
  }
});

test("la misma ruta en files y removeFiles es contradiccion, no una carrera", async () => {
  const c = dobleCliente();
  const r = await handler(
    {
      id: "IF_X",
      files: [{ name: "src/main/resources/xsd/otraInterfaz.xsd", content: "x" }],
      removeFiles: ["src/main/resources/xsd/otraInterfaz.xsd"],
    },
    { client: c }
  );

  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /a la vez/);
  assert.equal(c.getCount(), 0, "la contradiccion no tiene que costar una descarga");
});
