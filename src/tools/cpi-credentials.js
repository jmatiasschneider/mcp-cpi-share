import { z } from "zod";
import { listCredentialNames } from "../core/ops/runtime.js";
import { ok, fail, table } from "./_render.js";

export const inputSchema = z.object({}).strict();

export const jsonSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

export async function handler(args, ctx) {
  try {
    const rows = await listCredentialNames(ctx.client);
    if (!rows.length) return ok("El Security Material del tenant no tiene user credentials.");

    const text =
      `${rows.length} credencial(es) en el Security Material:\n\n` +
      table(rows, ["Name", "Kind", "User", "Description"]) +
      `\n\nSolo se listan nombres y metadata. Los secretos no se leen ni se devuelven nunca.`;
    return ok(text);
  } catch (err) {
    return fail(err, { tool: "cpi_credentials" });
  }
}

export const definition = {
  name: "cpi_credentials",
  description:
    "Lista los NOMBRES de las user credentials del Security Material del tenant, con su tipo y " +
    "usuario. Sirve para saber que alias existe para configurar un adapter. Nunca devuelve " +
    "contraseñas ni contenido de credenciales.",
  inputSchema,
  jsonSchema,
};
