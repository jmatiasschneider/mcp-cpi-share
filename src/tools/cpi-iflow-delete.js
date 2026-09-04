import { z } from "zod";
import { deleteArtifact } from "../core/ops/write.js";
import { readArtifact, artifactKinds } from "../core/ops/design.js";
import { ok, fail } from "./_render.js";

const KINDS = artifactKinds();

export const inputSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(KINDS).optional(),
    version: z.string().optional(),
    confirm: z.literal(true),
  })
  .strict();

export const jsonSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Id del artefacto a borrar del designtime." },
    kind: {
      type: "string",
      enum: KINDS,
      description:
        "Tipo de artefacto: 'iflow' (default), 'mapping' (message mappings), " +
        "'script' (script collections) o 'valuemapping'.",
    },
    version: { type: "string", description: "Version del artefacto. Default 'active'." },
    confirm: {
      type: "boolean",
      enum: [true],
      description:
        "Debe ser true. Es una confirmacion explicita de que se quiere borrar el artefacto: " +
        "no lo pongas por tu cuenta, pediselo al usuario primero.",
    },
  },
  required: ["id", "confirm"],
  additionalProperties: false,
};

export async function handler(args, ctx) {
  try {
    const { id, kind = "iflow", version = "active" } = inputSchema.parse(args ?? {});

    // El chequeo previo va con el MISMO kind que el borrado: cada familia vive en su entity set,
    // y leer un mapping como iFlow da 404 — o sea "no existe" sobre algo que si existe.
    const meta = await readArtifact(ctx.client, id, { version, kind }).catch(() => null);
    if (!meta) {
      return ok(
        `No existe ningun artefacto de tipo "${kind}" con Id "${id}" en version "${version}". ` +
          `No se borro nada.` +
          (kind === "iflow"
            ? ` Si es un message mapping o una script collection, indicar el 'kind' correcto.`
            : "")
      );
    }

    await deleteArtifact(ctx.client, { id, version, kind });

    return ok(
      `${kind === "iflow" ? "iFlow" : kind} "${id}" (package ${meta.PackageId}) borrado del designtime.\n\n` +
        `Esto NO lo saca del runtime: si estaba deployado, sigue corriendo. ` +
        `Verificar con cpi_deployed.`
    );
  } catch (err) {
    return fail(err, { tool: "cpi_iflow_delete" });
  }
}

export const definition = {
  name: "cpi_iflow_delete",
  description:
    "ESCRIBE Y ES DESTRUCTIVO. Borra un artefacto del designtime del tenant: iFlows por default, " +
    "o message mappings / script collections / value mappings segun 'kind'. Requiere confirm=true " +
    "explicito. No saca el artefacto del runtime: si estaba deployado sigue corriendo. Pedir " +
    "confirmacion al usuario antes de llamarla.",
  inputSchema,
  jsonSchema,
};
