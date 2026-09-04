import { z } from "zod";
import { resolveEndpoint } from "../core/ops/runtime.js";
import { ok, fail, kv } from "./_render.js";

const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"];

export const inputSchema = z
  .object({
    iflow: z.string().min(1).optional(),
    address: z.string().min(1).optional(),
    method: z.enum(METHODS).optional(),
    body: z.string().optional(),
    contentType: z.string().optional(),
    headers: z.record(z.string()).optional(),
    timeoutMs: z.number().int().min(1000).max(180000).optional(),
    maxBytes: z.number().int().min(100).max(200000).optional(),
  })
  .strict()
  .refine((a) => a.iflow || a.address, {
    message: "Hay que indicar 'iflow' (se resuelve su address) o 'address' directo.",
  });

export const jsonSchema = {
  type: "object",
  properties: {
    iflow: {
      type: "string",
      description:
        "Id del iFlow deployado. Su address se resuelve solo desde ServiceEndpoints. " +
        "Es la forma normal de usar esta tool.",
    },
    address: {
      type: "string",
      description:
        "Address del endpoint, si ya se conoce (la parte que va despues de /http/ o de /cxf/). " +
        "Alternativa a 'iflow'; sirve cuando el endpoint no figura en ServiceEndpoints. " +
        "Sin prefijo se asume /http/, que es lo correcto para un sender HTTPS/REST: para un " +
        "sender SOAP hay que escribirlo con el prefijo, 'cxf/<address>', porque el runtime lo " +
        "sirve por otro servlet. Con 'iflow' el prefijo se elige solo.",
    },
    method: {
      type: "string",
      enum: METHODS,
      description: "Metodo HTTP. Default GET.",
    },
    body: { type: "string", description: "Cuerpo de la request, tal cual se manda." },
    contentType: {
      type: "string",
      description: "Content-Type del cuerpo. Default 'application/json' cuando hay body.",
    },
    headers: {
      type: "object",
      additionalProperties: { type: "string" },
      description: "Headers extra (SOAPAction, Accept...).",
    },
    timeoutMs: {
      type: "integer",
      minimum: 1000,
      maximum: 180000,
      description: "Cuanto esperar la respuesta del iFlow. Default 60000.",
    },
    maxBytes: {
      type: "integer",
      minimum: 100,
      maximum: 200000,
      description:
        "Maximo de caracteres del cuerpo de la respuesta a devolver (default 8000). Fijarlo " +
        "alto DE ENTRADA si se espera una respuesta grande: reintentar la invocacion para " +
        "verla entera vuelve a EJECUTAR el iFlow, con sus efectos reales.",
    },
  },
  additionalProperties: false,
};

export async function handler(args, ctx) {
  try {
    const a = inputSchema.parse(args ?? {});

    if (!ctx.runtime) {
      return fail(
        Object.assign(
          new Error(
            `El profile "${ctx.profile}" no tiene el bloque "runtime" (service key del plan ` +
              `'integration-flow'), que es el unico que puede invocar iFlows.`
          ),
          {
            hint:
              "Las tools de administracion usan el plan 'api'; invocar un endpoint necesita el plan " +
              "'integration-flow'. Son dos keys distintas del mismo tenant. Agregar el bloque " +
              '"runtime" al profile en systems.json.',
          }
        ),
        { tool: "cpi_invoke" }
      );
    }

    // El address se resuelve por el plano de administracion; la invocacion va por el de runtime.
    // De ahi sale tambien el Protocol, que decide el servlet (/http/ o /cxf/): sin el, un sender
    // SOAP se invoca por la ruta equivocada y contesta 404 el Tomcat, sin dejar rastro en el MPL.
    let address = a.address;
    let resolved = null;
    if (!address) {
      resolved = await resolveEndpoint(ctx.client, a.iflow);
      address = resolved.address;
    }

    const res = await ctx.runtime.invoke(address, {
      protocol: resolved?.protocol,
      method: a.method ?? "GET",
      body: a.body,
      contentType: a.contentType,
      headers: a.headers,
      timeoutMs: a.timeoutMs,
      maxBytes: a.maxBytes,
    });

    const blocks = [
      `${res.method} ${res.url}`,
      resolved
        ? `(address resuelto desde ServiceEndpoints para el iFlow "${a.iflow}"` +
          `${resolved.protocol ? `, Protocol=${resolved.protocol}` : ""})`
        : null,
      "",
      `HTTP ${res.status} ${res.statusText}  —  ${res.ms} ms`,
      res.contentType ? `content-type: ${res.contentType}` : null,
      res.csrfRetried ? "Se reintento con handshake CSRF del sender adapter (xsrfProtection=1)." : null,
    ].filter(Boolean);

    // El puente al monitor. Verificado el 2026-08-05, y es contraintuitivo: cuando el iFlow
    // FALLA el guid del MPL llega en el CUERPO del error, no en un header. Cuando sale bien no
    // llega de ninguna forma — el x-correlationid que si viene NO matchea ningun campo del MPL,
    // asi que no sirve para buscar. Ahi el unico camino es iFlow + ventana de tiempo.
    const mpl = res.correlation["sap-messageprocessinglogid"] ?? mplFromBody(res.body);
    blocks.push("");
    if (mpl) {
      blocks.push(
        `MessageProcessingLog: ${mpl}`,
        `Para la traza: cpi_message_detail(messageGuid="${mpl}")`
      );
    } else {
      blocks.push(
        `La respuesta no trae el guid del MessageProcessingLog. Para encontrar este run: ` +
          `cpi_messages(iflow="${a.iflow ?? "<el iFlow>"}", since="${res.startedAt}")`
      );
      if (Object.keys(res.correlation).length) {
        blocks.push(
          `(headers de correlacion: ${kv(res.correlation).replace(/\n/g, ", ")} — ` +
            `ojo, x-correlationid NO matchea el CorrelationId del MPL)`
        );
      }
    }

    blocks.push(
      "",
      `Respuesta (${res.bytes} bytes${res.truncated ? ", truncada" : ""}):`,
      res.body.length ? res.body : "(vacia)"
    );

    const nota = diagnose(res, a.iflow ?? address);
    if (nota) blocks.push("", nota);

    return ok(blocks.join("\n"));
  } catch (err) {
    return fail(err, { tool: "cpi_invoke" });
  }
}

/** El guid del MPL embebido en el cuerpo del error que devuelve el runtime. */
function mplFromBody(body) {
  const m = /MPL ID for the failed message is\s*:\s*([A-Za-z0-9_-]+)/i.exec(body ?? "");
  return m ? m[1] : null;
}

/**
 * La distincion que mas cuesta al leer un fallo: 401/403 son de autenticacion o del sender
 * adapter y el iFlow ni se ejecuto; un 500 en cambio suele ser el iFlow fallando de verdad,
 * y ahi el detalle esta en el MPL, no en el cuerpo de la respuesta.
 */
function diagnose(res, ref) {
  if (res.status === 401) {
    return (
      "401: el token de runtime fue rechazado. El iFlow NO se ejecuto, asi que no va a haber " +
      "nada en el monitor. Revisar la key del plan 'integration-flow'."
    );
  }
  if (res.status === 403) {
    return (
      "403: rechazado por el sender adapter, el iFlow NO se ejecuto. Dos causas posibles: el rol " +
      "del sender (senderAuthType=RoleBased con un userRole que la key no trae) o xsrfProtection=1 " +
      (res.csrfRetried
        ? "— el handshake CSRF ya se reintento y tambien fallo, asi que apunta al rol."
        : "en un metodo que modifica.")
    );
  }
  if (res.status === 404) {
    // Primera sospecha: el servlet. Un sender SOAP invocado por /http/ da exactamente esto —
    // 404 del Tomcat, sin MPL, con el iFlow perfectamente STARTED (verificado el 2026-08-27).
    const otro = /\/cxf\//.test(res.url) ? "/http/" : "/cxf/";
    return (
      "404: no hay nada escuchando en ese address. Tres causas, en orden de probabilidad: " +
      `(1) el servlet equivocado — se invoco por ${/\/cxf\//.test(res.url) ? "/cxf/" : "/http/"} y ` +
      `el sender puede estar bajo ${otro}: los senders SOAP van por /cxf/ y los HTTPS/REST por ` +
      `/http/, y el Protocol de ServiceEndpoints lo dice (cpi_deployed withEndpoints=true); ` +
      "(2) el artefacto no esta STARTED (cpi_deployed); " +
      "(3) el address no es el de ServiceEndpoints sino el Id del iFlow."
    );
  }
  if (res.status >= 500) {
    const mpl = mplFromBody(res.body);
    return (
      `HTTP ${res.status}: el iFlow se ejecuto y fallo adentro. El motivo real esta en el log, no ` +
      `en esta respuesta: ` +
      (mpl
        ? `cpi_message_detail(messageGuid="${mpl}").`
        : `cpi_messages(iflow="${ref}", status="FAILED").`) +
      ` Ojo: un 5xx tambien aparece cuando el backend al que llama el iFlow no responde — ` +
      `eso NO es un problema del iFlow.`
    );
  }
  return null;
}

export const definition = {
  name: "cpi_invoke",
  description:
    "EJECUTA UN IFLOW deployado invocando su endpoint HTTP, con la service key del plan " +
    "'integration-flow'. Cierra el ciclo de prueba: deployar -> invocar -> leer el log. " +
    "Con 'iflow' resuelve el address solo desde ServiceEndpoints, y de ahi tambien el servlet: " +
    "/http/ para un sender HTTPS/REST, /cxf/ para uno SOAP. Devuelve status, tiempo, cuerpo " +
    "y el id de MessageProcessingLog para saltar a la traza. Solo sirve para iFlows con sender " +
    "HTTP/SOAP: los disparados por timer, file, JMS o IDoc no exponen endpoint. " +
    "OJO: dispara efectos reales en los sistemas que el iFlow toque.",
  inputSchema,
  jsonSchema,
};
