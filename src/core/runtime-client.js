/**
 * RuntimeClient — invoca el endpoint HTTP de un iFlow deployado.
 *
 * Es el SEGUNDO plano del tenant, distinto del de CpiClient: usa la service key del plan
 * `integration-flow` y pega contra otro host (`…it-cpi008-rt.cfapps…` en vez de
 * `…it-cpi008.cfapps…`). Ver DISCOVERY.md, seccion "Invocar un iFlow".
 *
 * Contratos verificados contra el tenant el 2026-08-04 (scripts/probe-invoke.js):
 *  - La ruta es `<url de la key>/<servlet>/<address>`, donde `<address>` sale de ServiceEndpoints
 *    con la forma `<id>$endpointAddress=<address>`: NO es el Id del iFlow. El `<servlet>` NO es
 *    siempre `http` — depende del protocolo del sender, ver `prefixForProtocol()`.
 *  - Los scopes de esta key usan otro xsappname (`it-rt-<tenant>!b106.ESBMessaging.send`),
 *    asi que se comparan por sufijo y no por string completo.
 *  - `GET /http/<addr>` dio 200, pero `POST` al mismo endpoint dio 403 con HTML de Tomcat:
 *    eso NO es falta de rol, es `xsrfProtection=1` en el sender adapter. Ese CSRF es propio
 *    de cada sender y no tiene nada que ver con el del API de administracion (que no existe).
 */

import { TokenSource, scopesOf } from "./token.js";

export class RuntimeError extends Error {
  constructor(message, { status, url, hint } = {}) {
    super(message);
    this.name = "RuntimeError";
    this.status = status;
    this.url = url;
    this.hint = hint;
  }
}

/**
 * Headers que PODRIAN atar la respuesta a un registro del monitor.
 *
 * ⚠️ Verificado el 2026-08-05, y el resultado es peor de lo esperado: sobre este sender
 * **ninguno de los tres vino en las invocaciones exitosas** salvo `x-correlationid`, y ese
 * **no matchea ningun campo del MPL** — ni `CorrelationId` ni `MessageGuid`. Es un id interno
 * del runtime (formato uuid) contra los guids de SAP (formato `AGpy…`).
 *
 * Conclusion: en una invocacion OK no hay puente directo al MPL. Hay que buscar por iFlow y
 * ventana de tiempo. En una invocacion FALLIDA si hay puente, pero viene en el CUERPO del error.
 */
const CORRELATION_HEADERS = [
  "sap-messageprocessinglogid",
  "sap-messageid",
  "x-correlationid",
];

const MODIFYING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Los dos servlets del runtime. Un address servido por el otro da 404 de Tomcat. */
export const SERVLETS = ["http", "cxf"];

/**
 * ⚠️ El runtime NO sirve todos los senders bajo `/http/`.
 *
 * Verificado el 2026-08-27 invocando `ZMOLDE_ARQ1_CLEARINGS` (sender SOAP 1.x): `ServiceEndpoints`
 * lo listaba con `Protocol: "SOAP"`, la URL se armo igual con `/http/` y el Tomcat devolvio 404.
 * El mismo address bajo `/cxf/` responde. Los senders SOAP los atiende el servlet de CXF; los
 * HTTPS/REST, el de `http`.
 *
 * Solo `SOAP` esta verificado. Un protocolo desconocido cae en `http`, que es el caso mayoritario;
 * si aparece otro que el runtime sirva por CXF, se suma aca — el 404 de `cpi_invoke` avisa que hay
 * que probar el otro prefijo.
 */
const CXF_PROTOCOLS = new Set(["SOAP"]);

export function prefixForProtocol(protocol) {
  return CXF_PROTOCOLS.has(String(protocol ?? "").toUpperCase()) ? "cxf" : "http";
}

export class RuntimeClient {
  #tokens;

  /**
   * @param {{clientid: string, clientsecret: string, tokenurl: string, url?: string}} runtime
   *   El bloque `runtime` del profile (service key del plan `integration-flow`).
   */
  constructor({ runtime, label = "cpi", fetchImpl = globalThis.fetch }) {
    this.label = label;
    this.fetch = fetchImpl;
    // `url` es opcional en la key segun config/local.js; sin ella no hay endpoint que armar.
    this.base = runtime.url ? runtime.url.replace(/\/+$/, "") : null;
    this.#tokens = new TokenSource(runtime, {
      fetchImpl,
      plan: "integration-flow",
      makeError: (msg, meta) => new RuntimeError(msg, meta),
    });
  }

  /** Scopes de la key de runtime. `ESBMessaging.send` es el que habilita invocar. */
  async getScopes() {
    return scopesOf(await this.#tokens.get());
  }

  /**
   * URL final de un address de ServiceEndpoints.
   *
   * El servlet sale del `protocol` de la fila. Si el address ya viene con el prefijo puesto
   * (`cxf/Foo`, `/http/Foo` — la forma en que se copia una URL de la UI), se respeta ese: quien
   * lo escribio ya sabe donde escucha, y adivinarle encima seria peor.
   */
  urlFor(address, protocol) {
    if (!this.base) {
      throw new RuntimeError("La service key del plan 'integration-flow' no trae el campo 'url'.", {
        hint:
          "Agregar \"url\" al bloque \"runtime\" del profile en systems.json. Sale tal cual de la " +
          "service key; es el host de runtime (…-rt.cfapps…), distinto del host del API.",
      });
    }
    const path = String(address).replace(/^\/+/, "");
    const explicito = SERVLETS.find((s) => path.toLowerCase().startsWith(`${s}/`));
    if (explicito) return `${this.base}/${path}`;
    return `${this.base}/${prefixForProtocol(protocol)}/${path}`;
  }

  /**
   * Invoca el endpoint. Devuelve SIEMPRE el resultado, tambien cuando el iFlow responde
   * 4xx/5xx: un error del iFlow es informacion, no una excepcion. Solo tira si no se
   * pudo ni armar la llamada ni conseguir el token.
   *
   * @param {string} address
   * @param {{protocol?: string, method?: string, body?: string, contentType?: string,
   *          headers?: object, timeoutMs?: number, _csrf?: object}} opts
   * @returns {Promise<{status, statusText, ms, contentType, body, truncated, headers,
   *                    correlation, url, method, csrfRetried}>}
   */
  async invoke(address, opts = {}) {
    const {
      protocol = null,
      method = "GET",
      body,
      contentType,
      headers = {},
      timeoutMs = 60_000,
      maxBytes = 8000,
      _csrf = null,
    } = opts;

    const url = this.urlFor(address, protocol);
    const token = await this.#tokens.get();

    const h = { Authorization: `Bearer ${token}`, ...headers, ..._csrf };
    if (body !== undefined && body !== null && !h["Content-Type"]) {
      h["Content-Type"] = contentType ?? "application/json";
    }

    const t0 = Date.now();
    let res;
    try {
      res = await this.fetch(url, {
        method,
        headers: h,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
      throw new RuntimeError(
        timedOut
          ? `El iFlow no respondio en ${timeoutMs} ms.`
          : `No se pudo alcanzar el endpoint: ${err?.message ?? err}`,
        {
          url,
          hint: timedOut
            ? "El iFlow puede estar esperando a un backend lento. Revisar el MPL con cpi_messages."
            : "Revisar que el artefacto este STARTED (cpi_deployed) y que el host de runtime sea el correcto.",
        }
      );
    }

    const text = await res.text().catch(() => "");

    // CSRF del SENDER adapter en un metodo que modifica. Un solo reintento, y se informa.
    if (res.status === 403 && !_csrf && MODIFYING.has(method.toUpperCase()) && isCsrf(res, text)) {
      const csrf = await this.#fetchCsrf(address, token, protocol).catch(() => null);
      if (csrf && csrf["X-CSRF-Token"]) {
        const retry = await this.invoke(address, { ...opts, _csrf: csrf });
        return { ...retry, csrfRetried: true };
      }
    }

    return {
      url,
      method: method.toUpperCase(),
      status: res.status,
      statusText: res.statusText,
      // Momento del disparo: es lo unico que permite acotar la busqueda en el monitor cuando
      // la respuesta no trae el guid del MPL, que es el caso normal (ver el comentario de
      // CORRELATION_HEADERS).
      startedAt: new Date(t0).toISOString(),
      ms: Date.now() - t0,
      contentType: res.headers.get("content-type") ?? null,
      body: text.slice(0, maxBytes),
      bytes: text.length,
      truncated: text.length > maxBytes,
      correlation: pickHeaders(res.headers, CORRELATION_HEADERS),
      csrfRetried: false,
    };
  }

  /** Handshake del sender adapter: GET con `X-CSRF-Token: Fetch`, guardando token y cookies. */
  async #fetchCsrf(address, token, protocol) {
    const res = await this.fetch(this.urlFor(address, protocol), {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, "X-CSRF-Token": "Fetch" },
    });
    const out = {};
    const t = res.headers.get("x-csrf-token");
    if (t) out["X-CSRF-Token"] = t;
    const cookies = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]);
    if (cookies.length) out["Cookie"] = cookies.join("; ");
    return out;
  }
}

/**
 * ¿Este 403 es CSRF o es de rol? Importa distinguirlos: un handshake contra un 403 por rol es
 * un round-trip al pedo, y peor, hace parecer que el problema es CSRF cuando no lo es.
 *
 * Verificado el 2026-08-05 con `xsrfProtection=1` en el sender del iFlow `test`: el rechazo trae
 * **`X-CSRF-Token: required`** en los headers, ademas del HTML de Tomcat en el cuerpo. El header es
 * la señal buena; el cuerpo es el fallback por si algun sender no lo manda.
 */
function isCsrf(res, text) {
  if (/required/i.test(res.headers.get("x-csrf-token") ?? "")) return true;
  return /csrf/i.test(text ?? "");
}

function pickHeaders(headers, names) {
  const out = {};
  for (const n of names) {
    const v = headers.get(n);
    if (v) out[n] = v;
  }
  return out;
}
