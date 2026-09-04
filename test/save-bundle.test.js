/**
 * Unitarios de saveBundleFile: la copia a disco tiene que ser byte a byte.
 *
 * El motivo de existir de esta funcion es la fidelidad: la salida de texto de la tool no es
 * apta para reconstruir un archivo (el 2026-08-25 se corrompio un .mmap re-tipeandolo, y un
 * blob base64 corrupto no falla al guardar sino al validar). Por eso el test compara buffers
 * enteros, no longitudes.
 *
 * El cliente es un doble que devuelve un ZIP real armado con core/zip.js. No hay red.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeZip } from "../src/core/zip.js";
import { saveBundleFile } from "../src/core/ops/design.js";
import { handler as readHandler } from "../src/tools/cpi-iflow-read.js";

// Bytes con pinta de blob: no-ASCII, saltos de linea y NULs, que es lo que un re-tipeo pierde.
const BLOB = Buffer.concat([
  Buffer.from("<xiObj>!zip!UEsDBBQACAgIA==\n</xiObj>\n", "utf8"),
  Buffer.from([0x00, 0xff, 0x10, 0x0d, 0x0a, 0x80]),
]);

const zipCliente = () => ({
  get: () =>
    Promise.resolve(
      writeZip([
        { name: "src/main/resources/mapping/MM_x.mmap", data: BLOB },
        { name: "src/main/resources/xsd/a.xsd", data: "<xsd/>" },
      ])
    ),
});

test("guarda el archivo byte a byte y reporta nombre y tamano", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cpi-save-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const out = join(dir, "MM_x.mmap");
  const r = await saveBundleFile(zipCliente(), "IF_X", { file: "MM_x.mmap", saveTo: out });

  assert.equal(r.name, "src/main/resources/mapping/MM_x.mmap");
  assert.equal(r.savedTo, out);
  assert.equal(r.size, BLOB.length);
  assert.deepEqual(readFileSync(out), BLOB, "la copia en disco difiere del bundle");
});

test("un destino cuyo directorio no existe falla con hint, sin mkdir silencioso", async () => {
  const out = join(tmpdir(), "cpi-save-no-existe", "sub", "MM_x.mmap");
  await assert.rejects(
    () => saveBundleFile(zipCliente(), "IF_X", { file: "MM_x.mmap", saveTo: out }),
    (err) => {
      assert.match(err.message, /No se pudo escribir/);
      assert.match(err.hint, /directorio destino/);
      return true;
    }
  );
});

test("un file que no esta en el bundle propaga el error de readBundleFile", async () => {
  await assert.rejects(
    () => saveBundleFile(zipCliente(), "IF_X", { file: "no-esta.mmap", saveTo: join(tmpdir(), "x") }),
    /no contiene "no-esta.mmap"/
  );
});

test("no pisa un archivo local existente sin overwrite:true", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cpi-save-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, "MM_x.mmap");
  writeFileSync(out, "previo");

  await assert.rejects(
    () => saveBundleFile(zipCliente(), "IF_X", { file: "MM_x.mmap", saveTo: out }),
    (err) => {
      assert.match(err.message, /Ya existe/);
      assert.match(err.hint, /overwrite:true/);
      return true;
    }
  );
  assert.equal(readFileSync(out, "utf8"), "previo", "el archivo previo tiene que quedar intacto");

  const r = await saveBundleFile(zipCliente(), "IF_X", {
    file: "MM_x.mmap",
    saveTo: out,
    overwrite: true,
  });
  assert.equal(r.savedTo, out);
  assert.deepEqual(readFileSync(out), BLOB);
});

test("el saveTo de cpi_iflow_read respeta overwrite y avisa que includeContent no aplica", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cpi-save-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, "MM_x.mmap");
  writeFileSync(out, "previo");

  const sin = await readHandler({ id: "IF_X", file: "MM_x.mmap", saveTo: out }, { client: zipCliente() });
  assert.equal(sin.isError, true);
  assert.match(sin.content[0].text, /Ya existe/);

  const con = await readHandler(
    { id: "IF_X", file: "MM_x.mmap", saveTo: out, overwrite: true, includeContent: true },
    { client: zipCliente() }
  );
  assert.ok(!con.isError, con.content?.[0]?.text);
  assert.deepEqual(readFileSync(out), BLOB);
  assert.match(con.content[0].text, /includeContent se ignora/);
});
