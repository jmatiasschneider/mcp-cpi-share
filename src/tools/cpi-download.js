import { z } from "zod";
import { savePackageZip, saveArtifactZip, artifactKinds } from "../core/ops/design.js";
import { ok, fail } from "./_render.js";

const KINDS = artifactKinds();

export const inputSchema = z
  .object({
    packageId: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
    kind: z.enum(KINDS).optional(),
    version: z.string().optional(),
    saveTo: z.string().min(1),
    overwrite: z.boolean().optional(),
  })
  .strict();

export const jsonSchema = {
  type: "object",
  properties: {
    packageId: {
      type: "string",
      description:
        "Id del integration package a descargar ENTERO: el zip que baja es el mismo que produce " +
        "el boton Export de la UI (un bundle por artefacto + metadata del export), importable " +
        "despues con Import. Excluyente con 'id'. ⚠️ El tenant rechaza el export si el package " +
        "tiene algun artefacto sin versionar (draft); en ese caso, bajar los artefactos de a uno.",
    },
    id: {
      type: "string",
      description:
        "Id del artefacto de diseño cuyo bundle ZIP se descarga completo (el mismo que abre " +
        "cpi_iflow_read con includeContent). Excluyente con 'packageId'. Funciona aunque el " +
        "artefacto este en draft.",
    },
    kind: {
      type: "string",
      enum: KINDS,
      description:
        "Tipo del artefacto de 'id': 'iflow' (default), 'mapping', 'script' o 'valuemapping'. " +
        "Solo aplica con 'id'.",
    },
    version: {
      type: "string",
      description: "Version del artefacto de 'id'. Default 'active' (la version de trabajo).",
    },
    saveTo: {
      type: "string",
      description:
        "Ruta LOCAL donde escribir el .zip, byte a byte. El directorio tiene que existir; " +
        "conviene una ruta absoluta. Un archivo existente NO se pisa: hace falta overwrite:true.",
    },
    overwrite: {
      type: "boolean",
      description:
        "Permitir que saveTo reemplace un archivo local que ya existe. Default false: sin " +
        "esto, un destino existente es un error en vez de una sobreescritura silenciosa.",
    },
  },
  required: ["saveTo"],
  // La exclusividad vive tambien aca y no solo en el handler: asi el cliente arma bien la
  // llamada sin gastar un round-trip en el error.
  oneOf: [{ required: ["packageId"] }, { required: ["id"] }],
  additionalProperties: false,
};

export async function handler(args, ctx) {
  try {
    const {
      packageId,
      id,
      kind = "iflow",
      version = "active",
      saveTo,
      overwrite = false,
    } = inputSchema.parse(args ?? {});

    if (!packageId === !id) {
      return fail(
        Object.assign(
          new Error("Indicar 'packageId' (un package entero) O 'id' (un artefacto), exactamente uno."),
          { hint: "Los packages se listan con cpi_packages; los artefactos, con cpi_iflow_list." }
        ),
        { tool: "cpi_download" }
      );
    }

    if (packageId && (args?.kind !== undefined || args?.version !== undefined)) {
      return fail(
        Object.assign(
          new Error("'kind' y 'version' son del modo artefacto: con 'packageId' no aplican."),
          { hint: "El export de un package siempre lleva todos sus artefactos, en su ultima version." }
        ),
        { tool: "cpi_download" }
      );
    }

    if (packageId) {
      const r = await savePackageZip(ctx.client, packageId, { saveTo, overwrite });
      return ok(
        `Package ${packageId} exportado: ${r.size} bytes, ${r.artifacts} artefacto(s) adentro, ` +
          `guardado byte a byte en:\n${r.savedTo}\n\n` +
          `Es el mismo zip que el Export de la UI (se puede volver a importar con Import).`
      );
    }

    const r = await saveArtifactZip(ctx.client, id, { version, kind, saveTo, overwrite });
    return ok(
      `${kind} ${id} (version ${version}): bundle de ${r.size} bytes (${r.files} archivos) ` +
        `guardado byte a byte en:\n${r.savedTo}`
    );
  } catch (err) {
    return fail(err, { tool: "cpi_download" });
  }
}

export const definition = {
  name: "cpi_download",
  description:
    "Descarga contenido de diseño del tenant a un archivo .zip LOCAL, byte a byte y sin " +
    "transformar — la pieza para hacer backup del tenant. Dos modos excluyentes: con " +
    "packageId=<Id> baja un integration package ENTERO (el mismo zip que el Export de la UI, " +
    "importable despues); con id=<Id> (+kind/version) baja el bundle completo de UN artefacto " +
    "de diseño. Solo lee del tenant; lo unico que escribe es el archivo local de saveTo. " +
    "⚠️ Un package con artefactos sin versionar (draft) no se puede exportar — el tenant lo " +
    "rechaza entero —; el bundle individual de un draft si se puede bajar. Para leer archivos " +
    "de ADENTRO de un bundle esta cpi_iflow_read; para listar packages, cpi_packages.",
  inputSchema,
  jsonSchema,
};
