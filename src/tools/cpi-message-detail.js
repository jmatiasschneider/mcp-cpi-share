import { z } from "zod";
import { messageDetail } from "../core/ops/monitor.js";
import { ok, fail, table, kv } from "./_render.js";

export const inputSchema = z
  .object({
    messageGuid: z.string().min(1),
    includeSteps: z.boolean().optional(),
  })
  .strict();

export const jsonSchema = {
  type: "object",
  properties: {
    messageGuid: {
      type: "string",
      description: "MessageGuid del mensaje, tal como lo devuelve cpi_messages.",
    },
    includeSteps: {
      type: "boolean",
      description:
        "Incluir la traza paso a paso de cada run (RunSteps). Default true. Ponerlo en false " +
        "si solo interesa el error.",
    },
  },
  required: ["messageGuid"],
  additionalProperties: false,
};

export async function handler(args, ctx) {
  try {
    const { messageGuid, includeSteps = true } = inputSchema.parse(args ?? {});
    const d = await messageDetail(ctx.client, messageGuid, { includeSteps });
    if (!d) return ok(`No existe un mensaje con MessageGuid "${messageGuid}".`);

    const blocks = [`Mensaje ${messageGuid}`, "", kv(d.header)];

    if (d.error) {
      blocks.push("", "ERROR:", kv(d.error));
      if (d.errorText) blocks.push("", "Detalle del error:", String(d.errorText).slice(0, 4000));
    } else {
      blocks.push("", "Sin informacion de error (el mensaje no fallo).");
    }

    if (d.adapterAttributes.length) {
      blocks.push("", "Atributos del adapter:", table(d.adapterAttributes));
    }
    if (d.customHeaders.length) {
      blocks.push("", "Custom headers:", table(d.customHeaders));
    }

    if (d.runs.length) {
      blocks.push("", `Runs (${d.runs.length}):`);
      for (const run of d.runs) {
        blocks.push(
          `  run ${run.Id} — ${run.OverallState ?? "?"} — LogLevel=${run.LogLevel ?? "?"}`
        );
        if (run.steps?.length) {
          blocks.push(
            table(
              run.steps.map((s) => ({
                paso: s.StepId ?? s.Id,
                estado: s.Status ?? s.State ?? "",
                inicio: s.StepStart,
              })),
              ["paso", "estado", "inicio"]
            )
          );
        } else if (includeSteps) {
          blocks.push(
            "    (sin RunSteps: el iFlow corrio con LogLevel bajo. Para ver la traza completa " +
              "hay que subir el log level a Trace ANTES de ejecutarlo.)"
          );
        }
      }
    }

    return ok(blocks.join("\n"));
  } catch (err) {
    return fail(err, { tool: "cpi_message_detail" });
  }
}

export const definition = {
  name: "cpi_message_detail",
  description:
    "Detalle completo de un mensaje procesado: cabecera, texto del error si fallo, atributos del " +
    "adapter, custom headers y la traza de runs con sus pasos. Es la tool de diagnostico: " +
    "primero cpi_messages para encontrar el MessageGuid, despues esta.",
  inputSchema,
  jsonSchema,
};
