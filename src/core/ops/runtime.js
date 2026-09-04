/**
 * ops/runtime — lo que esta deployado, endpoints expuestos, material de seguridad
 * y el chequeo de conectividad.
 */

import { clean, odataQuote } from "../client.js";

/** Artefactos deployados y su estado. */
export async function listDeployed(client, { top = 100 } = {}) {
  const { rows } = await client.get(`IntegrationRuntimeArtifacts?$top=${top}`);
  return rows.map((r) =>
    clean(r, { fields: ["Id", "Version", "Name", "Type", "Status", "DeployedBy", "DeployedOn"] })
  );
}

/**
 * Detalle de error de un artefacto deployado.
 *
 * ⚠️ Dos trampas encadenadas, verificadas el 2026-08-10 sobre un deploy fallido de verdad:
 * la navegacion pelada `/ErrorInformation` da **404**, y `/$value` con el `Accept: application/json`
 * que manda el cliente da **406**. Hay que pedir `application/xml` aunque lo que devuelva sea JSON.
 *
 * Esto estuvo roto: la version anterior pegaba contra la navegacion pelada, se comia el 404 como
 * "sin error registrado" y devolvia null SIEMPRE. El sintoma era que `cpi_deploy` informaba
 * "quedo en estado ERROR" y no decia por que — justo cuando mas hace falta.
 *
 * @returns {Promise<object|null>} null si no hay error registrado.
 */
export async function deployedErrorInfo(client, id) {
  let text;
  try {
    const buf = await client.request(
      "GET",
      `IntegrationRuntimeArtifacts('${odataQuote(id)}')/ErrorInformation/$value`,
      { raw: true, headers: { Accept: "application/xml" } }
    );
    text = (Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf ?? "")).trim();
  } catch (err) {
    if (err.status === 404) return null; // sin error registrado
    throw err;
  }
  return text ? parseErrorInformation(text) : null;
}

/**
 * El cuerpo viene como `{"message":{...},"parameter":[...]}`. Se aplana a algo que `kv()` pueda
 * mostrar; si algun dia deja de ser JSON, se devuelve el texto crudo en vez de perderlo.
 */
export function parseErrorInformation(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return { detalle: text };
  }

  const m = j?.message ?? {};
  const params = Array.isArray(j?.parameter) ? j.parameter.filter(Boolean) : [];
  const out = {
    motivo: m.messageId ?? "",
    subsistema: [m.subsystemName, m.subsytemPartName].filter(Boolean).join(" / "),
    // SAP escribe `messageText` vacio y pone el texto util en `parameter`. Se muestran los dos:
    // quedarse solo con messageText fue lo que hizo parecer que la entidad no informaba nada.
    detalle: [m.messageText, ...params].filter((s) => s && String(s).trim()).join(" "),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v));
}

/** Endpoints HTTP expuestos por los iFlows deployados. */
export async function listEndpoints(client) {
  const { rows } = await client.get(`ServiceEndpoints`);
  return rows.map((r) => clean(r));
}

/**
 * El address real de un endpoint viene embebido con la forma `<iflowId>$endpointAddress=<address>`
 * (verificado el 2026-08-04). No hay un campo limpio: hay que partir por el `=`, y el `<address>`
 * NO tiene por que coincidir con el Id del iFlow.
 *
 * No se asume en que campo viene: se barren los valores string de la fila. Si SAP mueve el dato
 * de campo, esto lo sigue encontrando.
 *
 * `Protocol` (`REST` | `SOAP`) SI viene en su propio campo, y no es decorativo: decide bajo que
 * servlet lo sirve el runtime — `/http/` o `/cxf/`. Ver `prefixForProtocol()`.
 */
function addressOf(row) {
  for (const v of Object.values(row ?? {})) {
    if (typeof v !== "string") continue;
    const i = v.indexOf("$endpointAddress=");
    if (i >= 0) {
      return {
        iflow: v.slice(0, i),
        address: v.slice(i + "$endpointAddress=".length),
        protocol: typeof row.Protocol === "string" ? row.Protocol : null,
      };
    }
  }
  return null;
}

/** Todos los endpoints con su address ya desarmado. */
export async function listEndpointAddresses(client) {
  const rows = await listEndpoints(client);
  return rows
    .map((r) => ({ ...addressOf(r), raw: r }))
    .filter((e) => e.address);
}

/**
 * Address del endpoint de un iFlow deployado, con el protocolo bajo el que lo sirve el runtime.
 *
 * @returns {Promise<{iflow: string, address: string, protocol: string|null}>}
 * @throws si el iFlow no expone endpoint HTTP — lo normal en flujos disparados por timer,
 *         file/SFTP, JMS o IDoc, que son buena parte de una migracion PI/PO.
 */
export async function resolveEndpoint(client, iflowId) {
  const eps = await listEndpointAddresses(client);
  const hit = eps.find((e) => e.iflow === iflowId);
  if (hit) return hit;

  // ⚠️ Verificado el 2026-08-05 y de nuevo el 2026-08-27: ServiceEndpoints tarda en reflejar un
  // deploy recien hecho, con el artefacto ya en STARTED. Se midio 30 s la primera vez y MAS DE
  // TRES MINUTOS con un sender SOAP. Sin este aviso, invocar justo despues de deployar parece
  // "este iFlow no expone endpoint" cuando en realidad todavia no se asento.
  const reciente =
    "Ojo: si el deploy es reciente, esta entidad puede no haberlo reflejado todavia — se vio " +
    "tardar 30 s con un sender HTTPS y mas de 3 minutos con uno SOAP, en ambos casos con el " +
    "artefacto ya en STARTED. Reintentar antes de concluir que no tiene endpoint.";

  const err = new Error(`El iFlow "${iflowId}" no expone ningun endpoint HTTP.`);
  err.hint = eps.length
    ? `Endpoints disponibles: ${eps
        .map((e) => `${e.iflow} -> ${e.address}${e.protocol ? ` (${e.protocol})` : ""}`)
        .join(", ")}. ` +
      `Si el Id es correcto, revisar que el artefacto este STARTED con cpi_deployed. ${reciente}`
    : "El tenant no tiene ningun endpoint HTTP expuesto. Los iFlows disparados por timer, file, " +
      `JMS o IDoc no exponen endpoint: esos se disparan por su propio mecanismo, no con cpi_invoke. ${reciente}`;
  throw err;
}

/**
 * Nombres de credenciales del Security Material.
 *
 * ⚠️ La entidad devuelve un campo `Password`. Se proyecta con WHITELIST explicita:
 * si SAP agrega un campo sensible nuevo, con blacklist se filtraria solo. Ademas
 * `UserCredentials` NO soporta $top, asi que no se le manda.
 */
const CREDENTIAL_SAFE_FIELDS = ["Name", "Kind", "Description", "User", "CompanyId"];

export async function listCredentialNames(client) {
  const { rows } = await client.get(`UserCredentials`);
  return rows.map((r) => clean(r, { fields: CREDENTIAL_SAFE_FIELDS }));
}

/** Chequeo de conectividad: token + $metadata + inventario. */
export async function ping(client) {
  const started = Date.now();
  const scopes = await client.getScopes();

  // $metadata es XML: se pide crudo para que el cliente no intente parsearlo como JSON
  const buf = await client.request("GET", "$metadata", {
    raw: true,
    headers: { Accept: "application/xml" },
  });
  const xml = Buffer.isBuffer(buf) ? buf.toString("utf8") : "";

  return {
    apiBase: client.apiBase,
    ms: Date.now() - started,
    scopes,
    canWrite: scopes.some((s) => /deploycontent|WebToolingWorkspace\.Write/.test(s)),
    entitySets: countEntitySets(xml),
  };
}

function countEntitySets(xml) {
  if (typeof xml !== "string") return null;
  return (xml.match(/<EntitySet\s/g) ?? []).length || null;
}
