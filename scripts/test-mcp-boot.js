#!/usr/bin/env node
/**
 * Smoke test de arranque. OBLIGATORIO despues de tocar src/ o de agregar una tool.
 *
 * Levanta bin/stdio.js como subproceso y habla JSON-RPC real por stdin/stdout:
 * initialize -> initialized -> tools/list. Verifica que todas las tools se registren
 * con su schema y sus annotations.
 *
 * NO toca el tenant: no pide token ni hace requests. Solo valida el bootstrap.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(ROOT, "bin", "stdio.js");

// Arranca con systems.example.json, no con el systems.json real: el boot no pide token, asi
// que los placeholders alcanzan, y de paso prueba que el ejemplo sea una config valida. Es lo
// que hace que `npm test` corra en un clone recien bajado, sin credenciales.
const env = { ...process.env, CPI_SYSTEMS: join(ROOT, "systems.example.json") };
delete env.CPI_PROFILE;

const child = spawn(process.execPath, [ENTRY], {
  stdio: ["pipe", "pipe", "pipe"],
  env,
});

let stdout = "";
let stderr = "";
const pending = new Map();

child.stdout.on("data", (b) => {
  stdout += b.toString();
  let nl;
  while ((nl = stdout.indexOf("\n")) >= 0) {
    const line = stdout.slice(0, nl).trim();
    stdout = stdout.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      fatal(`stdout no es JSON-RPC valido. Esto suele ser un console.log() en vez de console.error():\n  ${line}`);
    }
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

child.stderr.on("data", (b) => (stderr += b.toString()));

child.on("exit", (code) => {
  if (code !== 0 && pending.size) fatal(`El server murio con codigo ${code}.\n${stderr}`);
});

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout esperando respuesta a ${method}`)), 15000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function fatal(msg) {
  console.error(`\n✗ ${msg}\n`);
  child.kill();
  process.exit(1);
}

async function main() {
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-mcp-boot", version: "0" },
  });
  if (init.error) fatal(`initialize fallo: ${JSON.stringify(init.error)}`);
  const info = init.result?.serverInfo ?? {};
  console.log(`✓ initialize    ${info.name} v${info.version}`);

  notify("notifications/initialized", {});

  const list = await send("tools/list", {});
  if (list.error) fatal(`tools/list fallo: ${JSON.stringify(list.error)}`);

  const tools = list.result?.tools ?? [];
  if (!tools.length) fatal("tools/list devolvio 0 tools.");
  console.log(`✓ tools/list    ${tools.length} tools\n`);

  let problems = 0;
  for (const t of tools) {
    const issues = [];
    if (!t.description || t.description.length < 40) issues.push("descripcion corta o ausente");
    if (!t.inputSchema || t.inputSchema.type !== "object") issues.push("inputSchema invalido");
    if (t.inputSchema && t.inputSchema.additionalProperties !== false) {
      issues.push("inputSchema sin additionalProperties:false");
    }
    if (!t.annotations || t.annotations.readOnlyHint === undefined) issues.push("sin annotations");

    const req = t.inputSchema?.required ?? [];
    const flag = issues.length ? "✗" : "·";
    if (issues.length) problems++;
    console.log(
      `  ${flag} ${t.name.padEnd(20)} ${t.annotations?.readOnlyHint ? "[R]" : "[W]"} ` +
        `params:${Object.keys(t.inputSchema?.properties ?? {}).length} req:${req.length}` +
        (issues.length ? `  -> ${issues.join(", ")}` : "")
    );
  }

  child.kill();

  if (problems) {
    console.error(`\n✗ ${problems} tool(s) con problemas de definicion.\n`);
    process.exit(1);
  }
  console.log(`\n✓ Bootstrap OK. El server registra ${tools.length} tools sin tocar el tenant.\n`);
  process.exit(0);
}

main().catch((err) => fatal(`${err.message}\n${stderr}`));
