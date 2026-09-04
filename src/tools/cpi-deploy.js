import { z } from "zod";
import {
  deployArtifact,
  deployDevuelveTaskId,
  waitForDeploy,
  waitForRuntime,
  deployStatus,
  isTransient,
} from "../core/ops/write.js";
import { artifactKinds } from "../core/ops/design.js";
import { deployedErrorInfo } from "../core/ops/runtime.js";
import { ok, fail, kv, table } from "./_render.js";

const KINDS = artifactKinds();

export const inputSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(KINDS).optional(),
    version: z.string().optional(),
    wait: z.boolean().optional(),
    taskId: z.string().optional(),
  })
  .strict();

export const jsonSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Id del artefacto a deployar." },
    kind: {
      type: "string",
      enum: KINDS,
      description:
        "Tipo de artefacto: 'iflow' (default), 'mapping' (message mappings), " +
        "'script' (script collections) o 'valuemapping'. Cada familia deploya con su propio " +
        "FunctionImport; pedir un mapping como iflow da 404.",
    },
    version: { type: "string", description: "Version del artefacto. Default 'active'." },
    wait: {
      type: "boolean",
      description:
        "Esperar el resultado antes de responder: hasta 90 s el build y hasta 90 s mas el " +
        "asentamiento en el runtime. Default true.",
    },
    taskId: {
      type: "string",
      description:
        "Si se indica, NO deploya: solo consulta el estado de un deploy ya disparado con ese " +
        "TaskId. Solo aplica a los iFlows — las demas familias no devuelven TaskId.",
    },
  },
  required: ["id"],
  additionalProperties: false,
};

export async function handler(args, ctx) {
  try {
    const { id, kind = "iflow", version = "active", wait = true, taskId } = inputSchema.parse(args ?? {});

    // Modo consulta: no dispara nada
    if (taskId) {
      if (!deployDevuelveTaskId(kind)) {
        return ok(
          `Los artefactos de tipo "${kind}" no informan TaskId, asi que no hay estado de task que ` +
            `consultar. Para ver como quedo: cpi_deployed(id="${id}").`
        );
      }
      const st = await deployStatus(ctx.client, taskId);
      return ok(st ? `Estado del deploy ${taskId}:\n\n${kv(st)}` : `No hay estado para el TaskId "${taskId}".`);
    }

    const task = await deployArtifact(ctx.client, { id, version, kind });
    const conTask = deployDevuelveTaskId(kind);
    const blocks = [`Deploy de "${id}" (${kind}, version ${version}) disparado.`];
    // ⚠️ Solo el iFlow devuelve TaskId. DeployMessageMappingDesigntimeArtifact responde con el
    // body VACIO aunque el deploy arranque bien: mostrar "TaskId: " vacio invita a leerlo como
    // fallo. Para esas familias el unico testigo es IntegrationRuntimeArtifacts.
    if (conTask) blocks.push(`TaskId: ${task}`);

    if (!wait) {
      blocks.push(
        "",
        conTask
          ? `No se espero el resultado. Consultar con cpi_deploy(id="${id}", taskId="${task}") ` +
              `o con cpi_deployed.`
          : `No se espero el resultado. Consultar con cpi_deployed(id="${id}").`
      );
      return ok(blocks.join("\n"));
    }

    // Dos esperas distintas: el task termina antes de que el runtime se asiente.
    // DEPLOYING y STARTING son transitorios — darlos por finales reporta falsos errores.
    if (conTask) {
      const st = await waitForDeploy(ctx.client, task);
      blocks.push("", st ? `Build & deploy: ${st.Status ?? "?"}` : "(no se pudo leer el estado del task)");

      // Un build fallido corta aca: consultar el runtime seria peor que inutil. En un redeploy
      // la version ANTERIOR sigue STARTED, y reportarla haria parecer exitoso un deploy que fallo.
      if (st?.Status && st.Status !== "SUCCESS" && !isTransient(st.Status)) {
        blocks.push(
          "",
          `El build fallo: esta version NO llego al runtime. Si el artefacto ya estaba deployado, ` +
            `lo que este corriendo es la version ANTERIOR, no esta. ` +
            `Revisar el artefacto con cpi_iflow_validate(id="${id}") antes de reintentar.`
        );
        return ok(blocks.join("\n"));
      }
    }

    const rt = await waitForRuntime(ctx.client, id);
    if (!rt) {
      blocks.push(
        "",
        conTask
          ? "El artefacto no aparece en el runtime. Si el build fallo, el detalle esta en el estado del task."
          : "El artefacto no aparece en el runtime, y esta familia no deja estado de task que mirar. " +
              "Reintentar cpi_deployed en unos segundos antes de darlo por fallido."
      );
      return ok(blocks.join("\n"));
    }

    blocks.push("", "Runtime:", table([rt], ["Id", "Type", "Status", "DeployedBy", "DeployedOn"]));

    if (rt.Status === "STARTED") {
      blocks.push(
        "",
        kind === "iflow"
          ? `"${id}" quedo corriendo. Para ver que proceso, usar cpi_messages(iflow="${id}").`
          : `"${id}" quedo deployado. Un ${kind} no procesa mensajes por si solo: lo usa el iFlow ` +
              `que lo referencia, y ese iFlow hay que deployarlo despues de este.`
      );
    } else {
      const info = await deployedErrorInfo(ctx.client, id).catch(() => null);
      blocks.push("", `El artefacto quedo en estado "${rt.Status}", no STARTED.`);
      if (info) blocks.push("", "Detalle:", kv(info));
    }

    return ok(blocks.join("\n"));
  } catch (err) {
    return fail(err, { tool: "cpi_deploy" });
  }
}

export const definition = {
  name: "cpi_deploy",
  description:
    "ESCRIBE EN EL RUNTIME. Deploya un artefacto al runtime del tenant y espera el resultado, " +
    "informando el estado final y si quedo en STARTED o en error. Con 'kind' deploya iFlows " +
    "(default), message mappings, script collections o value mappings. Un deploy REEMPLAZA la " +
    "version que este corriendo de ese artefacto. Conviene correr cpi_iflow_validate antes, que " +
    "solo existe para iFlows. Deployar un iFlow NO deploya los mappings que referencia: el orden " +
    "es mapping primero, iFlow despues. Con taskId consulta el estado de un deploy anterior sin " +
    "disparar uno nuevo.",
  inputSchema,
  jsonSchema,
};
