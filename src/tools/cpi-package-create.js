import { z } from "zod";
import { createPackage } from "../core/ops/design.js";
import { ok, fail, kv } from "./_render.js";

export const inputSchema = z
  .object({
    // ⚠️ Mas estricto que el Id de un ARTEFACTO, que si admite guion bajo (`zz_clone_probe`
    // existe). Verificado el 2026-08-11: `ZZ_PKG_PROBE` devuelve
    // `400 — Property 'Id' value cannot have a special character`.
    id: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9]+$/, "El Id de un package solo admite letras y numeros, sin guion bajo"),
    name: z.string().min(1).optional(),
    shortText: z.string().min(1).optional(),
    description: z.string().optional(),
    version: z.string().min(1).optional(),
  })
  .strict();

export const jsonSchema = {
  type: "object",
  properties: {
    id: {
      type: "string",
      pattern: "^[A-Za-z0-9]+$",
      description:
        "Id del package nuevo. Solo letras y numeros: a diferencia del Id de un iFlow, el " +
        "tenant rechaza el guion bajo con un 400. Debe no existir: no permite duplicados.",
    },
    name: { type: "string", description: "Nombre visible. Si se omite, se usa el id." },
    shortText: {
      type: "string",
      description:
        "Descripcion corta, la que la UI muestra en la tarjeta del package. Si se omite, se " +
        "usa el nombre.",
    },
    description: { type: "string", description: "Descripcion larga. Opcional." },
    version: { type: "string", description: "Version del package. Default '1.0.0'." },
  },
  required: ["id"],
  additionalProperties: false,
};

export async function handler(args, ctx) {
  try {
    const p = inputSchema.parse(args ?? {});
    const r = await createPackage(ctx.client, p);

    return ok(
      [
        `Package "${r.Id}" creado en ${ctx.label}.`,
        "",
        kv(r, ["Id", "Name", "ShortText", "Description", "Version", "Mode", "CreatedBy"]),
        "",
        `Queda vacio. Para poner artefactos adentro: cpi_iflow_clone con ` +
          `targetPackageId="${r.Id}".`,
      ].join("\n")
    );
  } catch (err) {
    // Un Id duplicado llega como 500 con el motivo adentro del mensaje, no como 409. El hint
    // generico del 500 ya dice "puede ser un Id que ya existe"; aca se afirma cuando el tenant
    // lo dijo, para no mandar a diagnosticar algo que ya esta diagnosticado.
    if (err?.status === 500 && /exist|duplicate|already/i.test(err.message ?? "")) {
      err.hint = `Ya hay un package con ese Id. Verificarlo con cpi_packages y elegir otro.`;
    }
    return fail(err, { tool: "cpi_package_create" });
  }
}

export const definition = {
  name: "cpi_package_create",
  description:
    "ESCRIBE. Crea un integration package vacio en el tenant. Hace falta porque todo artefacto " +
    "nuevo tiene que nacer dentro de un package que ya exista: sin esto, el package se crea a " +
    "mano en la UI antes de poder clonar nada. No copia contenido de otro package — para eso " +
    "se clonan los artefactos uno por uno con cpi_iflow_clone.",
  inputSchema,
  jsonSchema,
};
