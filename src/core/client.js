/**
 * CpiClient — transporte contra la OData v2 API de Cloud Integration.
 *
 * Responsabilidades: OAuth2 client_credentials (con cache de token), armado de URL,
 * normalizacion de respuestas OData v2 y traduccion de errores a mensajes accionables.
 * SIN orquestacion: eso vive en core/ops/.
 *
 * Decisiones tomadas a partir del discovery (ver DISCOVERY.md):
 *  - JSON se pide por header `Accept`, NUNCA por `$format=json` (KeystoreEntries lo rechaza).
 *  - No hace falta CSRF ni cookie jar con Bearer (POST sin token dio 201). Igual se maneja
 *    de forma defensiva el 403 + `X-CSRF-Token: Required` con un unico reintento.
 *  - HTTP 500 se usa para errores de NEGOCIO: nunca reintentar a ciegas.
 *  - HTTP 204 es "vacio", no error.
 */

import { TokenSource } from "./token.js";

export class CpiError extends Error {
  constructor(message, { status, url, hint } = {}) {
    super(message);
    this.name = "CpiError";
    this.status = status;
    this.url = url;
    this.hint = hint;
  }
}

export class CpiClient {
  #tokens;

  constructor({ oauth, label = "cpi", fetchImpl = globalThis.fetch }) {
    this.label = label;
    this.fetch = fetchImpl;
    this.apiBase = `${oauth.url.replace(/\/+$/, "")}/api/v1`;
    this.#tokens = new TokenSource(oauth, {
      fetchImpl,
      plan: "api",
      makeError: (msg, meta) => new CpiError(msg, meta),
    });
  }

  // --- auth ---------------------------------------------------------------

  /** Token cacheado en memoria. Dura ~12 h; se renueva solo. */
  getToken() {
    return this.#tokens.get();
  }

  /** Scopes del token, leidos del payload del JWT. Util para diagnostico de permisos. */
  getScopes() {
    return this.#tokens.scopes();
  }

  // --- transporte ---------------------------------------------------------

  /**
   * Request crudo contra el API.
   * @param {string} method
   * @param {string} path  ruta despues de /api/v1/ (sin barra inicial)
   * @param {{body?: any, raw?: boolean, headers?: object, _retried?: boolean}} opts
   */
  async request(method, path, { body, raw = false, headers = {}, _retried = false } = {}) {
    const token = await this.getToken();
    const url = `${this.apiBase}/${path.replace(/^\/+/, "")}`;

    const h = {
      Authorization: `Bearer ${token}`,
      // JSON por header, nunca por $format: hay entidades que rechazan $format.
      Accept: raw ? "application/octet-stream" : "application/json",
      ...headers,
    };
    let payload;
    if (body !== undefined) {
      h["Content-Type"] = "application/json";
      payload = typeof body === "string" ? body : JSON.stringify(body);
    }

    const res = await this.fetch(url, { method, headers: h, body: payload });

    // Defensivo: si algun dia SAP pide CSRF en alguna operacion, un unico reintento.
    if (res.status === 403 && !_retried && /required/i.test(res.headers.get("x-csrf-token") ?? "")) {
      const csrf = await this.#fetchCsrf();
      return this.request(method, path, {
        body,
        raw,
        headers: { ...headers, ...csrf },
        _retried: true,
      });
    }

    if (res.status === 204) return raw ? Buffer.alloc(0) : { empty: true, rows: [] };

    if (raw) {
      if (!res.ok) throw await this.#toError(res, url);
      return Buffer.from(await res.arrayBuffer());
    }

    const text = await res.text();
    if (!res.ok) throw await this.#toError(res, url, text);

    if (!text) return { empty: true, rows: [] };
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new CpiError(`Respuesta no-JSON de ${path}`, { status: res.status, url });
    }
    return { json, rows: rowsOf(json) };
  }

  async #fetchCsrf() {
    const token = await this.getToken();
    const res = await this.fetch(`${this.apiBase}/`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-CSRF-Token": "Fetch",
        Accept: "application/json",
      },
    });
    const cookies = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]);
    const out = {};
    const t = res.headers.get("x-csrf-token");
    if (t) out["X-CSRF-Token"] = t;
    if (cookies.length) out["Cookie"] = cookies.join("; ");
    return out;
  }

  async #toError(res, url, text) {
    const body = text ?? (await res.text().catch(() => ""));
    let msg = null;
    try {
      msg = JSON.parse(body)?.error?.message?.value;
    } catch {}
    // Con `Accept: application/octet-stream` (las descargas raw) el error OData llega en XML,
    // no en JSON (verificado el 2026-08-26 con los /$value de package y artefacto).
    if (!msg) msg = /<message[^>]*>([\s\S]*?)<\/message>/.exec(body)?.[1]?.trim() || null;
    const detail = msg || body.slice(0, 300).replace(/\s+/g, " ") || "(sin cuerpo)";

    return new CpiError(`HTTP ${res.status} — ${detail}`, {
      status: res.status,
      url,
      hint: HINTS[res.status]?.(detail),
    });
  }

  // --- azucar -------------------------------------------------------------

  get(path, opts) {
    return this.request("GET", path, opts);
  }
  post(path, body, opts) {
    return this.request("POST", path, { ...opts, body });
  }
  put(path, body, opts) {
    return this.request("PUT", path, { ...opts, body });
  }
  del(path, opts) {
    return this.request("DELETE", path, opts);
  }
}

const HINTS = {
  401: () => "El token fue rechazado. Revisa las credenciales del profile en systems.json.",
  403: () =>
    "Faltan scopes en la instancia de Process Integration Runtime. Revisa los roles con los que " +
    "se creo la instancia (cpi_ping muestra los scopes del token).",
  404: () => "La entidad o el Id no existen. Ojo con mayusculas/minusculas en el Id.",
  500: () =>
    "En esta API el 500 suele ser un error de NEGOCIO (por ejemplo, un Id que ya existe), " +
    "no un fallo transitorio. Leer el mensaje: reintentar no ayuda.",
  501: () =>
    "Esa entidad no es consultable de primer nivel: solo se llega navegando desde " +
    "IntegrationPackages o MessageProcessingLogs.",
};

// --- helpers de OData v2 ----------------------------------------------------

/** OData v2 devuelve d.results (coleccion) o d (entidad unica). */
export function rowsOf(json) {
  const d = json?.d;
  if (!d) return [];
  if (Array.isArray(d.results)) return d.results;
  if (Array.isArray(d)) return d;
  return [d];
}

/** `/Date(1753891200000)/` -> ISO 8601. Devuelve null si no matchea. */
export function odataDate(v) {
  if (typeof v !== "string") return null;
  const m = /^\/Date\((-?\d+)([+-]\d+)?\)\/$/.exec(v);
  return m ? new Date(Number(m[1])).toISOString() : null;
}

/**
 * Esta API mezcla DOS formatos de fecha (verificado en el tenant):
 *   - Edm.DateTime -> "/Date(1753891200000)/"   (ej DeployedOn, LogEnd)
 *   - Edm.String   -> "1785109955217"            (ej CreatedAt, ModifiedDate)
 * El segundo solo se distingue por el nombre del campo, asi que se convierte
 * unicamente en campos que semanticamente son fechas.
 */
const DATE_FIELD = /(Date|At|On|Time|Start|Stop|End)$/;

function maybeDate(key, v) {
  const iso = odataDate(v);
  if (iso) return iso;
  if (typeof v === "string" && DATE_FIELD.test(key) && /^\d{13}$/.test(v)) {
    return new Date(Number(v)).toISOString();
  }
  return null;
}

/**
 * Aplana un objeto anidado que no es una nav property diferida.
 * Preferimos un identificador legible antes que "[object Object]".
 */
function flatten(v) {
  if (Array.isArray(v)) return v.length ? `[${v.length} items]` : "";
  const pick = v.Name ?? v.Id ?? v.Key ?? null;
  if (pick != null && typeof pick !== "object") return String(pick);
  const compact = JSON.stringify(v);
  return compact.length > 200 ? compact.slice(0, 200) + "…" : compact;
}

/** Escapa una comilla simple para meterla en una key OData: O'Brien -> O''Brien */
export function odataQuote(s) {
  return String(s).replace(/'/g, "''");
}

/**
 * Un byte NUL en los primeros KB es la señal practica de binario. Vive aca y no en un ops
 * porque lo necesita todo el que baje un `/$value`: el bundle de un artefacto y el payload
 * de una traza llegan por el mismo camino. Volcar un .p12 o un .jar como si fuera texto
 * ensucia la respuesta y no le sirve a nadie.
 *
 * Para las trazas es ademas la UNICA señal utilizable: el `MimeType` de `TraceMessages` viene
 * como `application/octet-stream` aunque el contenido sea XML.
 */
export function isBinary(buf) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Quita __metadata y convierte fechas OData a ISO. Deja las nav properties afuera. */
export function clean(row, { fields = null } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(row ?? {})) {
    if (k === "__metadata") continue;
    if (fields && !fields.includes(k)) continue;
    if (v && typeof v === "object" && "__deferred" in v) continue;

    if (v && typeof v === "object") {
      out[k] = flatten(v);
      continue;
    }
    out[k] = maybeDate(k, v) ?? v;
  }
  return out;
}
