// Copia las skills de este repo a los workspaces de Claude Code que usan este MCP.
//
// Por qué existe: la skill documenta CÓMO se encadenan las tools, así que lo que la
// deja rancia es un cambio en este repo — por eso la fuente única vive acá y se
// versiona con el server. Pero las tools se usan donde esté el trabajo, no
// necesariamente acá: sin esta copia la skill no estaría donde hace falta.
//
// Y existe en esta forma —copiar, no instalar global— porque la preferencia del
// usuario es que nada de esto se habilite a nivel user: las skills, como los MCPs,
// van por proyecto.
//
// DIFERENCIA con el script equivalente de mcp-sap: ese copia a todo directorio que
// tenga un `.mcp.json`. Este además EXIGE que ese `.mcp.json` declare `mcp-cpi`,
// para no dejar una skill de Cloud Integration en un workspace que sólo usa ABAP.
//
// Escribe FUERA del repo, así que:
//   - sólo toca directorios que declaren este server,
//   - sólo escribe dentro de `<workspace>/.claude/skills/`,
//   - por defecto hace DRY-RUN: hay que pasar --write para que copie de verdad,
//   - nunca borra nada que no venga de acá (una skill propia del workspace
//     sobrevive; una con el MISMO nombre se pisa, y se avisa).
//
// Uso:
//   node scripts/sync-skills.js                 # muestra qué haría
//   node scripts/sync-skills.js --write         # copia
//   node scripts/sync-skills.js --check         # exit 1 si algún destino quedó desactualizado
//   CPI_WORKSPACES_DIR=<ruta>[;<ruta>] node scripts/sync-skills.js --write
//
// Sin CPI_WORKSPACES_DIR no hay destinos y el script sale 0: la skill ya vive en este repo.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORIGEN = path.join(REPO, ".claude", "skills");

// Cada raíz puede ser un workspace en sí mismo o un directorio que contiene varios:
// se prueban las dos cosas. Dónde están es cosa de cada máquina, así que no hay default:
// sin CPI_WORKSPACES_DIR no hay destinos, y eso no es un error (ver más abajo).
const RAICES = (process.env.CPI_WORKSPACES_DIR || "")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

const SERVER = "mcp-cpi";
const WRITE = process.argv.includes("--write");
const CHECK = process.argv.includes("--check");

function listarSkills(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, "SKILL.md")))
    .map((d) => d.name);
}

/**
 * Un workspace destino es un directorio cuyo .mcp.json declara este server.
 *
 * Acepta el nombre pelado (`mcp-cpi`) y los sufijados por ambiente (`mcp-cpi-dev`,
 * `mcp-cpi-prd`): un workspace que apunta a dos tenants declara dos entradas, y las
 * dos son este mismo server. Lo que NO alcanza es que el nombre solo empiece igual
 * por casualidad, por eso el separador `-` es obligatorio.
 */
function declaraElServer(dir) {
  const f = path.join(dir, ".mcp.json");
  if (!fs.existsSync(f)) return false;
  try {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    return Object.keys(j.mcpServers || {}).some((k) => k === SERVER || k.startsWith(`${SERVER}-`));
  } catch {
    // un .mcp.json roto no es motivo para romper la sincronización: se ignora
    return false;
  }
}

/** La raíz puede ser el workspace o el contenedor de varios: se prueban las dos. */
function listarWorkspaces(raiz) {
  if (!fs.existsSync(raiz)) return [];
  const out = [];
  if (declaraElServer(raiz)) out.push(raiz);
  for (const d of fs.readdirSync(raiz, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = path.join(raiz, d.name);
    if (declaraElServer(dir)) out.push(dir);
  }
  return out;
}

/** Un NUL byte en los primeros KB es la señal práctica de binario. */
function esBinario(buf) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * El contenido de un archivo con los finales de línea normalizados a LF.
 *
 * ⚠️ Los finales de línea NO son parte del contenido de una skill, y tratarlos como si lo
 * fueran rompió el check entero (2026-08-27). Con `core.autocrlf=true` —el default de Git en
 * Windows— un checkout trae los `.md` con CRLF mientras el destino los tiene con LF; comparando
 * bytes crudos eso marca TODOS los archivos como distintos sin que haya cambiado una palabra.
 * El síntoma: `--check` en rojo permanente y el hook de pre-commit abortando commits sanos.
 *
 * Se normaliza para comparar Y para copiar, así el destino queda igual venga del checkout que
 * venga — que es lo que hace determinística la sincronización, no sólo verde el check.
 *
 * Un binario (un diagrama, una imagen) se devuelve tal cual: normalizarlo lo corrompería.
 */
function contenido(f) {
  const buf = fs.readFileSync(f);
  if (esBinario(buf)) return buf;
  return Buffer.from(buf.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
}

/**
 * Compara dos árboles por CONTENIDO (no por mtime: copiar actualiza la fecha y un
 * checkout viejo puede tener fecha nueva, así que la fecha no dice nada).
 * @returns {string[]} rutas relativas que faltan o difieren; vacío = idénticos
 */
function diferencias(src, dst, base = "") {
  const out = [];
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    const a = path.join(src, e.name);
    const b = path.join(dst, e.name);
    if (e.isDirectory()) {
      if (!fs.existsSync(b)) out.push(`${rel}/ (falta)`);
      else out.push(...diferencias(a, b, rel));
    } else if (!fs.existsSync(b)) {
      out.push(`${rel} (falta)`);
    } else if (!contenido(a).equals(contenido(b))) {
      out.push(`${rel} (distinto)`);
    }
  }
  return out;
}

function copiarDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, e.name);
    const b = path.join(dst, e.name);
    if (e.isDirectory()) copiarDir(a, b);
    else fs.writeFileSync(b, contenido(a));
  }
}

const skills = listarSkills(ORIGEN);
// Un mismo directorio puede aparecer por dos raíces (una raíz que además es workspace):
// el Set lo deja una sola vez, para no copiar dos veces ni contarlo doble.
const workspaces = [...new Set(RAICES.flatMap(listarWorkspaces))];

if (!skills.length) {
  console.error(`No hay skills en ${ORIGEN} — nada que sincronizar.`);
  process.exit(1);
}

if (!workspaces.length) {
  // No es un error ni en --check ni en dry-run: la skill ya está en este repo.
  console.error(`Ningún workspace declara "${SERVER}" en su .mcp.json.`);
  console.error(RAICES.length ? `Raíces buscadas: ${RAICES.join(" · ")}` : `CPI_WORKSPACES_DIR no está definida.`);
  console.error(`La skill ya está en este repo (${path.relative(REPO, ORIGEN)}).`);
  console.error(`Para sincronizar a otros workspaces, pasá CPI_WORKSPACES_DIR=<ruta>[;<ruta>].`);
  process.exit(0);
}

if (CHECK) {
  const desactualizados = [];
  for (const ws of workspaces) {
    for (const skill of skills) {
      const dst = path.join(ws, ".claude", "skills", skill);
      const diffs = fs.existsSync(dst)
        ? diferencias(path.join(ORIGEN, skill), dst)
        : ["(no existe en el workspace)"];
      if (diffs.length) desactualizados.push({ ws, skill, diffs });
    }
  }
  if (!desactualizados.length) {
    console.error(`✓ Skills sincronizadas en ${workspaces.length} workspace(s).`);
    process.exit(0);
  }
  console.error(`✖ Hay skills desactualizadas en ${desactualizados.length} destino(s):\n`);
  for (const d of desactualizados) {
    console.error(`  ${path.basename(d.ws)} / ${d.skill}`);
    for (const x of d.diffs) console.error(`      ${x}`);
  }
  console.error(`\nCorré:  npm run skills:sync`);
  process.exit(1);
}

console.error(`Skills en el repo : ${skills.join(", ")}`);
console.error(`Workspaces destino: ${workspaces.length} (declaran "${SERVER}")`);
console.error(WRITE ? "Modo: ESCRITURA\n" : "Modo: dry-run (pasá --write para copiar)\n");

let copiadas = 0;
for (const ws of workspaces) {
  for (const skill of skills) {
    const dst = path.join(ws, ".claude", "skills", skill);
    const existia = fs.existsSync(dst);
    console.error(`  ${existia ? "actualiza" : "crea    "}  ${dst}`);
    if (WRITE) {
      copiarDir(path.join(ORIGEN, skill), dst);
      copiadas++;
    }
  }
}

console.error(
  WRITE
    ? `\n✓ ${copiadas} skill(s) copiada(s). Reabrí el workspace en Claude Code para que las tome.`
    : `\n(dry-run: no se escribió nada)`
);
