/**
 * Unitarios de rewriteManifest() / rewriteProject() — el paso que hace clonable un bundle.
 *
 * El MANIFEST.MF parte las lineas largas a los 72 bytes y las continua con una linea que
 * arranca en espacio. El Import-Package de un iFlow son ~1,5 KB asi partidos: si el
 * reescribido no respeta esas continuaciones, el bundle OSGi queda invalido. Y no se nota
 * al crear el artefacto — se nota al deployar, porque en designtime el manifiesto ni se mira.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { rewriteManifest, rewriteProject } from "../src/core/ops/write.js";

// Import-Package partido igual que lo escribe SAP: continuaciones con un espacio inicial.
const IMPORT_PACKAGE = [
  "Import-Package: com.sap.esb.application.services.cxf.interceptor,com.sap",
  " .esb.security,com.sap.it.op.agent.api,com.sap.it.op.agent.collector.cam",
  " el,com.sap.it.op.agent.mpl,javax.xml.bind,org.apache.camel;version=\"[2.",
  " 24,3)\",org.slf4j",
];

const MANIFEST = [
  "Manifest-Version: 1.0",
  "Bundle-ManifestVersion: 2",
  "Bundle-Name: Plantilla HTTP",
  "Bundle-SymbolicName: PlantillaHTTP; singleton:=true",
  ...IMPORT_PACKAGE,
  "Origin-Bundle-Name: Plantilla HTTP",
  "Origin-Bundle-SymbolicName: PlantillaHTTP",
  "Origin-Bundle-Version: 1.0.0",
  "Bundle-Version: 1.0.0",
  "",
].join("\n");

const lineas = (t) => t.split("\n");

test("las continuaciones de Import-Package sobreviven intactas", () => {
  const out = rewriteManifest(MANIFEST, { id: "WS_NUEVO", name: "WS Nuevo" });

  // No alcanza con que "contenga" los paquetes: tienen que estar como lineas, en orden.
  const idx = lineas(out).indexOf(IMPORT_PACKAGE[0]);
  assert.notEqual(idx, -1, "la linea inicial del Import-Package sigue ahi");
  assert.deepEqual(lineas(out).slice(idx, idx + IMPORT_PACKAGE.length), IMPORT_PACKAGE);
});

test("reescribe las cuatro claves de identidad y nada mas", () => {
  const out = lineas(rewriteManifest(MANIFEST, { id: "WS_NUEVO", name: "WS Nuevo" }));

  assert.ok(out.includes("Bundle-Name: WS Nuevo"));
  assert.ok(out.includes("Bundle-SymbolicName: WS_NUEVO; singleton:=true"));
  assert.ok(out.includes("Origin-Bundle-Name: WS Nuevo"));
  assert.ok(out.includes("Origin-Bundle-SymbolicName: WS_NUEVO"));

  // Las que no estan en la lista quedan literales, incluida Origin-Bundle-Version,
  // que empieza igual que dos de las que si se tocan.
  for (const l of [
    "Manifest-Version: 1.0",
    "Bundle-ManifestVersion: 2",
    "Origin-Bundle-Version: 1.0.0",
    "Bundle-Version: 1.0.0",
  ]) {
    assert.ok(out.includes(l), `${l} no deberia haberse tocado`);
  }

  assert.equal(out.filter((l) => l.startsWith("Bundle-Name:")).length, 1, "no se duplica la clave");
  assert.ok(!out.some((l) => l.includes("PlantillaHTTP")), "no queda rastro del Id viejo");
});

test("sin name, el Id hace de nombre", () => {
  const out = lineas(rewriteManifest(MANIFEST, { id: "WS_NUEVO" }));
  assert.ok(out.includes("Bundle-Name: WS_NUEVO"));
  assert.ok(out.includes("Origin-Bundle-Name: WS_NUEVO"));
});

test("al reemplazar una clave se descartan SUS continuaciones", () => {
  // Un Bundle-Name largo tambien viene partido. Si las continuaciones del valor viejo
  // quedaran, el nombre nuevo arrastraria pedazos del anterior.
  const conNombreLargo = MANIFEST.replace(
    "Bundle-Name: Plantilla HTTP",
    ["Bundle-Name: Plantilla HTTP con un nombre larguisimo que SAP parte a l", " os 72 bytes"].join("\n")
  );

  const out = lineas(rewriteManifest(conNombreLargo, { id: "WS_NUEVO", name: "WS Nuevo" }));

  assert.ok(out.includes("Bundle-Name: WS Nuevo"));
  assert.ok(!out.some((l) => l.includes("os 72 bytes")), "la continuacion vieja se fue");
  // Y el descarte no se contagia a la clave siguiente.
  assert.ok(out.includes("Bundle-SymbolicName: WS_NUEVO; singleton:=true"));
});

test("una entrada CRLF se procesa igual y sale normalizada a LF", () => {
  const out = rewriteManifest(MANIFEST.replace(/\n/g, "\r\n"), { id: "WS_NUEVO", name: "WS Nuevo" });

  assert.ok(!out.includes("\r"), "no quedan CR sueltos");
  const idx = lineas(out).indexOf(IMPORT_PACKAGE[0]);
  assert.deepEqual(lineas(out).slice(idx, idx + IMPORT_PACKAGE.length), IMPORT_PACKAGE);
});

test("el manifiesto sigue terminando en linea vacia", () => {
  // MANIFEST.MF sin salto final es motivo de bundle invalido para varios parsers OSGi.
  const out = rewriteManifest(MANIFEST, { id: "WS_NUEVO" });
  assert.ok(out.endsWith("\n"));
});

test("reescribir dos veces da el mismo resultado", () => {
  const una = rewriteManifest(MANIFEST, { id: "WS_NUEVO", name: "WS Nuevo" });
  const dos = rewriteManifest(una, { id: "WS_NUEVO", name: "WS Nuevo" });
  assert.equal(dos, una);
});

test("un Id con caracteres de regex no rompe nada", () => {
  const out = lineas(rewriteManifest(MANIFEST, { id: "WS.$1[x]", name: "N$&" }));
  assert.ok(out.includes("Bundle-SymbolicName: WS.$1[x]; singleton:=true"));
  assert.ok(out.includes("Bundle-Name: N$&"));
});

// --- .project ---------------------------------------------------------------

test("rewriteProject cambia el <name> del proyecto", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<projectDescription>
  <name>PlantillaHTTP</name>
  <comment></comment>
  <buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name></buildCommand></buildSpec>
</projectDescription>`;

  const out = rewriteProject(xml, { id: "WS_NUEVO" });

  assert.match(out, /<name>WS_NUEVO<\/name>/);
  assert.ok(!out.includes("PlantillaHTTP"));
  assert.match(out, /<name>org\.eclipse\.jdt\.core\.javabuilder<\/name>/, "solo se toca el primer <name>");
});

test("rewriteProject no reinyecta patrones de replace en el Id", () => {
  const out = rewriteProject("<name>viejo</name>", { id: "WS_$&_$1" });
  assert.equal(out, "<name>WS_$&_$1</name>");
});
