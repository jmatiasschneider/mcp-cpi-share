import { z } from "zod";
import { ping } from "../core/ops/runtime.js";
import { ok, fail, kv } from "./_render.js";

export const inputSchema = z.object({}).strict();

export const jsonSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

export async function handler(args, ctx) {
  try {
    const r = await ping(ctx.client);
    const text = [
      kv({
        profile: ctx.profile,
        tenant: ctx.label,
        api: r.apiBase,
        latencia: `${r.ms} ms`,
        entitySets: r.entitySets ?? "(no leidos)",
        policy: ctx.policy,
        escritura: r.canWrite ? "el token TIENE scopes de escritura/deploy" : "solo lectura",
      }),
      "",
      `scopes (${r.scopes.length}):`,
      ...r.scopes.map((s) => `  - ${s}`),
    ].join("\n");
    return ok(text);
  } catch (err) {
    return fail(err, { tool: "cpi_ping" });
  }
}

export const definition = {
  name: "cpi_ping",
  description:
    "Verifica la conexion con el tenant de Cloud Integration: obtiene el token OAuth, lee " +
    "$metadata y devuelve el profile activo, la URL del API, los scopes del token y si tiene " +
    "permisos de escritura. Usar cuando el usuario pregunta si la conexion funciona o para " +
    "diagnosticar errores 401/403.",
  inputSchema,
  jsonSchema,
};
