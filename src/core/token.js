/**
 * TokenSource — OAuth2 client_credentials con cache en memoria.
 *
 * Vive aparte de CpiClient porque el tenant tiene DOS planos de credenciales y ambos
 * necesitan exactamente esta logica: el plan `api` (administrar) y el plan
 * `integration-flow` (invocar iFlows). Duplicarla seria tener dos lugares donde se
 * manipula un clientsecret y dos caches que se pueden desincronizar.
 *
 * ⚠️ Nunca loggear ni devolver el clientsecret ni el token crudo.
 */

const TOKEN_SKEW_MS = 60_000; // renovar 1 min antes de que expire

export class TokenError extends Error {
  constructor(message, { status, url, hint } = {}) {
    super(message);
    this.name = "TokenError";
    this.status = status;
    this.url = url;
    this.hint = hint;
  }
}

export class TokenSource {
  #creds;
  #token = null;
  #exp = 0;
  #inflight = null;

  /**
   * @param {{clientid: string, clientsecret: string, tokenurl: string}} creds
   * @param {{fetchImpl?: typeof fetch, plan?: string, makeError?: Function}} opts
   *   `plan` solo se usa para redactar el mensaje de error (que key revisar).
   *   `makeError` permite que quien lo use tipe el error con su propia clase.
   */
  constructor(creds, { fetchImpl = globalThis.fetch, plan = "api", makeError = null } = {}) {
    this.#creds = creds;
    this.fetch = fetchImpl;
    this.plan = plan;
    this.makeError = makeError ?? ((msg, meta) => new TokenError(msg, meta));
  }

  /** Token cacheado en memoria. Dura ~12 h; se renueva solo. */
  async get() {
    if (this.#token && Date.now() < this.#exp - TOKEN_SKEW_MS) return this.#token;
    if (this.#inflight) return this.#inflight; // evita N requests en paralelo pidiendo token

    this.#inflight = (async () => {
      const { clientid, clientsecret, tokenurl } = this.#creds;
      const basic = Buffer.from(`${clientid}:${clientsecret}`).toString("base64");

      const res = await this.fetch(tokenurl, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
      });

      if (!res.ok) {
        // El cuerpo se descarta a proposito: puede reflejar credenciales.
        await res.text().catch(() => "");
        throw this.makeError(`No se pudo obtener el token OAuth (HTTP ${res.status})`, {
          status: res.status,
          url: tokenurl,
          hint:
            res.status === 401
              ? `clientid o clientsecret incorrectos en el bloque de la key del plan '${this.plan}'.`
              : `Revisa que 'tokenurl' sea el de la service key del plan '${this.plan}'.`,
        });
      }

      const json = await res.json();
      this.#token = json.access_token;
      this.#exp = Date.now() + (json.expires_in ?? 3600) * 1000;
      return this.#token;
    })();

    try {
      return await this.#inflight;
    } finally {
      this.#inflight = null;
    }
  }

  /** Scopes leidos del payload del JWT. Util para diagnostico de permisos. */
  async scopes() {
    const jwt = await this.get();
    return scopesOf(jwt);
  }
}

/** Extrae los scopes de un JWT sin validarlo. Devuelve [] si no se puede parsear. */
export function scopesOf(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
    return payload.scope ?? [];
  } catch {
    return [];
  }
}
