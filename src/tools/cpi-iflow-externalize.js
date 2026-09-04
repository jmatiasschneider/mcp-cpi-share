import { z } from "zod";
import { inspectParameters, externalizeParameters } from "../core/ops/write.js";
import { ok, fail, table } from "./_render.js";

export const inputSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().optional(),
    params: z
      .array(
        z
          .object({
            key: z.string().min(1),
            name: z.string().min(1),
            currentValue: z.string().optional(),
            default: z.string().optional(),
          })
          .strict()
      )
      .min(1)
      .optional(),
  })
  .strict();

export const jsonSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Id del iFlow." },
    version: { type: "string", description: "Version del artefacto. Default 'active'." },
    params: {
      type: "array",
      minItems: 1,
      description:
        "Propiedades a externalizar. SI SE OMITE, la tool no modifica nada: lista las " +
        "propiedades candidatas del modelo para poder elegir.",
      items: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description:
              "Clave de la propiedad en el modelo, tal cual la lista esta misma tool sin " +
              "'params' (ej 'urlPath', 'httpAddressWithoutQuery', 'credentialName').",
          },
          name: {
            type: "string",
            description:
              "Nombre del parametro externalizado (ej 'ReceiverUrl'). Es el que despues se " +
              "setea con cpi_iflow_configure.",
          },
          currentValue: {
            type: "string",
            description:
              "Obligatorio solo si esa clave aparece en varios componentes: dice cual tocar. " +
              "Sin esto, una clave ambigua da error en vez de elegir por su cuenta.",
          },
          default: {
            type: "string",
            description:
              "Valor por defecto del parametro. Si se omite, queda el valor que tenia el modelo.",
          },
        },
        required: ["key", "name"],
        additionalProperties: false,
      },
    },
  },
  required: ["id"],
  additionalProperties: false,
};

export async function handler(args, ctx) {
  try {
    const { id, version = "active", params } = inputSchema.parse(args ?? {});

    // Sin params es modo inspeccion: no escribe nada.
    if (!params) {
      const { candidatos, yaExternalizados } = await inspectParameters(ctx.client, { id, version });
      const blocks = [`Propiedades del modelo de "${id}" que se pueden externalizar:`, ""];

      if (!candidatos.length) {
        blocks.push("(ninguna: el modelo no tiene propiedades con valor sin externalizar)");
      } else {
        blocks.push(
          table(
            candidatos.map((c) => ({
              key: c.key,
              valor: c.ambiguo ? `${c.values.length} valores: ${c.values.join(" | ")}` : c.values[0],
              ambiguo: c.ambiguo ? "SI — pasar currentValue" : "",
            })),
            ["key", "valor", "ambiguo"]
          )
        );
      }

      if (yaExternalizados.length) {
        blocks.push(
          "",
          `Ya externalizados (${yaExternalizados.length}):`,
          table(yaExternalizados, ["name", "default"])
        );
      }

      blocks.push(
        "",
        "Para un arquetipo, lo que casi siempre hay que externalizar es el address del sender " +
          "(urlPath), la URL del receiver (httpAddressWithoutQuery), el alias de credencial " +
          "(credentialName) y el location ID del Cloud Connector (locationID).",
        "",
        `Ejemplo: cpi_iflow_externalize(id="${id}", params=[{key:"urlPath", name:"SenderPath"}])`
      );
      return ok(blocks.join("\n"));
    }

    const res = await externalizeParameters(ctx.client, { id, version, params });

    return ok(
      [
        `${res.params.length} parametro(s) externalizado(s) en "${id}" (${res.iflw}):`,
        "",
        table(
          res.params.map((p) => ({
            propiedad: p.key,
            parametro: `{{${p.name}}}`,
            "valor anterior": p.oldValue,
            default: p.default,
          })),
          ["propiedad", "parametro", "valor anterior", "default"]
        ),
        "",
        `El modelo ya no tiene esos valores: quedaron como {{...}} y el valor vive en la capa de ` +
          `configuracion. Ahora un clon de "${id}" se ajusta entero sin abrir el editor:`,
        "",
        `  cpi_iflow_configure(id="<el clon>", parameters={` +
          res.params.map((p) => `"${p.name}": "…"`).join(", ") +
          `})`,
        "",
        `Conviene verificar con cpi_iflow_validate(id="${id}") y revisar los parametros con ` +
          `cpi_iflow_read(id="${id}"). El cambio es de DISEÑO: para que corra hay que deployar.`,
      ].join("\n")
    );
  } catch (err) {
    return fail(err, { tool: "cpi_iflow_externalize" });
  }
}

export const definition = {
  name: "cpi_iflow_externalize",
  description:
    "ESCRIBE. Convierte valores hardcodeados del modelo de un iFlow en parametros externalizados: " +
    "reemplaza el valor por {{Nombre}} en el .iflw y declara el default en parameters.prop. " +
    "Es lo que convierte un iFlow hecho a mano en un ARQUETIPO clonable — sin esto, clonar copia " +
    "los valores fijos y hay que abrir el editor web para cambiarlos. " +
    "SIN el argumento 'params' no modifica nada: lista las propiedades candidatas del modelo. " +
    "Despues de externalizar, los valores se ajustan con cpi_iflow_configure.",
  inputSchema,
  jsonSchema,
};
