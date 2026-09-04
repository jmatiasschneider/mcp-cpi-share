/**
 * Unitarios de core/zip.js — formato puro, sin tenant ni red.
 *
 * Por que existen: un ZIP mal armado NO falla al escribir, falla al deployar. El API acepta
 * cualquier base64 y el error aparece despues, en el runtime del tenant. Es el peor lugar
 * posible para enterarse, asi que la garantia tiene que estar aca.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { readZip, writeZip, crc32 } from "../src/core/zip.js";

const utf8 = (b) => b.toString("utf8");
const byName = (entries) => new Map(entries.map((e) => [e.name, e]));

test("crc32 coincide con el vector conocido de la spec", () => {
  // "123456789" -> 0xCBF43926 es el check value estandar de CRC-32/ISO-HDLC.
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("round-trip: los nombres y el contenido sobreviven a escribir y leer", () => {
  const entries = [
    { name: "META-INF/MANIFEST.MF", data: "Manifest-Version: 1.0\n" },
    { name: "src/main/resources/scenarioflows/integrationflow/x.iflw", data: "<xml/>" },
    { name: "src/main/resources/script/mapeo.groovy", data: "def x = 1" },
  ];

  const leidas = readZip(writeZip(entries), { content: true });

  assert.equal(leidas.length, 3);
  assert.deepEqual(
    leidas.map((e) => e.name),
    entries.map((e) => e.name),
    "el orden de las entradas se conserva"
  );
  for (const [i, e] of leidas.entries()) {
    assert.equal(utf8(e.data), entries[i].data);
    assert.equal(e.size, Buffer.byteLength(entries[i].data), "el size declarado es el descomprimido");
  }
});

test("acepta Buffer y string indistintamente como data", () => {
  const zip = writeZip([
    { name: "a.txt", data: "texto" },
    { name: "b.bin", data: Buffer.from([0x00, 0xff, 0x10]) },
  ]);
  const m = byName(readZip(zip, { content: true }));

  assert.equal(utf8(m.get("a.txt").data), "texto");
  assert.deepEqual([...m.get("b.bin").data], [0x00, 0xff, 0x10]);
});

test("elige deflate solo cuando comprime, y las dos ramas se releen igual", () => {
  const comprimible = "A".repeat(2000);
  const incomprimible = randomBytes(512);

  const m = byName(
    readZip(writeZip([
      { name: "repetido.txt", data: comprimible },
      { name: "random.bin", data: incomprimible },
    ]), { content: true })
  );

  assert.equal(m.get("repetido.txt").method, 8, "lo repetitivo va deflate");
  assert.equal(m.get("random.bin").method, 0, "lo incompresible se guarda tal cual (store)");

  assert.equal(utf8(m.get("repetido.txt").data), comprimible);
  assert.deepEqual(m.get("random.bin").data, incomprimible);
});

test("sin content:true devuelve solo metadata, sin data", () => {
  const zip = writeZip([{ name: "a.txt", data: "hola" }]);
  const [e] = readZip(zip);

  assert.equal(e.name, "a.txt");
  assert.equal(e.size, 4);
  assert.equal(e.data, undefined);
});

test("los nombres y el contenido no-ASCII no se corrompen", () => {
  // El largo del nombre se guarda en BYTES, no en caracteres: si alguien usa name.length
  // en vez de Buffer.byteLength, el central directory queda desalineado y el ZIP se rompe.
  const name = "src/main/resources/mapeo-ñoño-漢字.xsl";
  const data = "<x>áéíóú 漢字 —</x>";

  const [e] = readZip(writeZip([{ name, data }]), { content: true });

  assert.equal(e.name, name);
  assert.equal(utf8(e.data), data);
});

test("un archivo vacio round-trippea sin romper", () => {
  const m = byName(
    readZip(writeZip([
      { name: "vacio.txt", data: "" },
      { name: "despues.txt", data: "no soy vacio" },
    ]), { content: true })
  );

  assert.equal(m.get("vacio.txt").size, 0);
  assert.equal(utf8(m.get("vacio.txt").data), "");
  assert.equal(utf8(m.get("despues.txt").data), "no soy vacio", "el offset del siguiente sigue bien");
});

test("los offsets aguantan una entrada grande entre dos chicas", () => {
  const grande = Buffer.from("x".repeat(200_000));
  const m = byName(
    readZip(writeZip([
      { name: "antes.txt", data: "A" },
      { name: "grande.bin", data: grande },
      { name: "despues.txt", data: "Z" },
    ]), { content: true })
  );

  assert.equal(utf8(m.get("antes.txt").data), "A");
  assert.equal(m.get("grande.bin").size, grande.length);
  assert.equal(utf8(m.get("despues.txt").data), "Z", "la ultima entrada se lee despues de 200 KB");
});

test("reescribir un bundle conserva byte a byte los archivos que no se tocaron", () => {
  // Es exactamente lo que hace updateArtifactFiles(): bajar, cambiar uno, volver a subir todo.
  const original = [
    { name: "META-INF/MANIFEST.MF", data: "Manifest-Version: 1.0\nBundle-Name: Plantilla\n" },
    { name: ".project", data: "<projectDescription><name>Plantilla</name></projectDescription>" },
    { name: "src/main/resources/parameters.prop", data: "#fecha\nEndpoint=https\\://a.b/c\n" },
    { name: "src/main/resources/script/mapeo.groovy", data: "def x = 1\n".repeat(300) },
    { name: "src/main/resources/binario.p12", data: randomBytes(1024) },
  ];

  const entries = readZip(writeZip(original), { content: true });
  const reescrito = entries.map((e) =>
    e.name === "META-INF/MANIFEST.MF"
      ? { name: e.name, data: "Manifest-Version: 1.0\nBundle-Name: Clon\n" }
      : { name: e.name, data: e.data }
  );

  const m = byName(readZip(writeZip(reescrito), { content: true }));

  assert.equal(m.size, original.length, "no se pierde ni se duplica ninguna entrada");
  assert.match(utf8(m.get("META-INF/MANIFEST.MF").data), /Bundle-Name: Clon/);
  for (const e of original.slice(1)) {
    const esperado = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf8");
    assert.deepEqual(m.get(e.name).data, esperado, `${e.name} quedo intacto`);
  }
});

test("agregar un archivo nuevo no altera los existentes", () => {
  const base = readZip(writeZip([{ name: "a.txt", data: "uno" }]), { content: true });
  const conNuevo = [...base.map((e) => ({ name: e.name, data: e.data })), { name: "b.txt", data: "dos" }];

  const m = byName(readZip(writeZip(conNuevo), { content: true }));
  assert.equal(utf8(m.get("a.txt").data), "uno");
  assert.equal(utf8(m.get("b.txt").data), "dos");
});

test("un buffer que no es ZIP falla con un mensaje entendible", () => {
  assert.throws(
    () => readZip(Buffer.from("esto no es un zip ni de casualidad")),
    /no es un ZIP valido/i
  );
});

test("un ZIP truncado no devuelve entradas fantasma", () => {
  const zip = writeZip([
    { name: "a.txt", data: "uno" },
    { name: "b.txt", data: "dos" },
  ]);
  // Se pisa la firma del segundo registro del central directory. El nombre aparece dos veces
  // (header local y central); el ultimo es el del central, y su registro arranca 46 bytes antes.
  const roto = Buffer.from(zip);
  const idx = roto.lastIndexOf(Buffer.from("b.txt"));
  roto.writeUInt32LE(0xdeadbeef, idx - 46);

  const leidas = readZip(roto);
  assert.equal(leidas.length, 1, "corta en la primera entrada invalida en vez de inventar datos");
});
