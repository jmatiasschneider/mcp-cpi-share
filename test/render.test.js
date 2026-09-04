/**
 * Unitarios del renderizado de errores de validacion.
 *
 * Van contra los handlers REALES con un ctx vacio: la validacion corre antes de tocar el
 * cliente, asi que el camino que se ejercita es el mismo que ve el modelo en produccion.
 * Testear un ZodError armado a mano probaria el formateador contra una suposicion.
 */

import test from "node:test";
import assert from "node:assert/strict";

import * as messageDetail from "../src/tools/cpi-message-detail.js";
import * as iflowRead from "../src/tools/cpi-iflow-read.js";
import * as iflowList from "../src/tools/cpi-iflow-list.js";
import * as iflowUpdate from "../src/tools/cpi-iflow-update.js";
import * as iflowConfigure from "../src/tools/cpi-iflow-configure.js";
import * as iflowDelete from "../src/tools/cpi-iflow-delete.js";
import * as deploy from "../src/tools/cpi-deploy.js";
import * as iflowMapping from "../src/tools/cpi-iflow-mapping.js";
import * as trace from "../src/tools/cpi-trace.js";
import * as packageCreate from "../src/tools/cpi-package-create.js";
import { fail, table } from "../src/tools/_render.js";

/** Invoca el handler con un ctx vacio y devuelve el texto del error. */
async function textoDeError(mod, args) {
  const res = await mod.handler(args, {});
  assert.equal(res.isError, true, "tendria que haber fallado la validacion");
  return res.content[0].text;
}

test("un parametro mal nombrado dice que falta, que sobra, y sugiere el renombre", async () => {
  // El incidente real: cpi_message_detail(id=…) cuando el parametro es messageGuid.
  const t = await textoDeError(messageDetail, { id: "abc-123" });

  assert.match(t, /falta el parametro requerido "messageGuid"/);
  assert.match(t, /el parametro "id" no existe en esta tool/);
  assert.match(t, /Quizas "id" queria ser "messageGuid"/);
  assert.match(t, /\(tool: cpi_message_detail\)/, "sigue diciendo de que tool salio");
});

test("el volcado JSON de Zod ya no aparece", async () => {
  const t = await textoDeError(messageDetail, { id: "abc-123" });

  for (const ruido of ['"code"', '"path"', '"inclusive"', "invalid_type", "unrecognized_keys"]) {
    assert.ok(!t.includes(ruido), `el texto no deberia contener ${ruido}:\n${t}`);
  }
});

test("un numero fuera de rango dice el limite", async () => {
  // El otro incidente real: maxBytes por debajo del minimo.
  assert.match(await textoDeError(iflowRead, { id: "x", maxBytes: 50 }), /"maxBytes": tiene que ser >= 100/);
  assert.match(await textoDeError(iflowRead, { id: "x", maxBytes: 999999 }), /"maxBytes": tiene que ser <= 200000/);
});

test("un string vacio se distingue de un string faltante", async () => {
  assert.match(await textoDeError(iflowRead, { id: "" }), /"id": no puede estar vacio/);
  assert.match(await textoDeError(iflowRead, {}), /falta el parametro requerido "id"/);
});

test("un tipo equivocado dice que se esperaba y que llego", async () => {
  const t = await textoDeError(deploy, { id: "x", wait: "si" });
  assert.match(t, /"wait": se esperaba boolean y llego string/);
});

test("cpi_iflow_mapping valida antes de bajar dos bundles", async () => {
  // Sin iflowId el handler tiene que cortar en el parse: si llegara al ctx vacio,
  // el error seria un TypeError sobre ctx.client en vez de decir que falta el parametro.
  const t = await textoDeError(iflowMapping, { mappingId: "MM_X" });

  assert.match(t, /falta el parametro requerido "iflowId"/);
  assert.match(t, /\(tool: cpi_iflow_mapping\)/);
});

test("un enum invalido lista las opciones validas", async () => {
  const t = await textoDeError(iflowList, { packageId: "p", kind: "mapas" });

  assert.match(t, /"kind": tiene que ser uno de /);
  assert.match(t, /llego "mapas"/);
  assert.match(t, /iflow/, "las opciones reales aparecen en el mensaje");
});

test("un literal obligatorio dice el valor exacto que espera", async () => {
  // confirm:true es la traba de las tools destructivas: el mensaje tiene que ser inequivoco.
  const t = await textoDeError(iflowDelete, { id: "x" });
  assert.match(t, /"confirm": tiene que ser exactamente true/);
});

test("un error adentro de un array reporta la ruta completa", async () => {
  // Desde que existe fromFile, un archivo sin contenido no es un "falta content" sino el XOR:
  // lo que este test cuida es que la ruta del array ("files.0") siga llegando al mensaje.
  const t = await textoDeError(iflowUpdate, { id: "x", files: [{ name: "a.groovy" }] });
  assert.match(t, /"files\.0": Cada archivo lleva 'content' O 'fromFile', exactamente uno/);
});

test("un valor que no encaja en la union lista los tipos aceptados", async () => {
  const t = await textoDeError(iflowConfigure, { id: "x", parameters: { Endpoint: { a: 1 } } });

  assert.match(t, /"parameters\.Endpoint": tiene que ser /);
  for (const tipo of ["string", "number", "boolean"]) assert.match(t, new RegExp(tipo));
});

test("varios problemas salen como varias lineas", async () => {
  const t = await textoDeError(iflowRead, { id: "", maxBytes: 5 });
  const items = t.split("\n").filter((l) => l.trim().startsWith("- "));

  assert.equal(items.length, 2);
  assert.match(t, /^Argumentos invalidos:/);
});

test("con dos parametros de sobra NO se inventa una sugerencia de renombre", async () => {
  const t = await textoDeError(messageDetail, { id: "a", guid: "b" });

  assert.match(t, /el parametro "id" no existe/);
  assert.match(t, /el parametro "guid" no existe/);
  assert.ok(!t.includes("Quizas"), "adivinar con dos candidatos seria peor que no decir nada");
});

test("cpi_trace valida antes de recorrer runs y steps", async () => {
  // Sin messageGuid el handler tiene que cortar en el parse: si llegara al ctx vacio, el error
  // seria un TypeError sobre ctx.client despues de haber empezado a navegar.
  const t = await textoDeError(trace, { guid: "abc-123" });

  assert.match(t, /falta el parametro requerido "messageGuid"/);
  assert.match(t, /Quizas "guid" queria ser "messageGuid"/);
  assert.match(t, /\(tool: cpi_trace\)/);
});

test("cpi_package_create rechaza el guion bajo, que en un package el tenant no acepta", async () => {
  // Verificado el 2026-08-11: `ZZ_PKG_PROBE` da 400 aunque `zz_clone_probe` sea un Id de
  // artefacto valido. Atajarlo aca ahorra el viaje al tenant para que lo rebote.
  const t = await textoDeError(packageCreate, { id: "ZZ_PKG_PROBE" });

  assert.match(t, /"id": .*solo admite letras y numeros, sin guion bajo/);
  assert.match(t, /\(tool: cpi_package_create\)/);
});

// --- el resto de fail() no cambia -------------------------------------------

test("un error normal sigue mostrando message, hint y url", () => {
  const err = Object.assign(new Error("HTTP 500: Id duplicado"), {
    hint: "Elegi otro targetId.",
    url: "https://tenant/api/v1/IntegrationDesigntimeArtifacts",
  });

  const t = fail(err, { tool: "cpi_iflow_clone" }).content[0].text;

  assert.match(t, /^HTTP 500: Id duplicado/);
  assert.match(t, /Sugerencia: Elegi otro targetId\./);
  assert.match(t, /URL: https:\/\/tenant/);
  assert.match(t, /\(tool: cpi_iflow_clone\)/);
});

test("fail sin tool y con algo que no es Error no rompe", () => {
  assert.equal(fail("se rompio todo").content[0].text, "se rompio todo");
  assert.equal(fail(null).content[0].text, "null");
});

// --- table(): un valor recortado no puede parecer completo --------------------
//
// El incidente real: cpi_iflow_read(includeContent:true) listo la ruta
// "src/main/resources/mapping/MM_MT_Venta_JS_to_MT_PedidoVentas" — exactamente 60 caracteres,
// sin marca de recorte —, y pasarsela de vuelta en `file` dio "no contiene". La ruta real
// terminaba en ".mmap".

test("table marca con … lo que recorta, para que no se copie como si fuera completo", () => {
  const largo = "x".repeat(80);
  const t = table([{ col: largo }], ["col"]);

  assert.ok(t.includes("…"), `tendria que marcar el recorte:\n${t}`);
  assert.ok(!t.includes(largo), "no deberia entrar entero");
  const fila = t.split("\n")[2];
  assert.equal(fila.length, 60, "el recorte con marca sigue respetando el ancho maximo");
});

test("table no recorta las columnas declaradas sinRecortar", () => {
  const ruta = `src/main/resources/mapping/${"M".repeat(60)}.mmap`;
  const t = table([{ archivo: ruta, bytes: 10 }], ["archivo", "bytes"], { sinRecortar: ["archivo"] });

  assert.ok(t.includes(ruta), `la ruta tiene que salir entera:\n${t}`);
  assert.ok(!t.includes("…"), "no hay nada que marcar si no se recorto");
});

test("table sigue alineando cuando nada se recorta", () => {
  const t = table([{ a: "uno", b: "1" }, { a: "dos mil", b: "2" }], ["a", "b"]);
  const [head, sep, f1, f2] = t.split("\n");

  assert.equal(head, "a        b");
  assert.equal(sep, "-------  -");
  assert.equal(f1, "uno      1");
  assert.equal(f2, "dos mil  2");
});
