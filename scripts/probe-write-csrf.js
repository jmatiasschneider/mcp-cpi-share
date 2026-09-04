#!/usr/bin/env node
/**
 * Fase 0 (parte 4) - ESCRITURA: contrato de CSRF y ciclo create/delete.
 *
 * ⚠️ ESTE SCRIPT ESCRIBE EN EL TENANT. Crea un artefacto descartable y lo borra.
 *    No deploya nada. No toca artefactos existentes.
 *
 * Responde tres preguntas:
 *   1. ¿La API exige X-CSRF-Token cuando autenticas con Bearer, o se lo saltea?
 *   2. ¿El token de CSRF necesita la cookie de sesion que vino con el?
 *   3. ¿Cual es el contrato real de POST /IntegrationDesigntimeArtifacts?
 *
 * Uso: node scripts/probe-write-csrf.js
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROBE_ID = "zz_mcp_probe";
const PROBE_PKG = "DEVtest";

function loadProfile() {
  const s = JSON.parse(readFileSync(join(ROOT, "systems.json"), "utf8"));
  return s[process.env.CPI_PROFILE || Object.keys(s)[0]].oauth;
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
  if (!res.ok) throw new Error(`Token ${res.status}`);
  return (await res.json()).access_token;
}

let API, BEARER;

function short(t, n = 200) {
  return (t || "").replace(/\s+/g, " ").slice(0, n);
}

async function call(method, path, { body, csrf, cookie, accept = "application/json" } = {}) {
  const headers = { Authorization: `Bearer ${BEARER}`, Accept: accept };
  if (body) headers["Content-Type"] = "application/json";
  if (csrf) headers["X-CSRF-Token"] = csrf;
  if (cookie) headers["Cookie"] = cookie;

  const res = await fetch(`${API}/api/v1/${path}`, { method, headers, body });
  const text = await res.text();
  return {
    status: res.status,
    ok: res.ok,
    text,
    csrfHeader: res.headers.get("x-csrf-token"),
    setCookie: res.headers.getSetCookie?.() ?? [],
  };
}

/** GET con X-CSRF-Token: Fetch -> devuelve { csrf, cookie } de la MISMA sesion. */
async function fetchCsrf() {
  const res = await fetch(`${API}/api/v1/`, {
    headers: {
      Authorization: `Bearer ${BEARER}`,
      "X-CSRF-Token": "Fetch",
      Accept: "application/json",
    },
  });
  const cookies = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]);
  return {
    status: res.status,
    csrf: res.headers.get("x-csrf-token"),
    cookie: cookies.join("; "),
    cookieCount: cookies.length,
  };
}

async function main() {
  const oauth = loadProfile();
  API = oauth.url;
  BEARER = await fetchToken(oauth);

  const zipPath = join(ROOT, "discovery-raw", "test.zip");
  if (!existsSync(zipPath)) {
    throw new Error("Falta discovery-raw/test.zip. Corre antes: node scripts/probe-iflow-content.js");
  }
  const content = readFileSync(zipPath).toString("base64");
  const payload = JSON.stringify({
    Name: PROBE_ID,
    Id: PROBE_ID,
    PackageId: PROBE_PKG,
    ArtifactContent: content,
  });

  console.log(`\n=== probe de escritura (crea y borra ${PROBE_ID} en ${PROBE_PKG}) ===\n`);

  // --- 1. POST sin CSRF -----------------------------------------------
  console.log("[1] POST /IntegrationDesigntimeArtifacts  SIN X-CSRF-Token");
  const noCsrf = await call("POST", "IntegrationDesigntimeArtifacts", { body: payload });
  console.log(`    -> HTTP ${noCsrf.status}`);
  console.log(`       x-csrf-token en respuesta: ${noCsrf.csrfHeader ?? "(ninguno)"}`);
  console.log(`       body: ${short(noCsrf.text, 180)}`);
  const csrfRequerido = noCsrf.status === 403;
  console.log(`    => CSRF ${csrfRequerido ? "SI es requerido" : "NO parece requerido"}\n`);

  // --- 2. Fetch del token ---------------------------------------------
  console.log("[2] GET / con X-CSRF-Token: Fetch");
  const c = await fetchCsrf();
  console.log(`    -> HTTP ${c.status}  token=${c.csrf ? c.csrf.slice(0, 12) + "…" : "(ninguno)"}  cookies=${c.cookieCount}\n`);

  // --- 3. POST con CSRF pero SIN cookie --------------------------------
  let created = false;
  if (c.csrf) {
    console.log("[3] POST con X-CSRF-Token pero SIN la cookie de sesion");
    const noCookie = await call("POST", "IntegrationDesigntimeArtifacts", {
      body: payload,
      csrf: c.csrf,
    });
    console.log(`    -> HTTP ${noCookie.status}  ${short(noCookie.text, 140)}`);
    console.log(`    => la cookie ${noCookie.status === 403 ? "SI" : "NO"} hace falta ademas del token\n`);
    if (noCookie.ok) created = true;
  }

  // --- 4. POST con CSRF + cookie ---------------------------------------
  if (!created) {
    console.log("[4] POST con X-CSRF-Token + cookie de la misma sesion");
    const full = await call("POST", "IntegrationDesigntimeArtifacts", {
      body: payload,
      csrf: c.csrf,
      cookie: c.cookie,
    });
    console.log(`    -> HTTP ${full.status}  ${short(full.text, 300)}`);
    created = full.ok;
  }

  // --- 5. Verificar y limpiar ------------------------------------------
  console.log(`\n[5] Verificando que exista…`);
  const check = await call("GET", `IntegrationPackages('${PROBE_PKG}')/IntegrationDesigntimeArtifacts`);
  const ids = (() => {
    try {
      return (JSON.parse(check.text)?.d?.results ?? []).map((r) => r.Id);
    } catch {
      return [];
    }
  })();
  console.log(`    artefactos en ${PROBE_PKG}: ${ids.join(", ") || "(ninguno)"}`);

  if (ids.includes(PROBE_ID)) {
    console.log(`\n[6] Limpiando: DELETE ${PROBE_ID}`);
    const c2 = await fetchCsrf();
    const del = await call(
      "DELETE",
      `IntegrationDesigntimeArtifacts(Id='${PROBE_ID}',Version='active')`,
      { csrf: c2.csrf, cookie: c2.cookie }
    );
    console.log(`    -> HTTP ${del.status}  ${short(del.text, 140)}`);

    const after = await call("GET", `IntegrationPackages('${PROBE_PKG}')/IntegrationDesigntimeArtifacts`);
    const idsAfter = (() => {
      try {
        return (JSON.parse(after.text)?.d?.results ?? []).map((r) => r.Id);
      } catch {
        return [];
      }
    })();
    console.log(`    artefactos despues: ${idsAfter.join(", ") || "(ninguno)"}`);
    console.log(`    => limpieza ${idsAfter.includes(PROBE_ID) ? "FALLO - queda basura!" : "OK"}`);
  } else {
    console.log(`    (no se creo nada, no hay que limpiar)`);
  }
  console.log();
}

main().catch((e) => {
  console.error(`\nERROR: ${e.message}\n`);
  process.exitCode = 1;
});
