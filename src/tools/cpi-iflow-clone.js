import { z } from "zod";
import { cloneArtifact } from "../core/ops/write.js";
import { artifactKinds } from "../core/ops/design.js";
import { ok, fail, kv } from "./_render.js";

const KINDS = artifactKinds();

export const inputSchema = z
  .object({
    sourceId: z.string().min(1),
    targetId: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9_]+$/, "El Id solo admite letras, numeros y guion bajo"),
    targetPackageId: z.string().min(1),
    targetName: z.string().optional(),
    sourceVersion: z.string().optional(),
    kind: z.enum(KINDS).optional(),
  })
  .strict();

export const jsonSchema = {
  type: "object",
  properties: {
    sourceId: {
      type: "string",
      description: "Id del artefacto que se usa de plantilla (ej un arquetipo 'ZARCH_SFTP').",
    },
    targetId: {
      type: "string",
      pattern: "^[A-Za-z0-9_]+$",
      description: "Id del artefacto nuevo. Solo letras, numeros y guion bajo. Debe no existir.",
    },
    targetPackageId: { type: "string", description: "Package donde se crea el artefacto nuevo." },
    targetName: { type: "string", description: "Nombre visible. Si se omite, se usa targetId." },
    sourceVersion: { type: "string", description: "Version de la plantilla. Default 'active'." },
    kind: {
      type: "string",
      enum: KINDS,
      description:
        "Tipo de artefacto: 'iflow' (default), 'mapping' (message mappings), " +
        "'script' (script collections) o 'valuemapping'. El origen y el destino son de la " +
        "misma familia: no se clona un mapping como iFlow.",
    },
  },
  required: ["sourceId", "targetId", "targetPackageId"],
  additionalProperties: false,
};

export async function handler(args, ctx) {
  try {
    const p = inputSchema.parse(args ?? {});
    const r = await cloneArtifact(ctx.client, p);

    const kind = p.kind ?? "iflow";
    const blocks = [
      `${kind === "iflow" ? "iFlow" : kind} "${r.Id}" creado a partir de "${r.sourceId}".`,
      "",
      kv({
        Id: r.Id,
        Name: p.targetName ?? p.targetId,
        Package: p.targetPackageId,
        Version: r.Version ?? "1.0.0",
        bundle: `${r.bytes} bytes`,
      }),
      "",
      `Archivos del bundle: ${r.files.join(", ")}`,
      "",
      "Se reescribieron MANIFEST.MF (Bundle-Name / Bundle-SymbolicName) y .project con el Id nuevo.",
    ];

    if (kind === "iflow") {
      blocks.push(
        "Siguientes pasos: cpi_iflow_read para ver los parametros externalizados, " +
          "cpi_iflow_configure para ajustarlos, cpi_iflow_validate antes de deployar."
      );
    } else {
      // La lista de arriba es lo que se SUBIO, no necesariamente lo que quedo guardado: en un
      // mapping el tenant renombra el .mmap al Id nuevo al ingerir el bundle (verificado
      // 2026-08-10). Por eso quien lo referencia lee la ruta real y no la deriva de ningun lado.
      blocks.push(
        `Esa es la lista de archivos que se subio. El tenant puede normalizarla al guardar: en un ` +
          `mapping renombra el .mmap al Id nuevo. Para ver como quedo de verdad, ` +
          `cpi_iflow_read(id="${r.Id}", kind="${kind}", includeContent=true). ` +
          `Despues: cpi_deploy(id="${r.Id}", kind="${kind}"). No hay Validate fuera del iFlow, ` +
          `asi que el deploy es la primera verificacion.`
      );
    }
    return ok(blocks.join("\n"));
  } catch (err) {
    return fail(err, { tool: "cpi_iflow_clone" });
  }
}

export const definition = {
  name: "cpi_iflow_clone",
  description:
    "ESCRIBE. Crea un artefacto nuevo clonando uno existente: descarga el bundle, reescribe el " +
    "MANIFEST.MF y el .project con el Id nuevo, y lo sube al package indicado. Con 'kind' sirve " +
    "para iFlows (default), message mappings, script collections y value mappings. Es la forma " +
    "recomendada de crear iFlows — generar el modelo BPMN desde cero no es viable porque el " +
    "manifiesto OSGi trae cientos de imports de Camel/CXF. Falla si el targetId ya existe.",
  inputSchema,
  jsonSchema,
};
