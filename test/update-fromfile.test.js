/**
 * Unitarios del fromFile de cpi_iflow_update: el contenido que llega al bundle tiene que ser
 * el del disco, byte a byte.
 *
 * Es la contraparte del saveTo de cpi_iflow_read y existe por el mismo motivo (2026-08-25):
 * pasar un archivo como texto por el protocolo corrompe blobs y binarios. El test invoca el
 * handler real con un cliente doble que devuelve un ZIP de verdad y captura el que se sube.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeZip, readZip } from "../src/core/zip.js";
import { handler } from "../src/tools/cpi-iflow-update.js";

// Bytes que un re-tipeo pierde: no-ASCII, NULs, CRLF.
const BLOB = Buffer.concat([
  Buffer.from("<iflw>ñandú</iflw>\r\n", "utf8"),
  Buffer.from([0x00, 0xff, 0x7f]),
]);

/** Cliente doble: get devuelve un bundle real, put captura el body subido. */
function dobleCliente() {
  const puts = [];
  return {
    puts,
    get: () =>
      Promise.resolve(
        writeZip([
          { name: "src/a.iflw", data: "viejo" },
          { name: "src/otro.txt", data: "intacto" },
        ])
      ),
    put: (path, body) => {
      puts.push({ path, body });
      return Promise.resolve({});
    },
  };
}

test("fromFile sube los bytes del disco, no una transcripcion", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cpi-fromfile-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const local = join(dir, "a.iflw");
  writeFileSync(local, BLOB);

  const c = dobleCliente();
  const r = await handler({ id: "IF_X", files: [{ name: "src/a.iflw", fromFile: local }] }, { client: c });

  assert.equal(r.isError, undefined, JSON.stringify(r.content));
  assert.equal(c.puts.length, 1);

  const subido = readZip(Buffer.from(c.puts[0].body.ArtifactContent, "base64"), { content: true });
  const porNombre = new Map(subido.map((e) => [e.name, e.data]));
  assert.deepEqual(porNombre.get("src/a.iflw"), BLOB, "lo subido difiere del archivo local");
  assert.equal(porNombre.get("src/otro.txt").toString("utf8"), "intacto");
});

test("content y fromFile juntos (o ninguno) se rechazan antes de tocar el tenant", async () => {
  const c = dobleCliente();

  const ambos = await handler(
    { id: "IF_X", files: [{ name: "a", content: "x", fromFile: "y" }] },
    { client: c }
  );
  assert.equal(ambos.isError, true);
  assert.match(ambos.content[0].text, /exactamente uno/);

  const ninguno = await handler({ id: "IF_X", files: [{ name: "a" }] }, { client: c });
  assert.equal(ninguno.isError, true);
  assert.match(ninguno.content[0].text, /exactamente uno/);

  assert.equal(c.puts.length, 0, "no tendria que haber llegado ningun put al tenant");
});

test("un fromFile ilegible falla nombrando el archivo, sin bajar el bundle", async () => {
  let gets = 0;
  const c = { get: () => (gets++, Promise.resolve(Buffer.alloc(0))), put: () => Promise.resolve({}) };

  const r = await handler(
    { id: "IF_X", files: [{ name: "src/a.iflw", fromFile: join(tmpdir(), "no-existe-8f3a.iflw") }] },
    { client: c }
  );

  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /No se pudo leer/);
  assert.match(r.content[0].text, /no-existe-8f3a/);
  assert.equal(gets, 0, "el path local roto no tiene que costar una descarga");
});
