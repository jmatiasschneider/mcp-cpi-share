import { z } from "zod";
import { setConfiguration } from "../core/ops/write.js";
import { listConfigurations } from "../core/ops/design.js";
import { ok, fail, table } from "./_render.js";

export const inputSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().optional(),
    parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  })
  .strict();

export const jsonSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Id del iFlow a configurar." },
    version: { type: "string", description: "Version del artefacto. Default 'active'." },
    parameters: {
      type: "object",
      description:
        "Mapa de parametro -> valor, con las claves tal como las devuelve cpi_iflow_read " +
        "(ParameterKey). Ej: {\"Receiver_host\": \"sftp.example.com\"}.",
      additionalProperties: { type: ["string", "number", "boolean"] },
    },
  },
  required: ["id", "parameters"],
  additionalProperties: false,
};

export async function handler(args, ctx) {
  try {
    const { id, version = "active", parameters } = inputSchema.parse(args ?? {});
    const keys = Object.keys(parameters);
    if (!keys.length) return ok("No se indico ningun parametro para setear.");

    // Avisar antes de escribir si alguna clave no existe: OData no siempre falla claro
    const existing = await listConfigurations(ctx.client, id, { version }).catch(() => []);
    const known = new Set(existing.map((c) => c.ParameterKey));
    const unknown = keys.filter((k) => known.size && !known.has(k));

    const done = [];
    const failed = [];
    for (const [key, value] of Object.entries(parameters)) {
      try {
        await setConfiguration(ctx.client, { id, version, key, value });
        done.push({ ParameterKey: key, ParameterValue: String(value) });
      } catch (err) {
        failed.push({ ParameterKey: key, error: err.message });
      }
    }

    const blocks = [];
    if (done.length) blocks.push(`${done.length} parametro(s) actualizados en "${id}":`, table(done));
    if (unknown.length) {
      blocks.push(
        "",
        `AVISO: estas claves no figuran entre los parametros externalizados del iFlow: ` +
          `${unknown.join(", ")}. Claves validas: ${[...known].join(", ") || "(ninguna)"}.`
      );
    }
    if (failed.length) {
      blocks.push("", `${failed.length} fallaron:`, table(failed, ["ParameterKey", "error"]));
    }
    blocks.push("", "El cambio queda en designtime: hay que redeployar para que tome efecto.");

    const res = ok(blocks.join("\n"));
    return failed.length ? { ...res, isError: true } : res;
  } catch (err) {
    return fail(err, { tool: "cpi_iflow_configure" });
  }
}

export const definition = {
  name: "cpi_iflow_configure",
  description:
    "ESCRIBE. Setea los parametros externalizados (Configurations) de un iFlow: hosts, paths, " +
    "nombres de credenciales, direcciones de endpoint. Es la forma robusta de adaptar un iFlow " +
    "clonado, mucho mejor que editar el modelo BPMN. Los cambios quedan en designtime: hay que " +
    "redeployar para que tomen efecto.",
  inputSchema,
  jsonSchema,
};
