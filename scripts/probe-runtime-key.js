#!/usr/bin/env node
/**
 * Verifica una service key del plan `integration-flow` (la que sirve para INVOCAR iFlows).
 *
 * No consulta el tenant: solo pide un token al `tokenurl` y decodifica el JWT para listar
 * sus scopes. El veredicto es si trae `ESBMessaging.send`, que es el unico scope que habilita
 * disparar un iFlow con sender HTTP/SOAP.
 *
 * A diferencia de los otros probes, NO exige el campo `url`: la key del plan `integration-flow`
 * puede no traerlo (la URL del endpoint sale del iFlow deployado, no de la key).
 *
 * Nunca imprime el clientsecret ni el token. El clientid sale enmascarado.
 *
 * Uso:  node scripts/probe-runtime-key.js <profile>
 *       CPI_PROFILE=dev node scripts/probe-runtime-key.js
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SEND_SCOPE = "ESBMessaging.send";

function loadProfile(name) {
  const systems = JSON.parse(readFileSync(join(ROOT, "systems.json"), "utf8"));
  const names = Object.keys(systems).filter((k) => !k.startsWith("_"));
  const chosen = name || process.env.CPI_PROFILE || names[0];
  const entry = systems[chosen];
  if (!entry) {
    throw new Error(`El profile "${chosen}" no esta en systems.json. Disponibles: ${names.join(", ")}`);
  }
  // Prefiere el bloque `runtime`; cae a `oauth` para profiles que traen la key del plan
  // `integration-flow` como unico bloque.
  const bloque = entry.runtime ? "runtime" : "oauth";
  const creds = entry[bloque];
  if (!creds) throw new Error(`El profile "${chosen}" no tiene bloque "runtime" ni "oauth"`);

  const missing = ["clientid", "clientsecret", "tokenurl"].filter((f) => !creds[f]);
  if (missing.length) {
    throw new Error(`Al bloque "${bloque}" de "${chosen}" le faltan campos: ${missing.join(", ")}`);
  }
  return { name: chosen, label: entry.label || chosen, bloque, oauth: creds };
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

/** El JWT no se valida: solo se lee el payload para ver los scopes. */
function decodePayload(jwt) {
  const part = jwt.split(".")[1];
  if (!part) throw new Error("El token no tiene forma de JWT");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

function mask(clientid) {
  return clientid.length <= 12 ? "***" : `${clientid.slice(0, 6)}…${clientid.slice(-4)}`;
}

async function main() {
  const { name, label, bloque, oauth } = loadProfile(process.argv[2]);

  console.log(`profile:  ${name}  (${label})`);
  console.log(`bloque:   ${bloque}`);
  console.log(`clientid: ${mask(oauth.clientid)}`);
  console.log(`tokenurl: ${new URL(oauth.tokenurl).host}`);
  console.log(`url:      ${oauth.url || "(la key no trae url — normal en plan integration-flow)"}`);

  const t0 = Date.now();
  const token = await fetchToken(oauth);
  const payload = decodePayload(token);
  console.log(`token:    OK en ${Date.now() - t0} ms`);

  const scopes = payload.scope || [];
  const send = scopes.filter((s) => s.endsWith(`.${SEND_SCOPE}`) || s === SEND_SCOPE);

  console.log(`\nscopes (${scopes.length}):`);
  for (const s of scopes.sort()) console.log(`  - ${s}`);

  console.log("");
  if (send.length) {
    console.log(`VEREDICTO: sirve para invocar iFlows — trae ${send.join(", ")}`);
  } else {
    console.log(
      `VEREDICTO: NO sirve para invocar iFlows — falta ${SEND_SCOPE}.\n` +
        `           Revisa que la instancia sea del plan 'integration-flow' y no del plan 'api'.`
    );
  }
}

main().catch((err) => {
  console.error(`\nFALLO: ${err.message}`);
  process.exit(1);
});
