import { z } from "zod";
import { listMessages, MPL_STATUS } from "../core/ops/monitor.js";
import { ok, fail, table, paging } from "./_render.js";

export const inputSchema = z
  .object({
    status: z.enum(MPL_STATUS).optional(),
    iflow: z.string().optional(),
    since: z.string().optional(),
    top: z.number().int().min(1).max(100).optional(),
    skip: z.number().int().min(0).optional(),
  })
  .strict();

export const jsonSchema = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: MPL_STATUS,
      description: "Filtra por estado del mensaje. FAILED es el habitual para diagnosticar.",
    },
    iflow: {
      type: "string",
      description: "Filtra por nombre exacto del iFlow (campo IntegrationFlowName).",
    },
    since: {
      type: "string",
      description: "Solo mensajes con LogEnd posterior a esta fecha ISO, ej '2026-07-30T00:00:00Z'.",
    },
    top: { type: "integer", minimum: 1, maximum: 100, description: "Cuantos traer (default 20)." },
    skip: { type: "integer", minimum: 0, description: "Offset para paginar (default 0)." },
  },
  additionalProperties: false,
};

export async function handler(args, ctx) {
  try {
    const p = inputSchema.parse(args ?? {});
    const top = p.top ?? 20;
    const skip = p.skip ?? 0;

    const { rows, total } = await listMessages(ctx.client, { ...p, top, skip });
    if (!rows.length) {
      return ok(
        total > 0
          ? `No hay mensajes desde skip=${skip} (el filtro da ${total} en total).`
          : "No hay mensajes que cumplan el filtro." +
              (p.since ? " Probar con un rango de fechas mas amplio." : "")
      );
    }

    const text =
      `${rows.length} mensaje(s):\n\n` +
      table(rows, ["LogEnd", "Status", "IntegrationFlowName", "MessageGuid"]) +
      paging({ shown: rows.length, skip, total }) +
      `\n\nPara el detalle de uno (error, pasos, atributos) usar cpi_message_detail con su MessageGuid.`;
    return ok(text);
  } catch (err) {
    return fail(err, { tool: "cpi_messages" });
  }
}

export const definition = {
  name: "cpi_messages",
  description:
    "Monitor de mensajes procesados (MessageProcessingLogs). Filtra por estado, iFlow y fecha; " +
    "ordena del mas reciente al mas viejo y pagina. Usar para responder 'que fallo', 'corrio el " +
    "iFlow X' o 'que paso hoy'. Devuelve pocos registros por default: esta entidad tiene rate " +
    "limits y payloads grandes.",
  inputSchema,
  jsonSchema,
};
