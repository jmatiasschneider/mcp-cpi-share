/**
 * Unitarios del enganche mapping -> iFlow: las dos mitades que hay que escribir juntas.
 *
 * Es logica que no falla donde se ejecuta. Un .iflw con la referencia a medias sube al tenant
 * sin protestar —en designtime el bundle ni se mira— y recien revienta al deployar, con un
 * error de resolucion OSGi que no menciona el mapping. Por eso se verifica aca.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { mappingSteps, setMappingReference, listProperties } from "../src/core/iflw.js";
import { addRequireCapability, messageMappingCapability } from "../src/core/ops/write.js";

// --- fixture: un modelo con un Content Modifier y dos pasos de mapping -------

const paso = (id, name, props) =>
  [
    `        <bpmn2:callActivity id="${id}" name="${name}">`,
    `            <bpmn2:extensionElements>`,
    ...props.flatMap(([k, v]) => [
      `                <ifl:property>`,
      `                    <key>${k}</key>`,
      v === "" ? `                    <value/>` : `                    <value>${v}</value>`,
      `                </ifl:property>`,
    ]),
    `            </bpmn2:extensionElements>`,
    `            <bpmn2:incoming>SequenceFlow_1</bpmn2:incoming>`,
    `            <bpmn2:outgoing>SequenceFlow_2</bpmn2:outgoing>`,
    `        </bpmn2:callActivity>`,
  ].join("\n");

const ENRICHER = paso("CallActivity_18", "Content Modifier 2", [
  ["bodyType", "constant"],
  ["propertyTable", ""],
  ["componentVersion", "1.6"],
  ["activityType", "Enricher"],
  ["cmdVariantUri", "ctype::FlowstepVariant/cname::Enricher/version::1.6.3"],
]);

// Un paso recien puesto en el modelo: tiene activityType pero no messageMappingBundleId.
const MAPEO_VACIO = paso("CallActivity_7", "Message Mapping 1", [
  ["mappinguri", ""],
  ["mappingname", ""],
  ["mappingpath", ""],
  ["componentVersion", "1.5"],
  ["activityType", "Mapping"],
]);

const MAPEO_USADO = paso("CallActivity_9", "Message Mapping 2", [
  ["mappinguri", "dir://mmap/src/main/resources/mapping/MM_VIEJO.mmap"],
  ["mappingname", "MM_VIEJO"],
  ["mappingpath", "src/main/resources/mapping/MM_VIEJO"],
  ["messageMappingBundleId", "MM_VIEJO"],
  ["mappingType", "MessageMapping"],
  ["mappingReference", "static"],
  ["activityType", "Mapping"],
]);

const modelo = (...pasos) =>
  [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<bpmn2:definitions xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:ifl="http:///com.sap.ifl.model/Ifl.xsd">`,
    `    <bpmn2:process id="Process_1" name="Integration Process">`,
    ...pasos,
    `    </bpmn2:process>`,
    `</bpmn2:definitions>`,
  ].join("\n");

const MMAP = "src/main/resources/mapping/MM_TEST_TRIVIAL.mmap";

/** Las propiedades de UN paso, para verificar que el de al lado no se movio. */
function propsDe(xml, stepId) {
  const bloque = xml.match(new RegExp(`<bpmn2:callActivity id="${stepId}"[\\s\\S]*?</bpmn2:callActivity>`))[0];
  return Object.fromEntries(listProperties(bloque).map((p) => [p.key, p.value]));
}

// --- encontrar el paso ------------------------------------------------------

test("mappingSteps ve los pasos de Mapping y no los demas", () => {
  const steps = mappingSteps(modelo(ENRICHER, MAPEO_VACIO, MAPEO_USADO));

  assert.deepEqual(
    steps.map((s) => s.id),
    ["CallActivity_7", "CallActivity_9"],
    "el Content Modifier no es un paso de mapping"
  );
  assert.equal(steps[0].name, "Message Mapping 1");
  assert.equal(steps[1].messageMappingBundleId, "MM_VIEJO", "informa a que apunta hoy");
});

test("con un solo paso no hace falta indicar cual", () => {
  const r = setMappingReference(modelo(ENRICHER, MAPEO_VACIO), {
    mappingId: "MM_TEST_TRIVIAL",
    mmapPath: MMAP,
  });
  assert.equal(r.step.id, "CallActivity_7");
});

test("con dos pasos, elegir en silencio seria el peor default", () => {
  assert.throws(
    () => setMappingReference(modelo(MAPEO_VACIO, MAPEO_USADO), { mappingId: "X", mmapPath: MMAP }),
    (err) => {
      assert.match(err.message, /tiene 2 pasos de mapping/);
      assert.match(err.hint, /CallActivity_7 \("Message Mapping 1"\)/);
      assert.match(err.hint, /CallActivity_9/);
      return true;
    }
  );
});

test("el paso se elige por Id o por nombre visible", () => {
  const xml = modelo(MAPEO_VACIO, MAPEO_USADO);
  for (const step of ["CallActivity_9", "Message Mapping 2"]) {
    const r = setMappingReference(xml, { step, mappingId: "MM_TEST_TRIVIAL", mmapPath: MMAP });
    assert.equal(r.step.id, "CallActivity_9", `no resolvio "${step}"`);
  }
});

test("un step inexistente nombra los que si estan", () => {
  assert.throws(
    () => setMappingReference(modelo(MAPEO_VACIO), { step: "CallActivity_99", mappingId: "X", mmapPath: MMAP }),
    (err) => {
      assert.match(err.message, /"CallActivity_99"/);
      assert.match(err.hint, /CallActivity_7/);
      return true;
    }
  );
});

test("un modelo sin paso de mapping explica que el arquetipo tiene que traerlo", () => {
  assert.throws(
    () => setMappingReference(modelo(ENRICHER), { mappingId: "X", mmapPath: MMAP }),
    (err) => {
      assert.match(err.message, /no tiene ningun paso de Message Mapping/);
      assert.match(err.hint, /arquetipo/);
      return true;
    }
  );
});

// --- escribir las propiedades -----------------------------------------------

test("escribe las seis propiedades que pide el tenant", () => {
  const r = setMappingReference(modelo(ENRICHER, MAPEO_VACIO), {
    mappingId: "MM_TEST_TRIVIAL",
    mmapPath: MMAP,
  });
  const p = propsDe(r.xml, "CallActivity_7");

  assert.equal(p.mappinguri, "dir://mmap/src/main/resources/mapping/MM_TEST_TRIVIAL.mmap");
  assert.equal(p.mappingname, "MM_TEST_TRIVIAL");
  assert.equal(p.mappingpath, "src/main/resources/mapping/MM_TEST_TRIVIAL");
  assert.equal(p.messageMappingBundleId, "MM_TEST_TRIVIAL");
  assert.equal(p.mappingType, "MessageMapping");
  assert.equal(p.mappingReference, "static");
});

test("las claves que el paso no tenia se agregan, no se pierden", () => {
  // Sin messageMappingBundleId la referencia no resuelve, y ese paso "vacio" no la trae.
  const r = setMappingReference(modelo(MAPEO_VACIO), { mappingId: "MM_X", mmapPath: MMAP });
  assert.deepEqual(r.agregadas, ["messageMappingBundleId", "mappingType", "mappingReference"]);
});

test("el nombre del .mmap manda sobre el Id del artefacto", () => {
  // El nombre del archivo no es predecible desde el Id: al clonar, el tenant lo normaliza, pero
  // un bundle importado a mano puede traer cualquiera. Derivarlo dejaria el puntero al vacio.
  const r = setMappingReference(modelo(MAPEO_VACIO), {
    mappingId: "MM_CLON",
    mmapPath: "src/main/resources/mapping/MM_ORIGINAL.mmap",
  });
  const p = propsDe(r.xml, "CallActivity_7");

  assert.equal(p.mappingname, "MM_ORIGINAL", "el nombre sale del archivo");
  assert.equal(p.messageMappingBundleId, "MM_CLON", "el bundle sale del Id");
});

test("no toca los otros pasos del modelo", () => {
  const xml = modelo(ENRICHER, MAPEO_VACIO, MAPEO_USADO);
  const r = setMappingReference(xml, {
    step: "CallActivity_7",
    mappingId: "MM_TEST_TRIVIAL",
    mmapPath: MMAP,
  });

  assert.deepEqual(propsDe(r.xml, "CallActivity_18"), propsDe(xml, "CallActivity_18"));
  assert.deepEqual(propsDe(r.xml, "CallActivity_9"), propsDe(xml, "CallActivity_9"));
});

test("pisar una referencia anterior informa cual era", () => {
  const r = setMappingReference(modelo(MAPEO_USADO), {
    mappingId: "MM_TEST_TRIVIAL",
    mmapPath: MMAP,
  });
  assert.equal(r.before.messageMappingBundleId, "MM_VIEJO");
  assert.equal(propsDe(r.xml, "CallActivity_9").mappingname, "MM_TEST_TRIVIAL");
  assert.ok(!r.xml.includes("MM_VIEJO"), "no queda rastro del anterior");
});

test("aplicarla dos veces da el mismo modelo", () => {
  const p = { mappingId: "MM_TEST_TRIVIAL", mmapPath: MMAP };
  const una = setMappingReference(modelo(ENRICHER, MAPEO_VACIO), p).xml;
  assert.equal(setMappingReference(una, p).xml, una);
});

test("un Id con patrones de replace no se reinyecta a si mismo", () => {
  // En un string de reemplazo, `$&` y `$1` los expande String.replace: un Id que los contenga
  // se traeria encima el texto matcheado.
  const r = setMappingReference(modelo(MAPEO_VACIO), { mappingId: "MM_$1_X", mmapPath: MMAP });
  assert.equal(propsDe(r.xml, "CallActivity_7").messageMappingBundleId, "MM_$1_X");
});

test("un valor con & o < sale escapado como XML", () => {
  const r = setMappingReference(modelo(MAPEO_VACIO), { mappingId: "A&B", mmapPath: MMAP });
  assert.match(r.xml, /<value>A&amp;B<\/value>/, "sin escapar, el .iflw deja de ser XML valido");
});

test("una ruta que no es .mmap se rechaza antes de escribir nada", () => {
  assert.throws(
    () => setMappingReference(modelo(MAPEO_VACIO), { mappingId: "X", mmapPath: "src/x.xsd" }),
    /no es un \.mmap/
  );
});

// --- MANIFEST.MF ------------------------------------------------------------

const IMPORT_PACKAGE = [
  "Import-Package: com.sap.esb.application.services.cxf.interceptor,com.sap",
  " .esb.security,com.sap.it.op.agent.api,org.apache.camel;version=\"[2.24,3",
  " )\",org.slf4j",
];

const MANIFEST = [
  "Manifest-Version: 1.0",
  "Bundle-ManifestVersion: 2",
  "Bundle-Name: WS Nuevo",
  "Bundle-SymbolicName: WS_NUEVO; singleton:=true",
  ...IMPORT_PACKAGE,
  "Bundle-Version: 1.0.0",
  "",
].join("\n");

const CLAUSULA = messageMappingCapability("MM_TEST_TRIVIAL");

/** Desdobla las continuaciones para poder leer el valor logico de un header. */
function header(text, key) {
  const lineas = text.split("\n");
  const i = lineas.findIndex((l) => l.startsWith(`${key}:`));
  if (i < 0) return null;
  let v = lineas[i].slice(key.length + 1).replace(/^ /, "");
  for (let j = i + 1; j < lineas.length && lineas[j].startsWith(" "); j++) v += lineas[j].slice(1);
  return v;
}

test("agrega el Require-Capability cuando no estaba", () => {
  const { text, changed } = addRequireCapability(MANIFEST, CLAUSULA);

  assert.equal(changed, true);
  assert.equal(header(text, "Require-Capability"), CLAUSULA);
  assert.match(header(text, "Require-Capability"), /source:String="reference"/);
});

test("el Import-Package sobrevive intacto, linea por linea", () => {
  // Volver a plegar el manifiesto entero daria un archivo equivalente pero distinto del que
  // escribio SAP. No se nota al crear el artefacto: se nota al deployar.
  const { text } = addRequireCapability(MANIFEST, CLAUSULA);
  const lineas = text.split("\n");
  const idx = lineas.indexOf(IMPORT_PACKAGE[0]);

  assert.notEqual(idx, -1);
  assert.deepEqual(lineas.slice(idx, idx + IMPORT_PACKAGE.length), IMPORT_PACKAGE);
});

test("ninguna linea pasa de 72 bytes", () => {
  const { text } = addRequireCapability(MANIFEST, CLAUSULA);
  for (const l of text.split("\n")) {
    assert.ok(Buffer.byteLength(l, "utf8") <= 72, `linea de ${l.length}: ${l}`);
  }
});

test("las continuaciones que genera arrancan con UN espacio", () => {
  const { text } = addRequireCapability(MANIFEST, CLAUSULA);
  const lineas = text.split("\n");
  const i = lineas.findIndex((l) => l.startsWith("Require-Capability:"));

  assert.ok(lineas[i + 1].startsWith(" "), "la clausula entra en mas de una linea");
  assert.ok(!lineas[i + 1].startsWith("  "), "un solo espacio: el resto es valor");
});

test("un segundo mapping se suma al header, no lo duplica", () => {
  // Un MANIFEST no admite la misma clave dos veces.
  const uno = addRequireCapability(MANIFEST, CLAUSULA).text;
  const dos = addRequireCapability(uno, messageMappingCapability("MM_OTRO"));

  assert.equal(dos.changed, true);
  assert.equal(
    dos.text.split("\n").filter((l) => l.startsWith("Require-Capability:")).length,
    1
  );
  const v = header(dos.text, "Require-Capability");
  assert.ok(v.includes("messagemapping.MM_TEST_TRIVIAL"));
  assert.ok(v.includes("messagemapping.MM_OTRO"));
});

test("repetir la misma capability no cambia nada", () => {
  const uno = addRequireCapability(MANIFEST, CLAUSULA).text;
  const dos = addRequireCapability(uno, CLAUSULA);

  assert.equal(dos.changed, false, "avisa que ya estaba");
  assert.equal(dos.text, uno);
});

test("respeta un Require-Capability que ya traia otra cosa", () => {
  const conOsgi = MANIFEST.replace(
    "Bundle-Version: 1.0.0",
    "Require-Capability: osgi.ee;filter:=\"(&(osgi.ee=JavaSE)(version=1.8))\"\nBundle-Version: 1.0.0"
  );
  const { text } = addRequireCapability(conOsgi, CLAUSULA);
  const v = header(text, "Require-Capability");

  assert.ok(v.startsWith("osgi.ee;"), "lo que estaba va primero");
  assert.ok(v.includes(",messagemapping.MM_TEST_TRIVIAL"));
});

test("el manifiesto sigue terminando en salto de linea", () => {
  // Sin salto final es motivo de bundle invalido para varios parsers OSGi.
  assert.ok(addRequireCapability(MANIFEST, CLAUSULA).text.endsWith("\n"));
});

test("una entrada CRLF sale normalizada, como en rewriteManifest", () => {
  const { text } = addRequireCapability(MANIFEST.replace(/\n/g, "\r\n"), CLAUSULA);
  assert.ok(!text.includes("\r"));
  assert.equal(header(text, "Require-Capability"), CLAUSULA);
});
