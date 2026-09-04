#!/usr/bin/env node
/**
 * Fase 0 - Discovery contra el tenant real.
 *
 * 1. Canjea clientid+clientsecret por un access_token (OAuth2 client_credentials).
 * 2. Muestra los SCOPES del token -> revela si la instancia es plan `api` y con que roles.
 * 3. Pide el $metadata del servicio OData v2 y lista los EntitySets REALMENTE disponibles.
 *
 * No escribe nada en el tenant. No imprime nunca el clientsecret ni el token completo.
 *
 * Uso:  node scripts/discover.js            (usa el primer profile de systems.json)
 *       CPI_PROFILE=dev node scripts/discover.js
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- config -----------------------------------------------------------------

function loadProfile() {
  let raw;
  try {
    raw = readFileSync(join(ROOT, "systems.json"), "utf8");
  } catch {
    throw new Error(
      "No existe systems.json. Copia systems.example.json y completalo con la service key."
    );
  }
  const systems = JSON.parse(raw);
  const name = process.env.CPI_PROFILE || Object.keys(systems)[0];
  const profile = systems[name];
  if (!profile) {
    throw new Error(
      `Profile "${name}" no esta en systems.json. Disponibles: ${Object.keys(systems).join(", ")}`
    );
  }
  for (const f of ["clientid", "clientsecret", "tokenurl", "url"]) {
    if (!profile.oauth?.[f]) throw new Error(`Al profile "${name}" le falta oauth.${f}`);
  }
  return { name, profile };
}

// --- paso 1: token ----------------------------------------------------------

async function fetchToken({ clientid, clientsecret, tokenurl }) {
  // El clientid trae `!` y `|`; mandarlo por Basic auth (base64) evita problemas
  // de encoding que si aparecerian si fuera en el body como query params.
  const basic = Buffer.from(`${clientid}:${clientsecret}`).toString("base64");

  const res = await fetch(tokenurl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Token endpoint devolvio ${res.status}. Body: ${text.slice(0, 400)}\n` +
        `Hint: 401 = clientid/clientsecret mal. 404 = tokenurl mal.`
    );
  }
  return JSON.parse(text);
}

/** Decodifica el payload del JWT (sin validar firma: solo queremos ver que dice). */
function decodeJwtPayload(jwt) {
  const part = jwt.split(".")[1];
  if (!part) return null;
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

// --- paso 2: $metadata ------------------------------------------------------

async function fetchMetadata(apiBase, token) {
  const url = `${apiBase}/api/v1/$metadata`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/xml" },
  });
  const body = await res.text();
  return { url, status: res.status, ok: res.ok, body };
}

/** Extrae los EntitySet del EDMX sin parser XML: alcanza para inventariar. */
function parseEntitySets(xml) {
  const out = [];
  const re = /<EntitySet\s+([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const name = /Name="([^"]+)"/.exec(attrs)?.[1];
    const type = /EntityType="([^"]+)"/.exec(attrs)?.[1];
    if (name) out.push({ name, type });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// --- main -------------------------------------------------------------------

async function main() {
  const { name, profile } = loadProfile();
  const { url: apiBase, tokenurl } = profile.oauth;

  console.log(`\n=== mcp-cpi discovery ===`);
  console.log(`profile : ${name}${profile.policy ? ` (policy: ${profile.policy})` : ""}`);
  console.log(`token   : ${tokenurl}`);
  console.log(`api     : ${apiBase}\n`);

  // 1) token
  console.log("[1/2] Pidiendo access_token...");
  const tok = await fetchToken(profile.oauth);
  const payload = decodeJwtPayload(tok.access_token) || {};
  const scopes = payload.scope || [];

  console.log(`      OK. type=${tok.token_type} expira_en=${tok.expires_in}s`);
  if (payload.exp) console.log(`      exp=${new Date(payload.exp * 1000).toISOString()}`);
  console.log(`      scopes (${scopes.length}):`);
  for (const s of scopes) console.log(`        - ${s}`);

  // 2) metadata
  console.log(`\n[2/2] GET ${apiBase}/api/v1/$metadata`);
  const meta = await fetchMetadata(apiBase, tok.access_token);
  console.log(`      HTTP ${meta.status}`);

  if (!meta.ok) {
    console.log(`      body: ${meta.body.slice(0, 600)}`);
    console.log(
      `\n      Hint: 403 suele significar que la instancia es del plan equivocado\n` +
        `      (integration-flow en vez de api) o que le faltan roles.`
    );
    process.exitCode = 1;
    return;
  }

  const sets = parseEntitySets(meta.body);
  console.log(`      EntitySets encontrados: ${sets.length}\n`);
  for (const s of sets) console.log(`        ${s.name.padEnd(34)} ${s.type ?? ""}`);

  const outDir = join(ROOT, "discovery-raw");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, "metadata.xml");
  writeFileSync(outFile, meta.body, "utf8");
  console.log(`\n      $metadata crudo guardado en discovery-raw/metadata.xml (gitignoreado)`);
}

main().catch((err) => {
  console.error(`\nERROR: ${err.message}\n`);
  process.exitCode = 1;
});
