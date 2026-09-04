import { z } from "zod";
import { listPackages } from "../core/ops/design.js";
import { ok, fail, table, paging } from "./_render.js";

export const inputSchema = z
  .object({
    top: z.number().int().min(1).max(500).optional(),
    skip: z.number().int().min(0).optional(),
  })
  .strict();

export const jsonSchema = {
  type: "object",
  properties: {
    top: {
      type: "integer",
      minimum: 1,
      maximum: 500,
      description: "Maximo de packages a devolver (default 100).",
    },
    skip: {
      type: "integer",
      minimum: 0,
      description: "Offset para paginar (default 0). La nota al pie indica el skip siguiente.",
    },
  },
  additionalProperties: false,
};

export async function handler(args, ctx) {
  try {
    const { top = 100, skip = 0 } = inputSchema.parse(args ?? {});
    const { rows, hasMore } = await listPackages(ctx.client, { top, skip });
    if (!rows.length) {
      return ok(
        skip > 0
          ? `No hay packages desde skip=${skip}. Proba con un skip menor.`
          : "El tenant no tiene integration packages."
      );
    }

    const text =
      `${rows.length} package(s) en ${ctx.label}:\n\n` +
      table(rows, ["Id", "Name", "Mode", "Version", "ModifiedBy", "ModifiedDate"]) +
      paging({ shown: rows.length, skip, hasMore }) +
      `\n\nMode=EDIT_ALLOWED son editables; READ_ONLY es contenido estandar de SAP.` +
      `\nPara ver los iFlows de uno, usar cpi_iflow_list con su Id.`;
    return ok(text);
  } catch (err) {
    return fail(err, { tool: "cpi_packages" });
  }
}

export const definition = {
  name: "cpi_packages",
  description:
    "Lista los integration packages del tenant con su Id, nombre, modo (editable o de solo " +
    "lectura) y ultima modificacion. Es el punto de entrada al contenido de diseño: el Id que " +
    "devuelve se usa en cpi_iflow_list.",
  inputSchema,
  jsonSchema,
};
