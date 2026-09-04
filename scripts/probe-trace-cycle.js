#!/usr/bin/env node
/**
 * ⚠️ EJECUTA UN IFLOW. Ciclo completo de diagnostico:
 * invocar -> esperar el MPL -> Runs -> RunSteps -> payload de cada paso.
 *
 * Requiere que el iFlow este en **LogLevel=Trace**, y eso se prende A MANO en la UI
 * (Monitor -> Manage Integration Content -> el iFlow -> Log Level): no hay entity set en la
 * API OData para configurarlo. El Trace caduca solo al cabo de ~1 h y no es retroactivo.
 *
 * Usa los DOS planos: el bloque `runtime` del profile para invocar, el `oauth` para leer.
 *
 * Uso:  node scripts/probe-trace-cycle.js [address] [nombreIflow]
 *       node scripts/probe-trace-cycle.js iflowtest test
 */
import { loadConfig } from "../src/config/local.js";

const ADDRESS = process.argv[2] || "iflowtest";
const IFLOW = process.argv[3] || "test";

// Mismo profile que el server (CPI_PROFILE / CPI_SYSTEMS). Este probe necesita los dos planos.
const perfil = loadConfig();
if (!perfil.runtime || !perfil.oauth) {
  console.error(`El profile "${perfil.profile}" necesita los bloques "oauth" y "runtime".`);
  process.exit(1);
}

const token = async ({ clientid, clientsecret, tokenurl }) => {
  const basic = Buffer.from(`${clientid}:${clientsecret}`).toString("base64");
  const res = await fetch(tokenurl, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  return (await res.json()).access_token;
};

// --- 1. invocar -------------------------------------------------------------
const rtTok = await token(perfil.runtime);
const url = `${perfil.runtime.url.replace(/\/+$/, "")}/http/${ADDRESS}`;
const t0 = Date.now();
const inv = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${rtTok}` } });
const body = await inv.text();
console.log(`1) GET ${url}`);
console.log(`   HTTP ${inv.status}  ${Date.now() - t0} ms  ${body.length} bytes\n`);

// --- 2. buscar el MPL -------------------------------------------------------
const apiTok = await token(perfil.oauth);
const H = { Authorization: `Bearer ${apiTok}`, Accept: "application/json" };
const get = async (ruta) => {
  const res = await fetch(`${perfil.oauth.url}/api/v1/${ruta}`, { headers: H });
  const text = await res.text();
  if (!res.ok) return { status: res.status, rows: [], text };
  if (!text) return { status: res.status, rows: [], text };
  try {
    const j = JSON.parse(text);
    return { status: res.status, rows: j?.d?.results ?? (j?.d ? [j.d] : []), text };
  } catch {
    return { status: res.status, rows: [], text };
  }
};

const filtro = `$filter=${encodeURIComponent(`IntegrationFlowName eq '${IFLOW}'`)}`;
let mpl = null;
for (let i = 0; i < 6 && !mpl; i++) {
  const r = await get(`MessageProcessingLogs?$top=1&$orderby=LogEnd desc&${filtro}`);
  const cand = r.rows[0];
  // El MPL nuevo es el que empezo despues de que arrancamos la invocacion
  if (cand && new Date(cand.LogEnd.replace(/\/Date\((\d+)\)\//, (_, ms) => new Date(+ms).toISOString())) >= new Date(t0 - 5000)) {
    mpl = cand;
  } else if (cand && i === 5) {
    mpl = cand; // el ultimo intento se conforma con el mas reciente
  } else {
    await new Promise((r) => setTimeout(r, 1500));
  }
}

if (!mpl) {
  console.log("2) No aparecio ningun MPL. Puede tardar unos segundos mas.");
  process.exit(1);
}
console.log(`2) MPL ${mpl.MessageGuid}   Status=${mpl.Status}   LogLevel=${mpl.LogLevel}`);
if (mpl.LogLevel !== "TRACE") {
  console.log(`   ⚠ El run NO fue en TRACE: no va a haber payload. Prender Trace en la UI y repetir.`);
}

// --- 3. runs y steps --------------------------------------------------------
const runs = await get(`MessageProcessingLogs('${mpl.MessageGuid}')/Runs`);
const run = runs.rows[0];
if (!run) {
  console.log("3) El MPL no tiene runs.");
  process.exit(1);
}
console.log(`\n3) Run ${run.Id}  LogLevel=${run.LogLevel}  ${run.OverallState}`);

const steps = await get(`MessageProcessingLogRuns('${run.Id}')/RunSteps`);
console.log(`   ${steps.rows.length} step(s)`);

// --- 4. payload por paso ----------------------------------------------------
console.log(`\n4) Payload por paso:`);
for (const s of steps.rows) {
  const uri = s.__metadata?.uri ?? "";
  const clave = uri.slice(uri.indexOf("MessageProcessingLogRunSteps"));
  const etiqueta = `${s.ModelStepId ?? "?"} (${s.StepId ?? "-"})`;

  if (!clave) {
    console.log(`   ${etiqueta}: sin __metadata.uri, no se puede navegar`);
    continue;
  }

  const tm = await get(`${clave}/TraceMessages`);
  if (tm.status >= 400) {
    console.log(`   ${etiqueta}: TraceMessages -> ${tm.status} ${tm.text.slice(0, 90)}`);
    continue;
  }
  if (!tm.rows.length) {
    console.log(`   ${etiqueta}: sin TraceMessages`);
    continue;
  }
  for (const t of tm.rows) {
    const res = await fetch(`${perfil.oauth.url}/api/v1/TraceMessages(${t.TraceId}L)/$value`, {
      headers: { Authorization: `Bearer ${apiTok}` },
    });
    const txt = await res.text();
    console.log(
      `   ${etiqueta}: TraceId=${t.TraceId} ${t.MimeType ?? ""} ${t.PayloadSize ?? txt.length} bytes -> $value ${res.status}`
    );
    console.log(`      ${txt.slice(0, 220).replace(/\s+/g, " ")}`);
  }
}
