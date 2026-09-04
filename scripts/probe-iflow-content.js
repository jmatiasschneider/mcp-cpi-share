#!/usr/bin/env node
/**
 * Baja el ArtifactContent (ZIP base64) de un iFlow y lo desarma.
 *
 * Sirve para dos cosas:
 *   1. Ver con que adapter se dispara el iFlow (hay endpoint HTTP invocable, o es timer/file/JMS?)
 *   2. Documentar la estructura del ZIP -> es el molde para CREAR iFlows nuevos.
 *
 * Uso: node scripts/probe-iflow-content.js [packageId] [artifactId]
 *      (default: DEVtest / test)
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "discovery-raw");

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

/**
 * Lista un ZIP leyendo el End of Central Directory + Central Directory.
 * Node no trae unzip nativo y no queremos dependencias en la fase de discovery.
 */
function listZip(buf) {
  // EOCD: firma 0x06054b50, buscada desde el final
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("No parece un ZIP valido (falta EOCD)");

  const total = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  const entries = [];
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const compSize = buf.readUInt32LE(off + 20);
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    entries.push({ name, compSize, uncompSize });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function main() {
  const pkg = process.argv[2] || "DEVtest";
  const art = process.argv[3] || "test";

  const oauth = loadProfile();
  const token = await fetchToken(oauth);

  // $value devuelve el binario del artefacto (el ZIP) en vez del JSON del registro
  const url = `${oauth.url}/api/v1/IntegrationDesigntimeArtifacts(Id='${art}',Version='active')/$value`;
  console.log(`\nGET ${url}\n`);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log(`HTTP ${res.status}  content-type: ${res.headers.get("content-type")}`);
  if (!res.ok) {
    console.log((await res.text()).slice(0, 500));
    process.exitCode = 1;
    return;
  }

  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`bytes: ${buf.length}\n`);

  mkdirSync(OUT, { recursive: true });
  const zipPath = join(OUT, `${art}.zip`);
  writeFileSync(zipPath, buf);

  const entries = listZip(buf);
  console.log(`--- contenido del ZIP (${entries.length} entradas) ---`);
  for (const e of entries) {
    console.log(`  ${String(e.uncompSize).padStart(8)} B  ${e.name}`);
  }
  console.log(`\nZIP guardado en discovery-raw/${art}.zip (gitignoreado)`);
}

main().catch((e) => {
  console.error(`\nERROR: ${e.message}\n`);
  process.exitCode = 1;
});
