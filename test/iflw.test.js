/**
 * Unitarios de core/iflw.js — el formato del modelo BPMN y del parameters.prop.
 *
 * Lo que se protege aca no es "que parsee": es que **falle** cuando la clave es ambigua.
 * Reemplazar en silencio la primera coincidencia toca el componente equivocado, y eso no
 * se nota hasta que el iFlow corre en el tenant contra el backend que no era.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  listProperties,
  externalizableProperties,
  externalizeProperty,
  parseProps,
  writeProps,
} from "../src/core/iflw.js";

// Fragmento con la forma real de un .iflw: un participant y un messageFlow HTTP.
const IFLW = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn2:definitions xmlns:ifl="http:///com.sap.ifl.model/Ifl.xsd">
  <bpmn2:participant id="Participant_1">
    <bpmn2:extensionElements>
      <ifl:property><key>componentVersion</key><value>1.1</value></ifl:property>
      <ifl:property><key>ifl:type</key><value>EndpointRecevier</value></ifl:property>
    </bpmn2:extensionElements>
  </bpmn2:participant>
  <bpmn2:messageFlow id="MessageFlow_1">
    <bpmn2:extensionElements>
      <ifl:property><key>componentVersion</key><value>1.5</value></ifl:property>
      <ifl:property><key>address</key><value>https://backend.example.com/svc</value></ifl:property>
      <ifl:property><key>credentialName</key><value>BACKEND_WS</value></ifl:property>
      <ifl:property><key>proxyType</key><value/></ifl:property>
      <ifl:property><key>allowedHeaders</key><value>{{HeadersPermitidos}}</value></ifl:property>
      <ifl:property><key>some.timeout</key><value>60000</value></ifl:property>
    </bpmn2:extensionElements>
  </bpmn2:messageFlow>
</bpmn2:definitions>`;

const claves = (xml) => listProperties(xml).map((p) => p.key);
const valorDe = (xml, key) => listProperties(xml).find((p) => p.key === key)?.value;

// --- listProperties ---------------------------------------------------------

test("listProperties lee todas las propiedades en orden", () => {
  assert.deepEqual(claves(IFLW), [
    "componentVersion",
    "ifl:type",
    "componentVersion",
    "address",
    "credentialName",
    "proxyType",
    "allowedHeaders",
    "some.timeout",
  ]);
});

test("un <value/> vacio se lee como string vacio y no corta el parseo", () => {
  // La trampa: <value/> no es <value></value>. Si el regex no contempla la forma corta,
  // el parseo se saltea la propiedad y arrastra el desfase a todas las que siguen.
  assert.equal(valorDe(IFLW, "proxyType"), "");
  assert.equal(valorDe(IFLW, "some.timeout"), "60000", "las de despues siguen alineadas");
});

test("listProperties tolera saltos de linea y espacios adentro de key y value", () => {
  const xml = `<ifl:property>
    <key>  address  </key>
    <value>
      https://a.b/c
    </value>
  </ifl:property>`;
  assert.deepEqual(listProperties(xml), [{ key: "address", value: "https://a.b/c" }]);
});

// --- externalizableProperties -----------------------------------------------

test("los candidatos excluyen ruido, vacios y lo ya externalizado", () => {
  const cands = externalizableProperties(IFLW);
  assert.deepEqual(
    cands.map((c) => c.key).sort(),
    ["address", "credentialName", "some.timeout"]
  );
  assert.ok(cands.every((c) => !c.ambiguo));
});

test("una clave repetida se marca ambigua con todos sus valores", () => {
  const xml = IFLW.replace(
    "<key>credentialName</key><value>BACKEND_WS</value>",
    "<key>address</key><value>https://otro.example.com/svc</value>"
  );
  const address = externalizableProperties(xml).find((c) => c.key === "address");

  assert.equal(address.ambiguo, true);
  assert.deepEqual(address.values, ["https://backend.example.com/svc", "https://otro.example.com/svc"]);
});

test("dos ocurrencias con el MISMO valor tambien cuentan como ambiguas", () => {
  // Documenta un limite real: si los valores son identicos, currentValue no desambigua nada.
  const xml = IFLW.replace(
    "<key>credentialName</key><value>BACKEND_WS</value>",
    "<key>address</key><value>https://backend.example.com/svc</value>"
  );
  const address = externalizableProperties(xml).find((c) => c.key === "address");
  assert.equal(address.ambiguo, true);

  assert.throws(
    () => externalizeProperty(xml, { key: "address", name: "Endpoint", currentValue: "https://backend.example.com/svc" }),
    /aparece 2 veces/
  );
});

// --- externalizeProperty ----------------------------------------------------

test("externalizar deja {{Nombre}} y devuelve el valor viejo, sin tocar el resto", () => {
  const { xml, oldValue } = externalizeProperty(IFLW, { key: "address", name: "Endpoint" });

  assert.equal(oldValue, "https://backend.example.com/svc");
  assert.equal(valorDe(xml, "address"), "{{Endpoint}}");
  assert.deepEqual(claves(xml), claves(IFLW), "no se perdio ni se agrego ninguna propiedad");
  assert.equal(valorDe(xml, "credentialName"), "BACKEND_WS", "las vecinas quedan intactas");
  assert.equal(valorDe(xml, "proxyType"), "", "el <value/> vacio sigue vacio");
});

test("una clave repetida FALLA en vez de reemplazar la primera", () => {
  // componentVersion aparece 2 veces aca (8 en un iFlow de 4 pasos). Este es EL test.
  assert.throws(
    () => externalizeProperty(IFLW, { key: "componentVersion", name: "Version" }),
    (err) => {
      assert.match(err.message, /aparece 2 veces/);
      assert.match(err.message, /"1\.1"/);
      assert.match(err.message, /"1\.5"/);
      assert.match(err.message, /currentValue/, "el error dice como desambiguar");
      return true;
    }
  );
});

test("currentValue elige la ocurrencia correcta", () => {
  const { xml, oldValue } = externalizeProperty(IFLW, {
    key: "componentVersion",
    name: "Version",
    currentValue: "1.5",
  });

  assert.equal(oldValue, "1.5");
  const vs = listProperties(xml).filter((p) => p.key === "componentVersion").map((p) => p.value);
  assert.deepEqual(vs, ["1.1", "{{Version}}"], "se toco la segunda, no la primera");
});

test("una clave inexistente falla con un mensaje, no con un match a medias", () => {
  assert.throws(
    () => externalizeProperty(IFLW, { key: "noExiste", name: "X" }),
    /No hay ninguna propiedad "noExiste" con valor/
  );
});

test("un currentValue que no matchea falla nombrando el valor buscado", () => {
  assert.throws(
    () => externalizeProperty(IFLW, { key: "address", name: "Endpoint", currentValue: "http://otra" }),
    /cuyo valor sea "http:\/\/otra"/
  );
});

test("una propiedad con <value/> vacio no es externalizable", () => {
  assert.throws(
    () => externalizeProperty(IFLW, { key: "proxyType", name: "Proxy" }),
    /No hay ninguna propiedad "proxyType" con valor/
  );
});

test("los metacaracteres de regex en la clave se escapan", () => {
  // "some.timeout" tiene un punto: sin escapar, el . matchearia cualquier caracter.
  const { xml } = externalizeProperty(IFLW, { key: "some.timeout", name: "Timeout" });
  assert.equal(valorDe(xml, "some.timeout"), "{{Timeout}}");

  // Y una clave con caracteres que romperian el regex da el error de negocio, no un SyntaxError.
  assert.throws(
    () => externalizeProperty(IFLW, { key: "some(timeout[", name: "X" }),
    /No hay ninguna propiedad/
  );
});

test("un nombre de parametro invalido se rechaza antes de tocar el XML", () => {
  for (const name of ["1arranca-con-numero", "con-guion", "con espacio", "con/barra", ""]) {
    assert.throws(
      () => externalizeProperty(IFLW, { key: "address", name }),
      /no sirve como nombre de parametro/,
      `deberia rechazar "${name}"`
    );
  }
  // Los validos no tiran.
  for (const name of ["Endpoint", "_priv", "grupo.Endpoint", "P1"]) {
    assert.doesNotThrow(() => externalizeProperty(IFLW, { key: "address", name }));
  }
});

test("un valor viejo con $& no se reinyecta al reemplazar", () => {
  // Si el reemplazo usara un string de reemplazo de String.replace, "$&" y "$1" en el valor
  // viejo se expandirian solos y el modelo saldria corrupto. (El replace de aca va por
  // funcion justamente por eso.)
  const raro = "raro-$&-$1-$`-$'";
  const xml = IFLW.replace("https://backend.example.com/svc", () => raro);
  assert.equal(valorDe(xml, "address"), raro, "el fixture quedo bien armado");

  const out = externalizeProperty(xml, { key: "address", name: "Endpoint" }).xml;
  assert.equal(valorDe(out, "address"), "{{Endpoint}}");
  assert.deepEqual(claves(out), claves(IFLW), "no se inyecto XML de mas");
});

test("externalizar dos veces seguidas es acumulativo", () => {
  const a = externalizeProperty(IFLW, { key: "address", name: "Endpoint" }).xml;
  const b = externalizeProperty(a, { key: "credentialName", name: "Credencial" }).xml;

  assert.equal(valorDe(b, "address"), "{{Endpoint}}");
  assert.equal(valorDe(b, "credentialName"), "{{Credencial}}");
  assert.deepEqual(externalizableProperties(b).map((c) => c.key), ["some.timeout"]);
});

// --- parameters.prop --------------------------------------------------------

test("parseProps lee pares, ignora comentarios y lineas en blanco", () => {
  const m = parseProps(`#Tue, 05 Aug 2026 12:00:00 GMT
! otro estilo de comentario

Endpoint=https\\://a.b/c

Credencial=BACKEND_WS
sin_separador
`);

  assert.deepEqual([...m], [["Endpoint", "https://a.b/c"], ["Credencial", "BACKEND_WS"]]);
});

test("parseProps acepta ':' como separador", () => {
  assert.deepEqual([...parseProps("Timeout : 60000")], [["Timeout", "60000"]]);
});

test("parseProps corta en el primer separador NO escapado", () => {
  // El caso real: una URL con puerto. El ':' del valor viene escapado, el '=' de la clave no.
  const m = parseProps("Endpoint=https\\://host\\:8443/path?a\\=1");
  assert.deepEqual([...m], [["Endpoint", "https://host:8443/path?a=1"]]);
});

test("parseProps desescapa un separador dentro de la clave", () => {
  assert.deepEqual([...parseProps("a\\=b=valor")], [["a=b", "valor"]]);
});

test("parseProps sin texto devuelve un Map vacio", () => {
  for (const v of [undefined, null, ""]) {
    assert.equal(parseProps(v).size, 0);
  }
});

test("writeProps arranca con el encabezado de fecha comentado", () => {
  const [primera] = writeProps(new Map([["A", "1"]])).split("\n");
  assert.match(primera, /^#\w{3}, \d{2} \w{3} \d{4}/, "mismo formato que escribe SAP");
});

test("round-trip de valores con ':' , '=' y '\\\\'", () => {
  const original = new Map([
    ["Endpoint", "https://host:8443/svc?a=1&b=2"],
    ["Ruta", "C:\\temp\\archivo.xml"],
    ["Vacio", ""],
    ["Query", "k=v:z"],
  ]);

  const vuelta = parseProps(writeProps(original));
  assert.deepEqual([...vuelta], [...original]);
});

test("writeProps conserva el orden de insercion del Map", () => {
  const m = new Map([["Z", "1"], ["A", "2"], ["M", "3"]]);
  const lineas = writeProps(m).trim().split("\n").slice(1);
  assert.deepEqual(lineas.map((l) => l.split("=")[0]), ["Z", "A", "M"]);
});

test("writeProps termina en salto de linea", () => {
  assert.ok(writeProps(new Map([["A", "1"]])).endsWith("\n"));
});
