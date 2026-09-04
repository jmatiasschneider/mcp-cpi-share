import { readFileSync } from "node:fs";

import { z } from "zod";
import { updateArtifactFiles, updateArtifact } from "../core/ops/write.js";
import { artifactKinds } from "../core/ops/design.js";
import { ok, fail, table } from "./_render.js";

const KINDS = artifactKinds();

export const inputSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(KINDS).optional(),
    version: z.string().optional(),
    name: z.string().min(1).optional(),
    files: z
      .array(
        z
          .object({
            name: z.string().min(1),
            content: z.string().optional(),
            fromFile: z.string().min(1).optional(),
          })
          .strict()
          .refine((f) => (f.content !== undefined) !== (f.fromFile !== undefined), {
            message: "Cada archivo lleva 'content' O 'fromFile', exactamente uno.",
          })
      )
      .min(1)
      .optional(),
    removeFiles: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict()
  .refine((a) => a.name || a.files || a.removeFiles, {
    message: "No hay nada que actualizar: indicar 'files', 'removeFiles' y/o 'name'.",
  });

export const jsonSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Id del artefacto a modificar." },
    kind: {
      type: "string",
      enum: KINDS,
      description:
        "Tipo de artefacto: 'iflow' (default), 'mapping' (message mappings), " +
        "'script' (script collections) o 'valuemapping'.",
    },
    version: { type: "string", description: "Version del artefacto. Default 'active'." },
    name: { type: "string", description: "Nuevo nombre visible del artefacto (no cambia el Id)." },
    files: {
      type: "array",
      minItems: 1,
      description:
        "Archivos del bundle a escribir. La ruta es la misma que lista " +
        "cpi_iflow_read(includeContent:true), por ejemplo " +
        "'src/main/resources/script/miScript.groovy'. Si la ruta ya existe se reemplaza; " +
        "si no existe, se agrega.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Ruta del archivo dentro del ZIP." },
          content: {
            type: "string",
            description: "Contenido completo del archivo (texto). Alternativa a 'fromFile'.",
          },
          fromFile: {
            type: "string",
            description:
              "Ruta LOCAL de la que leer el contenido, byte a byte (tambien binarios). Es el " +
              "camino confiable para subir un archivo que ya existe en disco — un .mmap, un " +
              "XSD, un .iflw editado localmente — sin re-tipearlo como texto. Cada archivo " +
              "lleva 'content' O 'fromFile', exactamente uno.",
          },
        },
        required: ["name"],
        // El XOR content/fromFile tambien se declara aca, no solo en el refine de zod: asi el
        // cliente arma bien la llamada sin gastar un round-trip en el error.
        oneOf: [{ required: ["content"] }, { required: ["fromFile"] }],
        additionalProperties: false,
      },
    },
    removeFiles: {
      type: "array",
      minItems: 1,
      items: { type: "string" },
      description:
        "Rutas dentro del ZIP a ELIMINAR del bundle (mismas que lista " +
        "cpi_iflow_read(includeContent:true)). Una ruta que no existe es error — atrapa el " +
        "typo antes de tocar nada. MANIFEST.MF, .project, metainfo.prop y el .iflw no se " +
        "pueden eliminar. Sirve para limpiar recursos huerfanos que un clon arrastra de su " +
        "plantilla (mmaps placeholder, XSDs/WSDLs de otra interfaz).",
    },
  },
  required: ["id"],
  additionalProperties: false,
};

export async function handler(args, ctx) {
  try {
    const { id, kind = "iflow", version = "active", name, files, removeFiles } =
      inputSchema.parse(args ?? {});
    const conKind = kind === "iflow" ? "" : `, kind="${kind}"`;

    // Sin archivos que tocar es solo un rename: no hace falta bajar y resubir el bundle entero.
    if (!files && !removeFiles) {
      await updateArtifact(ctx.client, { id, version, name, kind });
      return ok(
        `Renombrado "${id}" a "${name}". El Id no cambia.\n\n` +
          `Queda como borrador: para que corra, cpi_deploy(id="${id}"${conKind}).`
      );
    }

    // fromFile se resuelve aca, antes de bajar el bundle: un path local roto no tiene que
    // costar una descarga, y el error tiene que nombrar el archivo que fallo.
    const resueltos = (files ?? []).map((f) => {
      if (f.content !== undefined) return { name: f.name, data: f.content };
      try {
        return { name: f.name, data: readFileSync(f.fromFile) };
      } catch (e) {
        const err = new Error(`No se pudo leer "${f.fromFile}" (para "${f.name}"): ${e.message}`);
        err.hint = "La ruta es del filesystem LOCAL; conviene pasarla absoluta.";
        throw err;
      }
    });

    const res = await updateArtifactFiles(ctx.client, {
      id,
      version,
      name,
      kind,
      files: resueltos,
      removeFiles,
    });

    const blocks = [
      `Bundle de "${id}" actualizado: ${res.files} archivos, ${res.bytes} bytes.`,
      "",
      table(
        [
          ...res.replaced.map((n) => ({ accion: "reemplazado", archivo: n })),
          ...res.added.map((n) => ({ accion: "AGREGADO", archivo: n })),
          ...res.removed.map((n) => ({ accion: "ELIMINADO", archivo: n })),
        ],
        ["accion", "archivo"]
      ),
    ];

    // Un archivo "agregado" sin querer casi siempre es una ruta mal escrita: el bundle queda
    // con el original intacto y una copia inerte al lado, y el sintoma es que "no cambio nada".
    if (res.added.length) {
      blocks.push(
        "",
        `⚠️ ${res.added.length} ruta(s) no existian en el bundle y se agregaron. Si la intencion ` +
          `era reemplazar un archivo, la ruta esta mal escrita: verificar con ` +
          `cpi_iflow_read(id="${id}"${conKind}, includeContent=true).`
      );
    }
    // El PUT acepta el bundle con menos archivos sin chequear referencias: si el .iflw o el
    // MANIFEST siguen nombrando lo eliminado, eso no se nota aca — se nota al deployar.
    if (res.removed.length) {
      blocks.push(
        "",
        `Si algo del bundle todavia referencia lo eliminado (un paso del .iflw, el ` +
          `Require-Capability del MANIFEST), el upload no lo detecta: verificar con ` +
          `cpi_iflow_validate antes de deployar.`
      );
    }
    if (name) blocks.push("", `Tambien se renombro el artefacto a "${name}".`);

    blocks.push(
      "",
      `El cambio quedo en el DISEÑO, no en el runtime. Para que corra: ` +
        (kind === "iflow"
          ? `cpi_iflow_validate(id="${id}") y despues cpi_deploy(id="${id}").`
          : `cpi_deploy(id="${id}", kind="${kind}"). No hay Validate fuera del iFlow.`)
    );

    return ok(blocks.join("\n"));
  } catch (err) {
    return fail(err, { tool: "cpi_iflow_update" });
  }
}

export const definition = {
  name: "cpi_iflow_update",
  description:
    "ESCRIBE. Modifica un artefacto que ya existe: reemplaza o agrega archivos dentro de su bundle " +
    "(Groovy, XSLT, WSDL, el propio .iflw, el .mmap de un mapping), elimina archivos con " +
    "'removeFiles' (recursos huerfanos que un clon arrastra de su plantilla) y/o lo renombra. Con " +
    "'kind' sirve para iFlows (default), message mappings, script collections y value mappings. " +
    "Cada archivo de 'files' entra por 'content' (texto inline) o por 'fromFile' (ruta local, byte " +
    "a byte — el camino confiable para un archivo que ya existe en disco, contraparte del saveTo " +
    "de cpi_iflow_read). Baja el ZIP, aplica solo los cambios indicados y lo vuelve a subir " +
    "entero, dejando el resto intacto — el MANIFEST.MF, el .project, el metainfo.prop y el .iflw " +
    "no se pueden eliminar. PISA la version de diseño actual y no hay undo, pero NO afecta al " +
    "runtime hasta que se vuelva a deployar. Para crear un iFlow nuevo va cpi_iflow_clone; para " +
    "cambiar parametros externalizados, cpi_iflow_configure (mas seguro que editar el modelo).",
  inputSchema,
  jsonSchema,
};
