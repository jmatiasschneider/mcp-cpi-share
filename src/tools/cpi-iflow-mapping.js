import { z } from "zod";
import { referenceMapping, listMappingSteps } from "../core/ops/write.js";
import { ok, fail, kv, table } from "./_render.js";

export const inputSchema = z
  .object({
    iflowId: z.string().min(1),
    mappingId: z.string().min(1).optional(),
    step: z.string().min(1).optional(),
    version: z.string().optional(),
    mappingVersion: z.string().optional(),
  })
  .strict();

export const jsonSchema = {
  type: "object",
  properties: {
    iflowId: { type: "string", description: "Id del iFlow que va a usar el mapping." },
    mappingId: {
      type: "string",
      description:
        "Id del message mapping del package a referenciar. Si se omite, la tool NO escribe: " +
        "solo lista los pasos de mapping del iFlow y a que apuntan hoy.",
    },
    step: {
      type: "string",
      description:
        "Que paso del modelo enganchar, por Id ('CallActivity_7') o por nombre ('Message " +
        "Mapping 1'). Hace falta solo si el iFlow tiene mas de un paso de mapping.",
    },
    version: { type: "string", description: "Version del iFlow. Default 'active'." },
    mappingVersion: { type: "string", description: "Version del mapping. Default 'active'." },
  },
  required: ["iflowId"],
  additionalProperties: false,
};

export async function handler(args, ctx) {
  try {
    const {
      iflowId,
      mappingId,
      step,
      version = "active",
      mappingVersion = "active",
    } = inputSchema.parse(args ?? {});

    // Sin mappingId es el modo consulta: mirar antes de escribir, que es lo que hace falta
    // cuando el iFlow tiene varios pasos y hay que decidir cual.
    if (!mappingId) {
      const { iflw, steps } = await listMappingSteps(ctx.client, { id: iflowId, version });
      if (!steps.length) {
        return ok(
          `El modelo de "${iflowId}" (${iflw}) no tiene ningun paso de Message Mapping.\n\n` +
            `La referencia se pone sobre un paso que ya existe: el arquetipo tiene que traerlo. ` +
            `Agregar el paso desde cero es editar el BPMN, y eso no lo hace este MCP.`
        );
      }
      return ok(
        `${steps.length} paso(s) de mapping en "${iflowId}" (${iflw}):\n\n` +
          table(steps, ["id", "name", "mappingType", "mappingname", "messageMappingBundleId"]) +
          `\n\nPara enganchar uno: cpi_iflow_mapping(iflowId="${iflowId}", mappingId="<Id>"` +
          (steps.length > 1 ? `, step="${steps[0].id}"` : "") +
          `).`
      );
    }

    const r = await referenceMapping(ctx.client, {
      iflowId,
      version,
      mappingId,
      mappingVersion,
      step,
    });

    const blocks = [
      `Paso "${r.step.name}" (${r.step.id}) de "${iflowId}" apuntado al mapping "${mappingId}".`,
      "",
      kv(r.values),
      "",
      `Se escribieron dos archivos del bundle: ${r.iflw} y META-INF/MANIFEST.MF` +
        (r.manifestChanged
          ? " (Require-Capability agregado)."
          : " (el manifiesto ya declaraba esa dependencia)."),
    ];

    if (r.agregadas.length) {
      blocks.push(
        "",
        `Propiedades que el paso no tenia y se agregaron: ${r.agregadas.join(", ")}.`
      );
    }
    if (r.before.messageMappingBundleId && r.before.messageMappingBundleId !== mappingId) {
      blocks.push(
        "",
        `⚠️ El paso apuntaba antes a "${r.before.messageMappingBundleId}". Esa referencia se piso.`
      );
    }

    // El orden importa y no se puede inferir del resultado: el runtime resuelve la referencia
    // al arrancar el iFlow, asi que un mapping sin deployar da un iFlow que no levanta.
    blocks.push(
      "",
      `El cambio quedo en el DISEÑO. Para que corra, en ESTE orden:`,
      `  1. cpi_deploy(id="${mappingId}", kind="mapping")   ← el mapping primero`,
      `  2. cpi_iflow_validate(id="${iflowId}")`,
      `  3. cpi_deploy(id="${iflowId}")`,
      "",
      `Deployar el iFlow no deploya el mapping que referencia: no hay auto-deploy.`
    );

    return ok(blocks.join("\n"));
  } catch (err) {
    return fail(err, { tool: "cpi_iflow_mapping" });
  }
}

export const definition = {
  name: "cpi_iflow_mapping",
  description:
    "ESCRIBE. Engancha un message mapping del package a un paso de un iFlow, por referencia (el " +
    ".mmap no se copia adentro del iFlow). Toca los dos archivos que hacen falta: las propiedades " +
    "del paso en el .iflw y el header Require-Capability del MANIFEST.MF — con uno solo el bundle " +
    "OSGi no declara la dependencia y el iFlow falla al resolver el mapping. Sin 'mappingId' no " +
    "escribe nada: lista los pasos de mapping del iFlow y a que apuntan hoy. El mapping tiene que " +
    "deployarse ANTES que el iFlow.",
  inputSchema,
  jsonSchema,
};
