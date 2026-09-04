import { z } from "zod";
import { validateArtifact, checkGuidelines } from "../core/ops/write.js";
import { ok, fail } from "./_render.js";

export const inputSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().optional(),
    guidelines: z.boolean().optional(),
  })
  .strict();

export const jsonSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Id del iFlow a validar." },
    version: { type: "string", description: "Version del artefacto. Default 'active'." },
    guidelines: {
      type: "boolean",
      description:
        "Ademas de validar, correr el chequeo de design guidelines de SAP. Default false.",
    },
  },
  required: ["id"],
  additionalProperties: false,
};

const MAX_FRAMES = 5;
const MAX_CHARS = 4000;

/** Un frame de stack de Java, en una linea. */
const frame = (f) => `${f.declaringClass}.${f.methodName}(${f.fileName}:${f.lineNumber})`;

/**
 * Los frames que dicen algo. Se prefieren los de SAP: el resto de la pila es Tomcat, CXF y
 * Olingo, o sea el transporte por el que llego la llamada, que no explica nada del iFlow.
 */
function resumirFrames(frames) {
  const propios = frames.filter((f) => String(f?.declaringClass ?? "").startsWith("com.sap"));
  const elegidos = (propios.length ? propios : frames).slice(0, MAX_FRAMES);
  const omitidos = frames.length - elegidos.length;
  return omitidos > 0
    ? [...elegidos.map(frame), `(+${omitidos} frames omitidos de ${frames.length})`]
    : elegidos.map(frame);
}

function condensar(nodo) {
  if (Array.isArray(nodo)) return nodo.map(condensar);
  if (nodo && typeof nodo === "object") {
    const out = {};
    for (const [k, v] of Object.entries(nodo)) {
      if (k === "stackTrace" && Array.isArray(v)) out[k] = resumirFrames(v);
      else if (k === "suppressedExceptions" && Array.isArray(v) && !v.length) continue;
      else out[k] = condensar(v);
    }
    return out;
  }
  return nodo;
}

/**
 * Recorta el volcado que devuelve el Validate cuando la validacion tira una excepcion.
 *
 * Sin esto la respuesta son ~100 frames de stack de Java —Tomcat, CXF, Olingo— por una sola
 * excepcion. Ninguno de esos frames dice nada del iFlow, y el volcado entero le consume al
 * modelo el contexto que necesita para arreglar el problema. Pasa con un .iflw mal formado.
 *
 * Si no hay JSON adentro, o no parsea, se devuelve el texto tal cual: es preferible una
 * respuesta larga a una respuesta mutilada.
 */
export function resumirValidacion(text) {
  const s = String(text ?? "");
  const i = s.search(/[[{]/);
  if (i < 0) return s;

  let datos;
  try {
    datos = JSON.parse(s.slice(i));
  } catch {
    return s;
  }

  const salida = s.slice(0, i) + JSON.stringify(condensar(datos), null, 2);
  return salida.length > MAX_CHARS
    ? `${salida.slice(0, MAX_CHARS)}\n… (recortado: ${salida.length} caracteres en total)`
    : salida;
}

export async function handler(args, ctx) {
  try {
    const { id, version = "active", guidelines = false } = inputSchema.parse(args ?? {});

    const result = resumirValidacion(await validateArtifact(ctx.client, { id, version }));
    const blocks = [
      `Validacion de "${id}" (version ${version}):`,
      "",
      result?.trim() ? result : "(la API no devolvio observaciones: el artefacto valida sin errores)",
    ];

    if (guidelines) {
      const g = await checkGuidelines(ctx.client, { id, version }).catch(
        (e) => `(el chequeo de guidelines fallo: ${e.message})`
      );
      blocks.push("", "Design guidelines:", g?.trim() ? resumirValidacion(g) : "(sin observaciones)");
    }

    blocks.push("", "Validar NO deploya. Para deployar, usar cpi_deploy.");
    return ok(blocks.join("\n"));
  } catch (err) {
    return fail(err, { tool: "cpi_iflow_validate" });
  }
}

export const definition = {
  name: "cpi_iflow_validate",
  description:
    "Valida un iFlow SIN deployarlo, usando el FunctionImport ValidateIntegrationDesigntimeArtifact " +
    "del tenant. Sirve para el ciclo crear/corregir sin ensuciar el runtime ni interrumpir lo " +
    "que ya esta corriendo. Con guidelines=true agrega el chequeo de design guidelines de SAP.",
  inputSchema,
  jsonSchema,
};
