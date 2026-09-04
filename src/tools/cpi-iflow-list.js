import { z } from "zod";
import { listArtifacts } from "../core/ops/design.js";
import { ok, fail, table, paging } from "./_render.js";

import { artifactKinds } from "../core/ops/design.js";

const KINDS = artifactKinds();

export const inputSchema = z
  .object({
    packageId: z.string().min(1),
    kind: z.enum(KINDS).optional(),
    top: z.number().int().min(1).max(200).optional(),
    skip: z.number().int().min(0).optional(),
  })
  .strict();

export const jsonSchema = {
  type: "object",
  properties: {
    packageId: {
      type: "string",
      description: "Id del integration package (el que devuelve cpi_packages, ej 'DEVtest').",
    },
    kind: {
      type: "string",
      enum: KINDS,
      description:
        "Tipo de artefacto: 'iflow' (default), 'mapping' (message mappings), " +
        "'script' (script collections) o 'valuemapping'.",
    },
    top: {
      type: "integer",
      minimum: 1,
      maximum: 200,
      description: "Maximo de artefactos a devolver (default 50).",
    },
    skip: {
      type: "integer",
      minimum: 0,
      description: "Offset para paginar (default 0). La nota al pie indica el skip siguiente.",
    },
  },
  required: ["packageId"],
  additionalProperties: false,
};

export async function handler(args, ctx) {
  try {
    const { packageId, kind = "iflow", top = 50, skip = 0 } = inputSchema.parse(args ?? {});
    const { rows, total } = await listArtifacts(ctx.client, packageId, { kind, top, skip });
    if (!rows.length) {
      return ok(
        total > 0
          ? `No hay artefactos de tipo ${kind} desde skip=${skip} (el package tiene ${total}).`
          : `El package "${packageId}" no tiene artefactos de tipo ${kind}.`
      );
    }

    const text =
      `${rows.length} ${kind}(s) en el package "${packageId}":\n\n` +
      table(rows, ["Id", "Name", "Version", "ModifiedBy", "ModifiedAt"]) +
      paging({ shown: rows.length, skip, total }) +
      // El kind viaja en el hint: cada familia vive en su propio entity set, y pedir un
      // mapping como si fuera un iFlow da 404.
      `\n\nPara ver el detalle o el contenido de uno: ` +
      `cpi_iflow_read(id="${rows[0].Id}"${kind === "iflow" ? "" : `, kind="${kind}"`}).`;
    return ok(text);
  } catch (err) {
    return fail(err, { tool: "cpi_iflow_list" });
  }
}

export const definition = {
  name: "cpi_iflow_list",
  description:
    "Lista los artefactos de diseño de un integration package: iFlows por default, o message " +
    "mappings / script collections / value mappings segun 'kind'. Requiere el packageId que " +
    "devuelve cpi_packages — estos artefactos no se pueden consultar sin indicar el package.",
  inputSchema,
  jsonSchema,
};
