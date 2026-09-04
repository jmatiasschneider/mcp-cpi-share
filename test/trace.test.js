/**
 * Unitarios de la cadena de trazas (`traceRun`).
 *
 * Se testea contra un cliente falso porque lo que se rompe aca no es la logica de negocio sino
 * las DOS URLs que hay que armar bien, y las dos fallan de formas que no se notan leyendo el
 * codigo: la key del RunStep es compuesta y sale del `__metadata.uri` (armarla a mano da 404), y
 * `TraceMessages` es `Edm.Int64`, asi que sin el sufijo `L` el literal es invalido.
 *
 * El cliente falso registra cada path pedido: asi el test afirma sobre la URL exacta que se
 * mando, que es el contrato real contra el tenant.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { traceRun, runStepKey } from "../src/core/ops/monitor.js";
import * as trace from "../src/tools/cpi-trace.js";

const STEP_URI =
  "https://x.hana.ondemand.com/api/v1/MessageProcessingLogRunSteps(MessageGuid='G1'," +
  "RunId='R1',ChildCount=0,StepId='CallActivity_5')";
const STEP_KEY = STEP_URI.slice(STEP_URI.indexOf("MessageProcessingLogRunSteps"));

/**
 * @param {object} o
 * @param {string} o.logLevel  nivel del run
 * @param {object[]} o.traces  filas de TraceMessages
 * @param {Buffer} o.payload   lo que devuelve /$value
 */
function fakeClient({ logLevel = "TRACE", traces, payload = Buffer.from("<a>hola</a>") } = {}) {
  const pedidos = [];

  const rutas = {
    "MessageProcessingLogs('G1')": [{ MessageGuid: "G1", Status: "COMPLETED", __metadata: {} }],
    "MessageProcessingLogs('G1')/Runs": [
      { Id: "R1", LogLevel: logLevel, OverallState: "COMPLETED" },
    ],
    "MessageProcessingLogRuns('R1')/RunSteps": [
      {
        ModelStepId: "Mapping_1",
        StepId: "CallActivity_5",
        Status: "COMPLETED",
        __metadata: { uri: STEP_URI },
      },
    ],
    [`${STEP_KEY}/TraceMessages`]: traces ?? [
      { TraceId: 104, MimeType: "application/octet-stream", PayloadSize: 11 },
    ],
  };

  return {
    pedidos,
    get(path, opts) {
      pedidos.push(path);
      if (opts?.raw) return Promise.resolve(payload);
      const rows = rutas[path];
      if (!rows) return Promise.reject(new Error(`404 en ${path}`));
      return Promise.resolve({ rows });
    },
  };
}

// --- la key del RunStep -----------------------------------------------------

test("la key del RunStep se recorta del uri, no se arma a mano", () => {
  assert.equal(runStepKey(STEP_URI), STEP_KEY);
  assert.match(runStepKey(STEP_URI), /^MessageProcessingLogRunSteps\(/);
});

test("un uri inservible devuelve null en vez de una URL rota", () => {
  for (const basura of [undefined, null, "", 42, "https://x/api/v1/OtraCosa(1)"]) {
    assert.equal(runStepKey(basura), null);
  }
});

test("traceRun navega con la key que vino en __metadata", async () => {
  const c = fakeClient();
  await traceRun(c, "G1");

  assert.ok(
    c.pedidos.includes(`${STEP_KEY}/TraceMessages`),
    `no uso la key del uri. Pidio: ${c.pedidos.join(" | ")}`
  );
});

test("un RunStep sin __metadata.uri se marca y no tumba el resto", async () => {
  const c = fakeClient();
  c.get = ((orig) => (path, opts) => {
    if (path === "MessageProcessingLogRuns('R1')/RunSteps") {
      return Promise.resolve({ rows: [{ ModelStepId: "Mapping_1" }] });
    }
    return orig(path, opts);
  })(c.get.bind(c));

  const d = await traceRun(c, "G1");
  assert.equal(d.runs[0].steps.length, 1);
  assert.match(d.runs[0].steps[0].note, /__metadata\.uri/);
});

// --- el literal Edm.Int64 ---------------------------------------------------

test("el payload se pide con el sufijo L, que es lo que exige Edm.Int64", async () => {
  const c = fakeClient();
  await traceRun(c, "G1");

  assert.ok(
    c.pedidos.includes("TraceMessages(104L)/$value"),
    `falta el sufijo L. Pidio: ${c.pedidos.join(" | ")}`
  );
  assert.ok(!c.pedidos.includes("TraceMessages(104)/$value"));
});

test("un TraceId que no es numerico no se manda: no se puede armar el literal", async () => {
  const c = fakeClient({ traces: [{ TraceId: "abc", PayloadSize: 10 }] });
  const d = await traceRun(c, "G1");

  assert.match(d.runs[0].steps[0].traces[0].note, /TraceId inesperado/);
  assert.ok(!c.pedidos.some((p) => p.includes("$value")), "no tendria que haber descargado nada");
});

// --- el contenido -----------------------------------------------------------

test("el payload llega como texto", async () => {
  const d = await traceRun(fakeClient(), "G1");
  const t = d.runs[0].steps[0].traces[0];

  assert.equal(t.text, "<a>hola</a>");
  assert.equal(t.truncated, false);
  assert.equal(t.size, 11);
});

test("maxBytes recorta y lo dice", async () => {
  const d = await traceRun(fakeClient(), "G1", { maxBytes: 4 });
  const t = d.runs[0].steps[0].traces[0];

  assert.equal(t.text, "<a>h");
  assert.equal(t.truncated, true);
});

test("el binario no se vuelca aunque el MimeType diga octet-stream igual que el XML", async () => {
  // El MimeType es el MISMO en los dos casos, asi que la decision sale del contenido.
  const c = fakeClient({ payload: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]) });
  const d = await traceRun(c, "G1");
  const t = d.runs[0].steps[0].traces[0];

  assert.equal(t.binary, true);
  assert.equal(t.text, "");
  assert.match(t.note, /binario/);
});

test("un paso de 0 bytes se explica y no se descarga", async () => {
  // Es normal segun el punto del flujo. Sin la nota se lee como un fallo.
  const c = fakeClient({ traces: [{ TraceId: 104, PayloadSize: 0 }] });
  const d = await traceRun(c, "G1");

  assert.match(d.runs[0].steps[0].traces[0].note, /0 bytes/);
  assert.ok(!c.pedidos.some((p) => p.includes("$value")));
});

test("un payload gigante se reporta pero no se baja", async () => {
  const c = fakeClient({ traces: [{ TraceId: 104, PayloadSize: 50_000_000 }] });
  const d = await traceRun(c, "G1");

  assert.match(d.runs[0].steps[0].traces[0].note, /no se descarga/);
  assert.ok(!c.pedidos.some((p) => p.includes("$value")));
});

// --- el nivel de log --------------------------------------------------------

test("tracedRuns distingue 'no hubo payload' de 'no hubo Trace'", async () => {
  assert.equal((await traceRun(fakeClient(), "G1")).tracedRuns, 1);
  assert.equal((await traceRun(fakeClient({ logLevel: "INFO" }), "G1")).tracedRuns, 0);
});

test("un MPL sin filas devuelve null, no una estructura vacia", async () => {
  // El 404 duro no llega hasta aca: lo tira el cliente y lo renderiza fail() con su hint.
  // Lo que si tiene que manejar traceRun es el 200 con cero filas.
  const vacio = { get: () => Promise.resolve({ rows: [] }) };
  assert.equal(await traceRun(vacio, "NO_EXISTE"), null);
});

// --- las dos causas de "cero payloads" --------------------------------------

/** Texto que devuelve el handler de la tool con un cliente falso. */
async function texto(client, args = {}) {
  const res = await trace.handler({ messageGuid: "G1", ...args }, { client, label: "tenant" });
  assert.ok(!res.isError, `no tendria que haber fallado:\n${res.content[0].text}`);
  return res.content[0].text;
}

test("sin Trace, la tool dice como prenderlo", async () => {
  const t = await texto(fakeClient({ logLevel: "INFO" }));

  assert.match(t, /Ningun run corrio con LogLevel=TRACE/);
  assert.match(t, /Manage Integration Content/, "dice donde se prende, que es a mano en la UI");
});

test("con Trace pero sin trazas, culpa a la purga y NO manda a revisar el log level", async () => {
  // El caso verificado contra el tenant el 2026-08-11: run TRACE de 12 h, TraceMessages 200 con
  // lista vacia en los 10 pasos. Decirle que prenda Trace seria mandarlo a arreglar algo que ya
  // estaba bien.
  const t = await texto(fakeClient({ traces: [] }));

  assert.match(t, /no quedo ninguna traza/);
  assert.ok(!t.includes("Ningun run corrio"), "el run SI corrio en Trace");
});

test("con payload de verdad no aparece ninguna de las dos advertencias", async () => {
  const t = await texto(fakeClient());

  assert.match(t, /<a>hola<\/a>/);
  assert.ok(!t.includes("⚠"));
});

// --- el filtro por paso -----------------------------------------------------

test("el filtro de paso matchea por ModelStepId o StepId, sin distinguir mayusculas", async () => {
  const conFiltro = async (step) => (await traceRun(fakeClient(), "G1", { step })).runs[0].steps;

  assert.equal((await conFiltro("mapping")).length, 1, "matchea el ModelStepId");
  assert.equal((await conFiltro("callactivity")).length, 1, "matchea el StepId");
  assert.equal((await conFiltro("Router")).length, 0);
});
