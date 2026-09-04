/**
 * ops/monitor — message processing logs, runs y trazas.
 *
 * MessageProcessingLogs es uno de los pocos entity sets consultables de primer nivel.
 * Todo el detalle (Runs, RunSteps, errores, adjuntos) cuelga por navegacion.
 *
 * OJO: payloads grandes y rate limits. Siempre limitar y paginar.
 */

import { clean, odataQuote, isBinary } from "../client.js";

const MPL_FIELDS = [
  "MessageGuid",
  "CorrelationId",
  "ApplicationMessageId",
  "ApplicationMessageType",
  "IntegrationFlowName",
  "IntegrationArtifact",
  "Status",
  "CustomStatus",
  "LogLevel",
  "LogStart",
  "LogEnd",
  "Sender",
  "Receiver",
  "TransactionId",
  "AlternateWebLink",
];

/** Estados validos segun el monitor de CPI. */
export const MPL_STATUS = [
  "COMPLETED",
  "FAILED",
  "PROCESSING",
  "RETRY",
  "CANCELLED",
  "ESCALATED",
  "DISCARDED",
  "ABANDONED",
];

/**
 * Lista mensajes con filtros. Todos opcionales.
 * @param {{status?: string, iflow?: string, since?: string, top?: number, skip?: number}} o
 */
export async function listMessages(client, { status, iflow, since, top = 20, skip = 0 } = {}) {
  const filters = [];
  if (status) filters.push(`Status eq '${odataQuote(status)}'`);
  if (iflow) filters.push(`IntegrationFlowName eq '${odataQuote(iflow)}'`);
  if (since) {
    const d = new Date(since);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`"since" no es una fecha valida: ${since}. Usar ISO, ej 2026-07-30T00:00:00Z`);
    }
    // OData v2: literal datetime, sin comillas simples
    filters.push(`LogEnd ge datetime'${d.toISOString().replace(/\.\d{3}Z$/, "")}'`);
  }

  const qs = [
    `$top=${Math.min(top, 100)}`,
    skip ? `$skip=${skip}` : null,
    `$orderby=LogEnd desc`,
    // Esta entidad SI soporta $inlinecount (IntegrationPackages no: da 501). Con el total
    // exacto la paginacion deja de ser una adivinanza.
    `$inlinecount=allpages`,
    filters.length ? `$filter=${encodeURIComponent(filters.join(" and "))}` : null,
  ]
    .filter(Boolean)
    .join("&");

  const { json, rows } = await client.get(`MessageProcessingLogs?${qs}`);
  const total = Number(json?.d?.__count);

  return {
    rows: rows.map((r) => clean(r, { fields: MPL_FIELDS })),
    total: Number.isFinite(total) ? total : null,
  };
}

/**
 * Detalle completo de un mensaje: cabecera + error + runs/steps + atributos.
 * Cada navegacion se pide por separado y los fallos parciales no tumban el resto:
 * un mensaje OK devuelve 204 en ErrorInformation, y eso es normal.
 */
export async function messageDetail(client, guid, { includeSteps = true } = {}) {
  const key = `MessageProcessingLogs('${odataQuote(guid)}')`;

  const { rows } = await client.get(key);
  if (!rows.length) return null;
  const header = clean(rows[0], { fields: MPL_FIELDS });

  const out = { header, error: null, runs: [], adapterAttributes: [], customHeaders: [] };

  const soft = async (path, fn) => {
    try {
      const r = await client.get(path);
      return fn(r);
    } catch {
      return null; // una navegacion que falla no invalida el resto del detalle
    }
  };

  out.error = await soft(`${key}/ErrorInformation`, (r) =>
    r.rows.length ? clean(r.rows[0]) : null
  );

  // El texto largo del error vive en un sub-recurso aparte y viene como text/plain:
  // hay que pedirlo crudo, porque intentar parsearlo como JSON falla.
  if (out.error) {
    try {
      const buf = await client.request("GET", `${key}/ErrorInformation/$value`, {
        raw: true,
        headers: { Accept: "text/plain" },
      });
      const txt = Buffer.isBuffer(buf) ? buf.toString("utf8").trim() : "";
      out.errorText = txt || null;
    } catch {
      out.errorText = null;
    }
  }

  out.adapterAttributes = (await soft(`${key}/AdapterAttributes`, (r) => r.rows.map(clean))) ?? [];
  out.customHeaders = (await soft(`${key}/CustomHeaderProperties`, (r) => r.rows.map(clean))) ?? [];

  const runs = (await soft(`${key}/Runs`, (r) => r.rows.map(clean))) ?? [];
  out.runs = runs;

  if (includeSteps) {
    for (const run of runs) {
      run.steps =
        (await soft(`MessageProcessingLogRuns('${odataQuote(run.Id)}')/RunSteps`, (r) =>
          r.rows.map(clean)
        )) ?? [];
    }
  }

  return out;
}

// --- payloads por paso (trace) ----------------------------------------------

/**
 * Recorta la key compuesta de un RunStep desde su `__metadata.uri`.
 *
 * La key **no se arma a ojo**: es compuesta y el orden de sus campos lo decide SAP. Cada fila
 * de `RunSteps` ya la trae armada y escapada dentro del uri absoluto, asi que se recorta desde
 * el nombre del entity set y se usa tal cual.
 *
 * Devuelve null si el uri no sirve, que es lo que deja al llamador decir "no se puede navegar"
 * en vez de mandar una URL rota.
 */
export function runStepKey(uri) {
  if (typeof uri !== "string") return null;
  const i = uri.indexOf("MessageProcessingLogRunSteps");
  return i < 0 ? null : uri.slice(i);
}

/** El filtro de paso matchea contra el id del modelo o el del step, sin distinguir mayusculas. */
function matchesStep(needle, ...ids) {
  const n = String(needle).toLowerCase();
  return ids.some((v) => v && String(v).toLowerCase().includes(n));
}

/**
 * Baja el payload de UN TraceMessage.
 *
 * Dos cosas que no son obvias y estan verificadas contra el tenant (DISCOVERY):
 *  - la key es `Edm.Int64`, asi que el literal **necesita el sufijo `L`**: `TraceMessages(104L)`.
 *  - el `MimeType` viene `application/octet-stream` aunque el contenido sea XML, asi que para
 *    decidir si se puede mostrar como texto se mira el contenido, no el header.
 */
async function fetchTrace(client, t, { maxBytes, maxDownload }) {
  const declarado = Number(t.PayloadSize);
  const info = {
    traceId: t.TraceId ?? null,
    mimeType: t.MimeType ?? null,
    size: Number.isFinite(declarado) ? declarado : null,
    text: "",
    binary: false,
    truncated: false,
    note: null,
  };

  if (!/^\d+$/.test(String(info.traceId))) {
    info.note = `TraceId inesperado (${info.traceId}): no se puede armar el literal Edm.Int64`;
    return info;
  }
  if (info.size === 0) {
    // Es normal y no es un fallo: en un mismo run conviven trazas con cuerpo y sin el, segun
    // el punto del flujo. Un GET no lleva nada de entrada, y un paso que fallo antes de producir
    // salida tampoco.
    info.note = "0 bytes — ese punto del flujo no tiene cuerpo";
    return info;
  }
  if (Number.isFinite(declarado) && declarado > maxDownload) {
    info.note = `${declarado} bytes: no se descarga (limite ${maxDownload}).`;
    return info;
  }

  let buf;
  try {
    buf = await client.get(`TraceMessages(${info.traceId}L)/$value`, { raw: true });
  } catch (err) {
    info.note = `$value fallo: ${err.message}`;
    return info;
  }

  info.size = buf.length;
  info.binary = isBinary(buf);
  if (info.binary) {
    info.note = "contenido binario: no se vuelca";
    return info;
  }

  const txt = buf.toString("utf8");
  info.text = txt.slice(0, maxBytes);
  info.truncated = txt.length > maxBytes;
  return info;
}

/**
 * Payload de cada paso de un mensaje: la cadena completa hasta el contenido crudo.
 *
 * ```
 * MessageProcessingLogs('<guid>')/Runs
 *   -> MessageProcessingLogRuns('<runId>')/RunSteps
 *     -> MessageProcessingLogRunSteps(<key compuesta>)/TraceMessages
 *       -> TraceMessages(<id>L)/$value
 * ```
 *
 * ⚠️ **Solo hay payload si el run corrio con `LogLevel=Trace`**, y eso se prende A MANO en la UI
 * (Monitor -> Manage Integration Content -> el iFlow -> Log Level). Caduca solo en ~1 h y **no es
 * retroactivo**: esta funcion lee un run que ya corrio en Trace, no lo puede pedir. Por eso
 * devuelve `tracedRuns`, para que el llamador distinga "no hubo payload" de "no hubo Trace".
 *
 * Los fallos parciales no tumban el resto: un paso sin TraceMessages se marca y se sigue.
 */
export async function traceRun(
  client,
  guid,
  { runId = null, step = null, maxBytes = 2000, maxDownload = 2_000_000 } = {}
) {
  const key = `MessageProcessingLogs('${odataQuote(guid)}')`;

  const { rows } = await client.get(key);
  if (!rows.length) return null;

  const out = {
    header: clean(rows[0], { fields: MPL_FIELDS }),
    runs: [],
    tracedRuns: 0,
    filteredOut: 0,
  };

  const soft = async (path, dflt) => {
    try {
      return (await client.get(path)).rows;
    } catch {
      return dflt;
    }
  };

  const todos = await soft(`${key}/Runs`, []);
  const runs = runId ? todos.filter((r) => String(r.Id) === String(runId)) : todos;

  for (const raw of runs) {
    const run = {
      id: raw.Id,
      logLevel: raw.LogLevel ?? null,
      overallState: raw.OverallState ?? null,
      steps: [],
    };
    if (String(run.logLevel).toUpperCase() === "TRACE") out.tracedRuns++;

    // Aca SI hacen falta las filas crudas: `clean()` tira `__metadata`, que es de donde sale
    // la key del step.
    const stepRows = await soft(
      `MessageProcessingLogRuns('${odataQuote(run.id)}')/RunSteps`,
      []
    );

    for (const s of stepRows) {
      if (step && !matchesStep(step, s.ModelStepId, s.StepId)) {
        out.filteredOut++;
        continue;
      }

      const entry = {
        modelStepId: s.ModelStepId ?? null,
        stepId: s.StepId ?? null,
        status: s.Status ?? s.State ?? null,
        start: s.StepStart ?? null,
        traces: [],
        note: null,
      };

      const stepKey = runStepKey(s.__metadata?.uri);
      if (!stepKey) {
        entry.note = "sin __metadata.uri: no se puede navegar a sus TraceMessages";
        run.steps.push(entry);
        continue;
      }

      let traceRows;
      try {
        traceRows = (await client.get(`${stepKey}/TraceMessages`)).rows;
      } catch (err) {
        entry.note = `TraceMessages: ${err.message}`;
        run.steps.push(entry);
        continue;
      }

      for (const t of traceRows) {
        entry.traces.push(await fetchTrace(client, t, { maxBytes, maxDownload }));
      }
      run.steps.push(entry);
    }

    out.runs.push(run);
  }

  return out;
}
