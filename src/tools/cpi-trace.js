import { z } from "zod";
import { traceRun } from "../core/ops/monitor.js";
import { ok, fail, kv } from "./_render.js";

export const inputSchema = z
  .object({
    messageGuid: z.string().min(1),
    step: z.string().min(1).optional(),
    runId: z.string().min(1).optional(),
    maxBytes: z.number().int().min(100).max(200000).optional(),
  })
  .strict();

export const jsonSchema = {
  type: "object",
  properties: {
    messageGuid: {
      type: "string",
      description: "MessageGuid del mensaje, tal como lo devuelve cpi_messages.",
    },
    step: {
      type: "string",
      description:
        "Filtra a los pasos cuyo ModelStepId o StepId contenga este texto (ej 'Mapping'). " +
        "Sirve para pedir el payload de un solo paso con un maxBytes alto.",
    },
    runId: {
      type: "string",
      description:
        "Limita a un run puntual. Por default se recorren todos los runs del mensaje, que " +
        "normalmente es uno solo.",
    },
    maxBytes: {
      type: "integer",
      minimum: 100,
      maximum: 200000,
      description:
        "Maximo de caracteres a mostrar POR payload (default 2000). Subirlo junto con 'step' " +
        "para ver un mensaje entero sin volcar los de todos los pasos.",
    },
  },
  required: ["messageGuid"],
  additionalProperties: false,
};

/** El bloque que explica que el Trace se prende a mano. Se repite en dos caminos distintos. */
const COMO_PRENDER_TRACE =
  "Para que haya payloads, el iFlow tiene que correr con LogLevel=Trace, y eso se prende A MANO\n" +
  "en la UI: Monitor -> Manage Integration Content -> el iFlow -> Log Level = Trace.\n" +
  "No hay API para pedirlo. Caduca solo (~1 h) y NO es retroactivo: hay que prenderlo y volver a\n" +
  "ejecutar, porque los runs anteriores no se recuperan.";

/**
 * El caso traicionero: el run SI corrio en TRACE y aun asi no hay una sola traza.
 *
 * Verificado el 2026-08-11 contra el tenant: un run de 10 pasos con LogLevel=TRACE, 12 h despues
 * devuelve `200 {"d":{"results":[]}}` en TraceMessages para todos sus pasos. O sea que el payload
 * se retiene menos que el MPL, y cuando se va **la navegacion no falla**: contesta vacio, igual
 * que un paso que de verdad no llevaba cuerpo.
 *
 * Sin esta nota, "sin TraceMessages" en los diez pasos se lee como "el mensaje iba vacio", que es
 * la conclusion equivocada y ademas dificil de desmentir.
 */
const TRAZAS_CADUCADAS =
  "⚠ El run corrio en TRACE pero no quedo ninguna traza: los payloads ya no estan.\n" +
  "El payload se guarda por una ventana corta y se purga antes que el MPL, asi que un run viejo\n" +
  "queda marcado TRACE sin contenido. La navegacion no avisa: devuelve 200 con lista vacia.\n" +
  "Para ver payloads hay que prender Trace y volver a ejecutar; lo de antes no se recupera.";

function renderTrace(t) {
  const b = [];
  const mm = t.size === null ? "" : `${t.size} bytes`;
  b.push(
    `    TraceId=${t.traceId}${t.mimeType ? `  ${t.mimeType}` : ""}${mm ? `  ${mm}` : ""}` +
      (t.truncated ? `  (recortado)` : "")
  );
  if (t.note) b.push(`      ${t.note}`);
  if (t.text) {
    b.push(
      t.text
        .split("\n")
        .map((l) => `      ${l}`)
        .join("\n")
    );
  }
  return b.join("\n");
}

export async function handler(args, ctx) {
  try {
    const { messageGuid, step, runId, maxBytes = 2000 } = inputSchema.parse(args ?? {});
    const d = await traceRun(ctx.client, messageGuid, { step, runId, maxBytes });
    if (!d) return ok(`No existe un mensaje con MessageGuid "${messageGuid}".`);

    const blocks = [`Trace del mensaje ${messageGuid}`, "", kv(d.header)];

    if (!d.runs.length) {
      blocks.push(
        "",
        runId
          ? `El mensaje no tiene un run con Id "${runId}".`
          : "El mensaje no tiene runs, asi que no hay pasos que trazar."
      );
      return ok(blocks.join("\n"));
    }

    for (const run of d.runs) {
      blocks.push(
        "",
        `run ${run.id} — ${run.overallState ?? "?"} — LogLevel=${run.logLevel ?? "?"}`
      );

      if (!run.steps.length) {
        blocks.push(
          step
            ? `  (ningun paso matchea "${step}"; el run tiene ${d.filteredOut} paso(s))`
            : "  (el run no tiene RunSteps)"
        );
        continue;
      }

      for (const s of run.steps) {
        const etiqueta = s.modelStepId ?? s.stepId ?? "?";
        const detalle = [s.stepId && s.stepId !== etiqueta ? s.stepId : null, s.status]
          .filter(Boolean)
          .join(" — ");
        blocks.push(`  ${etiqueta}${detalle ? ` (${detalle})` : ""}`);

        if (s.note) blocks.push(`    ${s.note}`);
        else if (!s.traces.length) blocks.push("    sin TraceMessages");
        else for (const t of s.traces) blocks.push(renderTrace(t));
      }
    }

    // Cero payloads tiene DOS causas distintas y el remedio es el mismo, pero el diagnostico no:
    // o el run no corrio en Trace, o corrio y las trazas ya se purgaron. Decir la equivocada
    // manda a revisar una configuracion que en realidad estaba bien.
    const pasos = d.runs.reduce((n, r) => n + r.steps.length, 0);
    const trazas = d.runs.reduce(
      (n, r) => n + r.steps.reduce((m, s) => m + s.traces.length, 0),
      0
    );

    if (!d.tracedRuns) {
      blocks.push(
        "",
        `⚠ Ningun run corrio con LogLevel=TRACE, asi que arriba no hay payloads.`,
        COMO_PRENDER_TRACE
      );
    } else if (!trazas && pasos) {
      blocks.push("", TRAZAS_CADUCADAS);
    }

    return ok(blocks.join("\n"));
  } catch (err) {
    return fail(err, { tool: "cpi_trace" });
  }
}

export const definition = {
  name: "cpi_trace",
  description:
    "Payload del mensaje en cada paso de un run: el contenido crudo que entro y salio de cada " +
    "step, no solo la lista de pasos. Es la tool para cuando un iFlow completa bien pero " +
    "devuelve datos equivocados, tipicamente un mapping. Requiere que el iFlow haya corrido con " +
    "LogLevel=Trace, que se prende a mano en la UI y no es retroactivo. Para la cabecera y el " +
    "error usar cpi_message_detail; esta es el nivel de abajo.",
  inputSchema,
  jsonSchema,
};
