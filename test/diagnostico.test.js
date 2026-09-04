/**
 * Unitarios de los dos formateadores de diagnostico, que se arreglaron el 2026-08-10 despues
 * de provocar un deploy fallido de verdad en el tenant.
 *
 * Los dos fallaban en la direccion peor: uno devolvia null siempre —o sea que un deploy en ERROR
 * no decia por que—, y el otro volcaba ~100 frames de stack de Java por una sola excepcion.
 * Ninguno rompia nada; los dos dejaban al modelo sin lo que necesitaba.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { parseErrorInformation } from "../src/core/ops/runtime.js";
import { resumirValidacion } from "../src/tools/cpi-iflow-validate.js";
import * as deploy from "../src/tools/cpi-deploy.js";

// --- ErrorInformation -------------------------------------------------------

// Cuerpo real devuelto por el tenant ante un deploy fallido (iFlow con el XML roto).
const ERROR_REAL = JSON.stringify({
  message: {
    subsystemName: "CONTENT",
    subsytemPartName: "CONTENT_DEPLOY",
    messageId: "GenerationFailed",
    messageText: "",
  },
  parameter: [
    "The generation and build of the artifact were unsuccessful. Please address the issues outlined below and redeploy the artifact.",
  ],
});

test("aplana el cuerpo real de ErrorInformation", () => {
  const r = parseErrorInformation(ERROR_REAL);

  assert.equal(r.motivo, "GenerationFailed");
  assert.equal(r.subsistema, "CONTENT / CONTENT_DEPLOY");
  assert.match(r.detalle, /generation and build of the artifact were unsuccessful/);
});

test("el texto util sale de 'parameter', que es donde SAP lo pone", () => {
  // messageText viene VACIO y el texto va en parameter. Quedarse solo con messageText fue lo
  // que hizo parecer que la entidad no informaba nada.
  assert.ok(!JSON.parse(ERROR_REAL).message.messageText);
  assert.ok(parseErrorInformation(ERROR_REAL).detalle.length > 20);
});

test("no deja claves vacias, para que kv() no imprima ruido", () => {
  const r = parseErrorInformation(JSON.stringify({ message: { messageId: "X" }, parameter: [] }));
  assert.deepEqual(Object.keys(r), ["motivo"]);
});

test("si algun dia deja de ser JSON, el texto no se pierde", () => {
  assert.deepEqual(parseErrorInformation("explotó todo"), { detalle: "explotó todo" });
});

// --- el volcado del Validate ------------------------------------------------

const marco = (clase, metodo) => ({
  declaringClass: clase,
  methodName: metodo,
  fileName: `${clase.split(".").pop()}.java`,
  lineNumber: 42,
});

const VALIDACION_FALLIDA =
  "Check execution result: Failed\n" +
  JSON.stringify([
    {
      exception: {
        stackTrace: [
          marco("com.sap.it.gnb.ifl.common.validation.api.ComponentCheckManager", "initiateChecks"),
          marco("com.sap.ifl.gnb.validation.blueprint.IFlowValidator", "validate"),
          ...Array.from({ length: 90 }, (_, i) => marco("org.apache.catalina.core.Valve" + i, "invoke")),
        ],
        suppressedExceptions: [],
      },
    },
  ]);

test("el encabezado de texto sobrevive al resumen", () => {
  assert.match(resumirValidacion(VALIDACION_FALLIDA), /^Check execution result: Failed/);
});

test("se queda con los frames de SAP y descarta el transporte", () => {
  const r = resumirValidacion(VALIDACION_FALLIDA);

  assert.match(r, /ComponentCheckManager\.initiateChecks/);
  assert.match(r, /IFlowValidator\.validate/);
  assert.ok(!r.includes("org.apache.catalina"), "Tomcat no explica nada del iFlow");
});

test("dice cuantos frames omitio en vez de mentir por omision", () => {
  assert.match(resumirValidacion(VALIDACION_FALLIDA), /\(\+90 frames omitidos de 92\)/);
});

test("el resultado entra en un orden de magnitud menos de texto", () => {
  const r = resumirValidacion(VALIDACION_FALLIDA);
  assert.ok(r.length < VALIDACION_FALLIDA.length / 10, `quedo en ${r.length} de ${VALIDACION_FALLIDA.length}`);
});

test("con pocos frames no inventa una nota de omitidos", () => {
  const corto =
    "x\n" + JSON.stringify([{ exception: { stackTrace: [marco("com.sap.A", "b")], suppressedExceptions: [] } }]);
  const r = resumirValidacion(corto);

  assert.match(r, /com\.sap\.A\.b/);
  assert.ok(!r.includes("omitidos"));
});

test("una validacion que pasa no se toca", () => {
  // El caso normal no trae JSON: tiene que salir identico.
  const ok = "Check execution result: Passed";
  assert.equal(resumirValidacion(ok), ok);
});

test("un cuerpo que no parsea se devuelve entero, no mutilado", () => {
  const roto = "Failed\n[{ esto no es JSON";
  assert.equal(resumirValidacion(roto), roto);
});

test("un volcado gigantesco se recorta y avisa", () => {
  const enorme =
    "Failed\n" + JSON.stringify([{ mensaje: "x".repeat(9000), suppressedExceptions: [] }]);
  const r = resumirValidacion(enorme);

  assert.ok(r.length < 4200, `quedo en ${r.length}`);
  assert.match(r, /recortado: \d+ caracteres en total/);
});

// --- cpi_deploy: un build fallido no puede terminar en "quedo corriendo" ------
//
// El bug (detectado en la revision del 2026-08-25): tras un Build & deploy FAIL, la tool igual
// consultaba IntegrationRuntimeArtifacts. En un REDEPLOY, ahi sigue la version anterior en
// STARTED, y la respuesta cerraba con "quedo corriendo" — un falso exito sobre un deploy fallido.

/**
 * Cliente falso del ciclo de deploy. Registra cada path pedido, que es como se afirma
 * que el camino fallido NO toca el runtime.
 */
function fakeDeployClient({ taskStatus, runtime = [] }) {
  const pedidos = [];
  return {
    pedidos,
    // callFunction dispara el FunctionImport por request(); devuelve el TaskId como texto pelado.
    request(method, path) {
      pedidos.push(`${method} ${path}`);
      return Promise.resolve(Buffer.from("task123"));
    },
    get(path) {
      pedidos.push(path);
      if (path.startsWith("BuildAndDeployStatus")) {
        return Promise.resolve({ rows: [{ TaskId: "task123", Status: taskStatus }] });
      }
      if (path.startsWith("IntegrationRuntimeArtifacts")) {
        return Promise.resolve({ rows: runtime });
      }
      return Promise.reject(new Error(`404 en ${path}`));
    },
  };
}

test("un build FAIL corta antes del runtime, aunque haya una version anterior STARTED", async () => {
  // El escenario traicionero: redeploy fallido con la version vieja todavia corriendo.
  const c = fakeDeployClient({
    taskStatus: "FAIL",
    runtime: [{ Id: "zz", Status: "STARTED", Type: "INTEGRATION_FLOW" }],
  });

  const res = await deploy.handler({ id: "zz" }, { client: c });
  const texto = res.content[0].text;

  assert.match(texto, /Build & deploy: FAIL/);
  assert.match(texto, /NO llego al runtime/);
  assert.match(texto, /version ANTERIOR/);
  assert.ok(!texto.includes("quedo corriendo"), "un deploy fallido no puede reportarse como exito");
  assert.ok(
    !c.pedidos.some((p) => p.includes("IntegrationRuntimeArtifacts")),
    "con el build fallido no hay nada que buscar en el runtime"
  );
});

test("un build SUCCESS sigue llegando al runtime y reportando STARTED", async () => {
  const c = fakeDeployClient({
    taskStatus: "SUCCESS",
    runtime: [{ Id: "zz", Status: "STARTED", Type: "INTEGRATION_FLOW" }],
  });

  const res = await deploy.handler({ id: "zz" }, { client: c });
  const texto = res.content[0].text;

  assert.match(texto, /Build & deploy: SUCCESS/);
  assert.match(texto, /quedo corriendo/);
  assert.ok(c.pedidos.some((p) => p.includes("IntegrationRuntimeArtifacts")));
});
