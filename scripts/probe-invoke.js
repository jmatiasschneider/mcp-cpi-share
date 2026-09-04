#!/usr/bin/env node
/**
 * ⚠️ EJECUTA UN IFLOW EN EL RUNTIME. Invoca el endpoint HTTP de un iFlow deployado usando la
 * service key del plan `integration-flow` (bloque `runtime` del profile).
 *
 * Es el prototipo de la futura tool `cpi_invoke`: sirve para averiguar la forma real de la
 * llamada (status, content-type, como vuelve el error del iFlow) antes de fijarla en una tool.
 *
 * El address del endpoint sale de cpi_deployed(withEndpoints:true) — viene como
 * `<id>$endpointAddress=<address>` — y la URL final es <url del bloque runtime>/http/<address>.
 *
 * ⚠️ `/http/` vale para un sender HTTPS/REST. Un sender **SOAP** lo sirve el otro servlet y hay
 * que escribir el address como `cxf/<address>` (verificado el 2026-08-27; el `Protocol` de
 * ServiceEndpoints es el que lo dice). Por /http/ contesta 404 el Tomcat, sin dejar MPL.
 *
 * Nunca imprime el clientsecret ni el token.
 *
 * Uso:  node scripts/probe-invoke.js <address> [metodo] [body]
 *       node scripts/probe-invoke.js iflowtest
 *       node scripts/probe-invoke.js cxf/Clearings POST '<soap:Envelope/>'
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadRuntime() {
  const systems = JSON.parse(readFileSync(join(ROOT, "systems.json"), "utf8"));
  const names = Object.keys(systems).filter((k) => !k.startsWith("_"));
  const name = process.env.CPI_PROFILE || systems._default || names[0];
  const entry = systems[name];
  if (!entry) throw new Error(`El profile "${name}" no esta en systems.json`);
  if (!entry.runtime) {
    throw new Error(
      `El profile "${name}" no tiene bloque "runtime". Hace falta la service key del plan ` +
        `'integration-flow' para invocar iFlows.`
    );
  }
  if (!entry.runtime.url) {
    throw new Error(`El bloque "runtime" de "${name}" no trae "url": no se puede armar el endpoint.`);
  }
  return { name, runtime: entry.runtime };
}

async function fetchToken({ clientid, clientsecret, tokenurl }) {
  const basic = Buffer.from(`${clientid}:${clientsecret}`).toString("base64");
  const res = await fetch(tokenurl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`Token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).access_token;
}

async function main() {
  const address = process.argv[2];
  if (!address) throw new Error("Falta el address del endpoint. Ej: node scripts/probe-invoke.js iflowtest");

  const method = (process.argv[3] || "POST").toUpperCase();
  const body = process.argv[4];

  const { name, runtime } = loadRuntime();
  // Sin prefijo se asume /http/; con `cxf/…` o `http/…` escrito a mano se respeta el que vino.
  const path = address.replace(/^\/+/, "");
  const url = `${runtime.url.replace(/\/+$/, "")}/${/^(http|cxf)\//i.test(path) ? "" : "http/"}${path}`;

  console.log(`profile: ${name}`);
  console.log(`${method} ${url}`);
  if (body) console.log(`body:    ${body.slice(0, 200)}`);

  const token = await fetchToken(runtime);

  const headers = { Authorization: `Bearer ${token}` };
  if (body) headers["Content-Type"] = "application/json";

  const t0 = Date.now();
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  const ms = Date.now() - t0;

  console.log(`\nHTTP ${res.status} ${res.statusText}  (${ms} ms)`);
  console.log(`content-type: ${res.headers.get("content-type") || "(sin content-type)"}`);

  // El MPL id viaja en un header cuando el iFlow llega a ejecutarse: es el puente al monitor.
  for (const h of ["sap-messageprocessinglogid", "sap-messageid", "x-correlationid"]) {
    const v = res.headers.get(h);
    if (v) console.log(`${h}: ${v}`);
  }

  console.log(`\nrespuesta (${text.length} bytes):`);
  console.log(text.length ? text.slice(0, 2000) : "(vacia)");

  if (res.status === 404) {
    console.log(
      `\nPISTA: un 404 del Tomcat con el iFlow STARTED suele ser el servlet equivocado. Si el ` +
        `sender es SOAP, reintentar con "cxf/${path.replace(/^(http|cxf)\//i, "")}".`
    );
  }

  if (res.status === 401 || res.status === 403) {
    console.log(
      `\nPISTA: ${res.status} es autenticacion/autorizacion, no un fallo del iFlow. Revisar que el ` +
        `sender adapter acepte el rol que trae esta key (ESBMessaging.send o el rol propio que se le haya puesto).`
    );
  }
}

main().catch((err) => {
  console.error(`\nFALLO: ${err.message}`);
  process.exit(1);
});
