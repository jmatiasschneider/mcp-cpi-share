/**
 * Config para el transporte LOCAL (stdio): perfiles en systems.json + env CPI_PROFILE.
 *
 * El equivalente para BTP (VCAP_SERVICES / Destination service) seria src/config/btp.js.
 * Ambos devuelven la MISMA forma, para que el resto del server no sepa de donde salio.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Donde esta el systems.json. Por default en la raiz del server, que es lo comodo cuando se
 * desarrolla el server. Cuando el server se instala como dependencia de otro repo, la raiz es
 * `node_modules/mcp-cpi/` y un archivo ahi se pierde con cada `npm ci`: para ese caso esta
 * `CPI_SYSTEMS`, que apunta a un archivo del repo que lo usa (gitignoreado alla).
 *
 * Una ruta relativa se resuelve contra el cwd del proceso, que en Claude Code es el directorio
 * del proyecto: `"CPI_SYSTEMS": "systems.json"` en el `.mcp.json` alcanza.
 */
export function resolveSystemsPath(systemsPath = process.env.CPI_SYSTEMS) {
  return systemsPath ? resolve(systemsPath) : join(ROOT, "systems.json");
}

const REQUIRED = ["clientid", "clientsecret", "tokenurl", "url"];

// El plan `integration-flow` puede no traer `url`: la URL del endpoint sale del iFlow
// deployado (ServiceEndpoints), no de la key.
const REQUIRED_RUNTIME = ["clientid", "clientsecret", "tokenurl"];

/**
 * Un profile = un TENANT, no una credencial. Adentro puede traer hasta dos juegos de
 * credenciales, que son los dos planos del mismo tenant:
 *   - `oauth`   (plan `api`)              administrar: paquetes, deploy, logs.
 *   - `runtime` (plan `integration-flow`) invocar iFlows con sender HTTP/SOAP.
 *
 * Ninguno de los dos es obligatorio por separado, pero tiene que haber al menos uno: un tenant
 * donde solo conseguiste una de las dos keys es una config legitima. Quien consuma el resultado
 * chequea el bloque que necesita — `oauth` y `runtime` pueden venir en null.
 *
 * @returns {{profile: string, label: string, policy: "readonly"|"readwrite",
 *            oauth: object|null, runtime: object|null, systemsPath: string}}
 */
export function loadConfig({
  profile = process.env.CPI_PROFILE,
  systemsPath = process.env.CPI_SYSTEMS,
} = {}) {
  const path = resolveSystemsPath(systemsPath);

  let systems;
  try {
    systems = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(
        `No existe ${path}. Copia systems.example.json a esa ruta y completalo con la ` +
          `service key de Process Integration Runtime (plan 'api'). La ruta se elige con la ` +
          `variable de entorno CPI_SYSTEMS; sin ella se busca en la raiz del server.`
      );
    }
    throw new Error(`${path} ilegible: ${err.message}`);
  }

  const names = Object.keys(systems).filter((k) => !k.startsWith("_"));
  // Precedencia: env CPI_PROFILE -> `_default` de systems.json -> el primero que aparezca.
  // El fallback posicional queda solo por compatibilidad: elegir por orden es fragil.
  const name = profile || systems._default || names[0];
  const entry = systems[name];

  if (!entry) {
    throw new Error(
      `El profile "${name}" no esta en ${path}. Disponibles: ${names.join(", ") || "(ninguno)"}. ` +
        `Se elige con la variable de entorno CPI_PROFILE o con la clave "_default" del archivo.`
    );
  }

  if (!entry.oauth && !entry.runtime) {
    throw new Error(
      `El profile "${name}" no tiene credenciales: necesita al menos un bloque "oauth" ` +
        `(service key del plan 'api', para administrar) o "runtime" (plan 'integration-flow', ` +
        `para invocar iFlows).`
    );
  }

  const check = (bloque, campos, plan) => {
    if (!entry[bloque]) return null;
    const faltan = campos.filter((f) => !entry[bloque][f]);
    if (faltan.length) {
      throw new Error(
        `Al bloque "${bloque}" del profile "${name}" le faltan campos: ${faltan.join(", ")}. ` +
          `Salen tal cual de la service key del plan '${plan}' en el Cockpit.`
      );
    }
    return { ...entry[bloque] };
  };

  const oauth = check("oauth", REQUIRED, "api");
  const runtime = check("runtime", REQUIRED_RUNTIME, "integration-flow");

  // Validacion estricta: todo el modelo de seguridad del profile cuelga de este string, asi
  // que un typo ("read-only", "READONLY") no puede caer en escritura por defecto y en silencio.
  const policy = entry.policy ?? "readwrite";
  if (policy !== "readonly" && policy !== "readwrite") {
    throw new Error(
      `El profile "${name}" tiene policy "${entry.policy}", que no es un valor valido: solo ` +
        `"readonly" o "readwrite" (o ausente, que equivale a "readwrite").`
    );
  }

  return {
    profile: name,
    label: entry.label || name,
    policy,
    oauth,
    runtime,
    // De donde salio: con dos repos que usan el server, "que archivo cargo" es la primera
    // pregunta de un diagnostico de credenciales.
    systemsPath: path,
  };
}
