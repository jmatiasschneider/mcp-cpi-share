/**
 * Unitarios de la eleccion del servlet del runtime: `/http/` o `/cxf/`.
 *
 * Lo que se rompio el 2026-08-27 no fue una regla de negocio sino UNA URL: `ZMOLDE_ARQ1_CLEARINGS`
 * estaba STARTED, `ServiceEndpoints` lo listaba con `Protocol: "SOAP"`, y la tool armo igual
 * `/http/<address>`. El Tomcat devolvio 404 y el iFlow ni se entero — no hubo MPL que mirar.
 *
 * Por eso se testea la URL exacta que sale, con un fetch falso que la registra, y no el formato
 * de la respuesta. Un 404 asi se diagnostica como "el iFlow no anda" durante un rato largo.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { RuntimeClient, prefixForProtocol } from "../src/core/runtime-client.js";
import { resolveEndpoint } from "../src/core/ops/runtime.js";
import * as invoke from "../src/tools/cpi-invoke.js";

const BASE = "https://tenant.it-cpi008-rt.cfapps.region.hana.ondemand.com";

/** RuntimeClient con el token y el fetch falseados; `llamadas` guarda cada URL pedida. */
function fakeRuntime({ status = 200, body = "<ok/>" } = {}) {
  const llamadas = [];
  const fetchImpl = async (url, init) => {
    llamadas.push({ url, method: init?.method ?? "GET" });
    if (url.includes("/oauth/token")) {
      return respuesta(200, JSON.stringify({ access_token: "tok", expires_in: 3600 }));
    }
    return respuesta(status, body, "application/xml");
  };
  const client = new RuntimeClient({
    runtime: {
      clientid: "c",
      clientsecret: "s",
      tokenurl: "https://tenant.authentication.region.hana.ondemand.com/oauth/token",
      url: BASE,
    },
    fetchImpl,
  });
  return { client, llamadas };
}

function respuesta(status, body, contentType = "application/json") {
  return {
    ok: status < 400,
    status,
    statusText: "OK",
    headers: new Headers({ "content-type": contentType }),
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

/** Cliente de administracion falso: solo la fila de ServiceEndpoints. */
function fakeAdmin(rows) {
  return {
    get: async (path) => {
      assert.equal(path, "ServiceEndpoints");
      return { rows };
    },
  };
}

const FILA_SOAP = {
  Name: "ZMOLDE_ARQ1_CLEARINGS",
  Id: "ZMOLDE_ARQ1_CLEARINGS$endpointAddress=Clearings",
  Protocol: "SOAP",
};
const FILA_REST = { Name: "test", Id: "test$endpointAddress=iflowtest", Protocol: "REST" };

// --- el mapeo protocolo -> servlet -------------------------------------------

test("SOAP va por cxf y REST por http", () => {
  assert.equal(prefixForProtocol("SOAP"), "cxf");
  assert.equal(prefixForProtocol("REST"), "http");
});

test("un protocolo desconocido o ausente cae en http, que es el caso mayoritario", () => {
  // Preferible a tirar error: antes del 2026-08-27 TODO iba por /http/ y eso funcionaba para
  // los senders HTTPS. Lo que no puede pasar es que un protocolo nuevo rompa lo que ya andaba.
  assert.equal(prefixForProtocol(null), "http");
  assert.equal(prefixForProtocol(undefined), "http");
  assert.equal(prefixForProtocol("IDOC"), "http");
});

test("el protocolo se compara sin importar mayusculas", () => {
  assert.equal(prefixForProtocol("soap"), "cxf");
});

// --- urlFor ------------------------------------------------------------------

test("urlFor arma el servlet segun el protocolo", () => {
  const { client } = fakeRuntime();
  assert.equal(client.urlFor("Clearings", "SOAP"), `${BASE}/cxf/Clearings`);
  assert.equal(client.urlFor("iflowtest", "REST"), `${BASE}/http/iflowtest`);
  assert.equal(client.urlFor("/iflowtest", "REST"), `${BASE}/http/iflowtest`);
});

test("un address que ya trae el prefijo manda sobre el protocolo", () => {
  // Es la forma en que se copia una URL de la UI. Quien la escribio ya sabe donde escucha:
  // volver a prefijar daria /http/cxf/Clearings, que es 404 garantizado.
  const { client } = fakeRuntime();
  assert.equal(client.urlFor("cxf/Clearings"), `${BASE}/cxf/Clearings`);
  assert.equal(client.urlFor("/cxf/Clearings", "REST"), `${BASE}/cxf/Clearings`);
  assert.equal(client.urlFor("http/iflowtest", "SOAP"), `${BASE}/http/iflowtest`);
});

test("un address que EMPIEZA con esas letras no se confunde con el prefijo", () => {
  const { client } = fakeRuntime();
  assert.equal(client.urlFor("cxfServicio", "SOAP"), `${BASE}/cxf/cxfServicio`);
  assert.equal(client.urlFor("httpbin", "REST"), `${BASE}/http/httpbin`);
});

// --- resolveEndpoint ---------------------------------------------------------

test("resolveEndpoint devuelve el Protocol junto al address", async () => {
  const e = await resolveEndpoint(fakeAdmin([FILA_SOAP]), "ZMOLDE_ARQ1_CLEARINGS");
  assert.equal(e.address, "Clearings");
  assert.equal(e.protocol, "SOAP");
});

test("el aviso de 'no expone endpoint' dice el protocolo de cada uno", async () => {
  // Sin el protocolo, la lista sugiere un address que el modelo va a invocar por el servlet
  // equivocado — que es exactamente como se llego al 404.
  await assert.rejects(() => resolveEndpoint(fakeAdmin([FILA_SOAP, FILA_REST]), "OTRO"), (err) => {
    assert.match(err.hint, /Clearings \(SOAP\)/);
    assert.match(err.hint, /iflowtest \(REST\)/);
    return true;
  });
});

// --- la tool entera ----------------------------------------------------------

async function invocar(rows, args, opts) {
  const { client: runtime, llamadas } = fakeRuntime(opts);
  const res = await invoke.handler(args, { client: fakeAdmin(rows), runtime, profile: "test" });
  const pedidas = llamadas.filter((l) => !l.url.includes("/oauth/token")).map((l) => l.url);
  return { texto: res.content[0].text, isError: res.isError, pedidas };
}

test("cpi_invoke manda un sender SOAP a /cxf/, no a /http/", async () => {
  const { isError, texto, pedidas } = await invocar([FILA_SOAP], {
    iflow: "ZMOLDE_ARQ1_CLEARINGS",
    method: "POST",
    body: "<soap:Envelope/>",
    contentType: "text/xml",
  });

  assert.notEqual(isError, true, texto);
  assert.deepEqual(pedidas, [`${BASE}/cxf/Clearings`]);
  assert.match(texto, /Protocol=SOAP/, "el protocolo usado tiene que quedar a la vista");
});

test("cpi_invoke sigue mandando un sender REST a /http/", async () => {
  const { pedidas } = await invocar([FILA_REST], { iflow: "test" });
  assert.deepEqual(pedidas, [`${BASE}/http/iflowtest`]);
});

test("ante un 404 lo primero que se nombra es el otro servlet", async () => {
  // El 404 del Tomcat no deja MPL: si el texto no nombra el servlet, el camino natural es
  // sospechar del iFlow y salir a mirar un log que no existe.
  const { texto } = await invocar([FILA_REST], { iflow: "test" }, { status: 404, body: "" });

  assert.match(texto, /servlet equivocado/);
  assert.match(texto, /\/cxf\//, "tiene que nombrar el prefijo que no se uso");
  assert.match(texto, /Protocol/, "y de donde sacarlo");
});

test("con address a secas se asume /http/, y con prefijo se respeta", async () => {
  assert.deepEqual((await invocar([], { address: "Clearings" })).pedidas, [`${BASE}/http/Clearings`]);
  assert.deepEqual((await invocar([], { address: "cxf/Clearings" })).pedidas, [
    `${BASE}/cxf/Clearings`,
  ]);
});
