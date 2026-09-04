/**
 * Unitarios de cpi_download y de las ops savePackageZip / saveArtifactZip.
 *
 * El cliente es un doble que REGISTRA cada path pedido y devuelve un ZIP real armado con
 * core/zip.js, mismo criterio que trace.test.js: lo que se rompe aca no es la logica sino
 * las dos URLs de /$value, y que la copia en disco sea byte a byte.
 *
 * La regla del zip corrupto viene del uso: esta tool existe para backup, y un backup corrupto
 * en disco es peor que un error — se valida el ZIP ANTES de escribir.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeZip } from "../src/core/zip.js";
import { savePackageZip } from "../src/core/ops/design.js";
import * as download from "../src/tools/cpi-download.js";

// Zip con la forma del export de un package: un bundle por artefacto + metadata.
const PKG_ZIP = writeZip([
  { name: "575eaf49_content", data: writeZip([{ name: "META-INF/MANIFEST.MF", data: "mf" }]) },
  { name: "1a5def69_content", data: writeZip([{ name: "META-INF/MANIFEST.MF", data: "mf" }]) },
  { name: "resources.cnt", data: "eyJ9" },
  { name: "ExportInformation.info", data: "Name= X" },
]);

const BUNDLE_ZIP = writeZip([
  { name: "META-INF/MANIFEST.MF", data: "mf" },
  { name: "src/main/resources/mapping/MM_x.mmap", data: Buffer.from([0x00, 0xff, 0x80]) },
]);

/** Doble de CpiClient: registra los paths y responde segun el prefijo. */
function clienteFalso({ paquete = PKG_ZIP, bundle = BUNDLE_ZIP } = {}) {
  const paths = [];
  return {
    paths,
    get: (path) => {
      paths.push(path);
      if (path.startsWith("IntegrationPackages(")) return Promise.resolve(paquete);
      return Promise.resolve(bundle);
    },
  };
}

function dirTemporal(t) {
  const dir = mkdtempSync(join(tmpdir(), "cpi-download-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("packageId baja el /$value del package y guarda el zip byte a byte", async (t) => {
  const client = clienteFalso();
  const out = join(dirTemporal(t), "DEVtest.zip");

  const res = await download.handler({ packageId: "DEVtest", saveTo: out }, { client });

  assert.ok(!res.isError, res.content?.[0]?.text);
  assert.deepEqual(client.paths, ["IntegrationPackages('DEVtest')/$value"]);
  assert.deepEqual(readFileSync(out), PKG_ZIP, "la copia en disco difiere de la respuesta");
  assert.match(res.content[0].text, /2 artefacto\(s\)/, "cuenta los <guid>_content");
});

test("id + kind arma la URL del entity set correcto, con la version pedida", async (t) => {
  const client = clienteFalso();
  const out = join(dirTemporal(t), "MM_x.zip");

  const res = await download.handler(
    { id: "MM_x", kind: "mapping", version: "1.0.1", saveTo: out },
    { client }
  );

  assert.ok(!res.isError, res.content?.[0]?.text);
  assert.deepEqual(client.paths, ["MessageMappingDesigntimeArtifacts(Id='MM_x',Version='1.0.1')/$value"]);
  assert.deepEqual(readFileSync(out), BUNDLE_ZIP);
  assert.match(res.content[0].text, /2 archivos/);
});

test("el 500 de un package con drafts sale con el hint de versionar o bajar de a uno", async (t) => {
  const client = {
    get: () =>
      Promise.reject(
        Object.assign(
          new Error(
            "HTTP 500 — Package export failed. It contains the following artifacts are in draft state: " +
              "[ {Type=IFlow, Name=ZVALIDACION_ESR_PRD} ]"
          ),
          { status: 500 }
        )
      ),
  };
  const res = await download.handler(
    { packageId: "DEVtest", saveTo: join(dirTemporal(t), "x.zip") },
    { client }
  );

  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /draft state/);
  assert.match(res.content[0].text, /Save as version/);
  assert.match(res.content[0].text, /de a uno/);
});

test("una respuesta que no es un ZIP falla ANTES de escribir el archivo", async (t) => {
  const out = join(dirTemporal(t), "roto.zip");
  await assert.rejects(
    () => savePackageZip({ get: () => Promise.resolve(Buffer.from("<html>mantenimiento</html>")) }, "P", { saveTo: out }),
    /no es un ZIP valido/
  );
  assert.ok(!existsSync(out), "el archivo corrupto no tiene que quedar en disco");
});

test("un saveTo que ya existe se rechaza sin overwrite, y se pisa con overwrite:true", async (t) => {
  // La barrera existe por la anotacion: cpi_download es readOnlyHint:true y el cliente puede
  // auto-aprobarla — pisar un archivo local en silencio por esa via seria mentirle a la anotacion.
  const out = join(dirTemporal(t), "DEVtest.zip");
  writeFileSync(out, "previo");

  const sin = await download.handler({ packageId: "DEVtest", saveTo: out }, { client: clienteFalso() });
  assert.equal(sin.isError, true);
  assert.match(sin.content[0].text, /Ya existe/);
  assert.match(sin.content[0].text, /overwrite:true/);
  assert.equal(readFileSync(out, "utf8"), "previo", "el archivo previo tiene que quedar intacto");

  const con = await download.handler(
    { packageId: "DEVtest", saveTo: out, overwrite: true },
    { client: clienteFalso() }
  );
  assert.ok(!con.isError, con.content?.[0]?.text);
  assert.deepEqual(readFileSync(out), PKG_ZIP);
});

test("un destino cuyo directorio no existe falla con hint, sin mkdir silencioso", async () => {
  const res = await download.handler(
    { packageId: "P", saveTo: join(tmpdir(), "cpi-download-no-existe", "sub", "P.zip") },
    { client: clienteFalso() }
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /No se pudo escribir/);
  assert.match(res.content[0].text, /directorio destino/);
});

test("packageId e id juntos, o ninguno, se rechazan sin tocar el cliente", async () => {
  const client = clienteFalso();

  const ambos = await download.handler({ packageId: "P", id: "IF_X", saveTo: "x.zip" }, { client });
  assert.equal(ambos.isError, true);
  assert.match(ambos.content[0].text, /exactamente uno/);

  const ninguno = await download.handler({ saveTo: "x.zip" }, { client });
  assert.equal(ninguno.isError, true);
  assert.match(ninguno.content[0].text, /exactamente uno/);

  assert.deepEqual(client.paths, [], "la validacion corta antes de pegarle al tenant");
});

test("kind o version junto a packageId se rechazan: son del modo artefacto", async () => {
  const client = clienteFalso();
  const res = await download.handler({ packageId: "P", kind: "iflow", saveTo: "x.zip" }, { client });

  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /modo artefacto/);
  assert.deepEqual(client.paths, []);
});

test("sin saveTo la validacion dice que falta, con el nombre de la tool", async () => {
  const res = await download.handler({ packageId: "P" }, {});
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /falta el parametro requerido "saveTo"/);
  assert.match(res.content[0].text, /\(tool: cpi_download\)/);
});
