import { z } from "zod";
import { undeployArtifact, waitForRuntime } from "../core/ops/write.js";
import { listDeployed } from "../core/ops/runtime.js";
import { ok, fail, table } from "./_render.js";

export const inputSchema = z
  .object({
    id: z.string().min(1),
    confirm: z.literal(true),
  })
  .strict();

export const jsonSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Id del artefacto a sacar del runtime." },
    confirm: {
      type: "boolean",
      enum: [true],
      description:
        "Debe ser true. Confirmacion explicita de que se quiere DETENER este artefacto en el " +
        "runtime. Pediselo al usuario antes de llamarla.",
    },
  },
  required: ["id", "confirm"],
  additionalProperties: false,
};

export async function handler(args, ctx) {
  try {
    const { id } = inputSchema.parse(args ?? {});

    const before = await listDeployed(ctx.client).catch(() => []);
    if (!before.some((d) => d.Id === id)) {
      return ok(`El artefacto "${id}" no esta deployado. No se hizo nada.`);
    }

    await undeployArtifact(ctx.client, { id });

    // El undeploy pasa por STOPPING antes de desaparecer: hay que esperarlo,
    // o se reporta un falso fallo sobre un undeploy que estaba saliendo bien.
    const still = await waitForRuntime(ctx.client, id, { expectGone: true });
    const gone = still === null;

    const after = await listDeployed(ctx.client).catch(() => []);

    return ok(
      [
        gone
          ? `Artefacto "${id}" sacado del runtime. Dejo de procesar mensajes.`
          : `Se pidio el undeploy de "${id}" pero sigue en el runtime (estado "${still.Status}"). ` +
            `Reconsultar con cpi_deployed en unos segundos.`,
        "",
        `El artefacto de designtime NO se borro: sigue disponible para redeployar.`,
        "",
        after.length ? `Runtime ahora:\n${table(after, ["Id", "Type", "Status"])}` : "Runtime vacio.",
      ].join("\n")
    );
  } catch (err) {
    return fail(err, { tool: "cpi_undeploy" });
  }
}

export const definition = {
  name: "cpi_undeploy",
  description:
    "ESCRIBE EN EL RUNTIME Y ES DESTRUCTIVO. Saca un artefacto del runtime del tenant: deja de " +
    "procesar mensajes inmediatamente. No borra el artefacto de designtime, que queda disponible " +
    "para redeployar. Requiere confirm=true. Pedir confirmacion al usuario antes de llamarla.",
  inputSchema,
  jsonSchema,
};
