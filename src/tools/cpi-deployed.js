import { z } from "zod";
import { listDeployed, deployedErrorInfo, listEndpoints } from "../core/ops/runtime.js";
import { ok, fail, table, kv } from "./_render.js";

export const inputSchema = z
  .object({
    id: z.string().optional(),
    withEndpoints: z.boolean().optional(),
  })
  .strict();

export const jsonSchema = {
  type: "object",
  properties: {
    id: {
      type: "string",
      description:
        "Si se indica, devuelve solo ese artefacto e incluye su informacion de error si esta " +
        "en estado ERROR.",
    },
    withEndpoints: {
      type: "boolean",
      description: "Incluir los endpoints HTTP expuestos por los iFlows deployados. Default false.",
    },
  },
  additionalProperties: false,
};

export async function handler(args, ctx) {
  try {
    const { id, withEndpoints = false } = inputSchema.parse(args ?? {});
    const rows = await listDeployed(ctx.client);

    const filtered = id ? rows.filter((r) => r.Id === id) : rows;
    if (!filtered.length) {
      return ok(
        id
          ? `No hay ningun artefacto deployado con Id "${id}".`
          : "No hay artefactos deployados en el tenant."
      );
    }

    const blocks = [
      `${filtered.length} artefacto(s) deployado(s):`,
      "",
      table(filtered, ["Id", "Name", "Type", "Status", "DeployedBy", "DeployedOn"]),
    ];

    for (const r of filtered) {
      if (r.Status && r.Status !== "STARTED") {
        const info = await deployedErrorInfo(ctx.client, r.Id).catch(() => null);
        if (info) blocks.push("", `Error de "${r.Id}":`, kv(info));
      }
    }

    if (withEndpoints) {
      const eps = await listEndpoints(ctx.client).catch(() => []);
      blocks.push(
        "",
        eps.length
          ? `Endpoints expuestos (${eps.length}):\n${table(eps)}`
          : "Sin endpoints HTTP expuestos. Los iFlows disparados por timer, file, JMS o IDoc " +
            "no exponen endpoint: es normal que esta lista este vacia."
      );
    }

    return ok(blocks.join("\n"));
  } catch (err) {
    return fail(err, { tool: "cpi_deployed" });
  }
}

export const definition = {
  name: "cpi_deployed",
  description:
    "Estado del runtime: que artefactos estan deployados, en que estado (STARTED, ERROR...), " +
    "quien y cuando los deployo. Con withEndpoints=true agrega las URLs expuestas. Si un " +
    "artefacto no esta STARTED, incluye automaticamente el detalle del error.",
  inputSchema,
  jsonSchema,
};
