import { z } from "zod";
import {
  readArtifact,
  downloadArtifact,
  listConfigurations,
  listResources,
  listZipEntries,
  readBundleFile,
  saveBundleFile,
  artifactKinds,
} from "../core/ops/design.js";
import { ok, fail, table, kv } from "./_render.js";

const KINDS = artifactKinds();

export const inputSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(KINDS).optional(),
    version: z.string().optional(),
    includeContent: z.boolean().optional(),
    file: z.string().min(1).optional(),
    maxBytes: z.number().int().min(100).max(200000).optional(),
    saveTo: z.string().min(1).optional(),
    overwrite: z.boolean().optional(),
  })
  .strict();

export const jsonSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Id del artefacto (ej 'test')." },
    kind: {
      type: "string",
      enum: KINDS,
      description:
        "Tipo de artefacto: 'iflow' (default), 'mapping' (message mapping), 'script' o " +
        "'valuemapping'. Tiene que coincidir con el que devolvio cpi_iflow_list: los cuatro " +
        "viven en entity sets distintos y un Id de mapping consultado como iflow da 404.",
    },
    version: {
      type: "string",
      description: "Version del artefacto. Default 'active' (la version de trabajo).",
    },
    includeContent: {
      type: "boolean",
      description:
        "Si es true, descarga el bundle y lista los archivos que contiene (no su contenido). " +
        "Default false.",
    },
    file: {
      type: "string",
      description:
        "Devuelve el CONTENIDO de ese archivo del bundle en vez de la metadata del iFlow. " +
        "Acepta la ruta completa que lista includeContent:true " +
        "(ej 'src/main/resources/script/mapeo.groovy') o solo el nombre si es inequivoco " +
        "(ej 'mapeo.groovy', que es como lo lista Recursos).",
    },
    maxBytes: {
      type: "integer",
      minimum: 100,
      maximum: 200000,
      description: "Tope de caracteres al devolver un archivo con 'file'. Default 20000.",
    },
    saveTo: {
      type: "string",
      description:
        "Ruta LOCAL donde guardar el archivo pedido con 'file', byte a byte (sirve tambien " +
        "para binarios). Es la forma confiable de sacar un archivo del bundle a disco: la " +
        "salida de texto de la tool no es apta para re-escribirla a mano. Requiere 'file'; " +
        "el directorio destino tiene que existir; conviene una ruta absoluta. Un archivo " +
        "existente NO se pisa: hace falta overwrite:true.",
    },
    overwrite: {
      type: "boolean",
      description:
        "Permitir que saveTo reemplace un archivo local que ya existe. Default false: sin " +
        "esto, un destino existente es un error en vez de una sobreescritura silenciosa.",
    },
  },
  required: ["id"],
  additionalProperties: false,
};

export async function handler(args, ctx) {
  try {
    const {
      id,
      kind = "iflow",
      version = "active",
      includeContent = false,
      file,
      maxBytes = 20000,
      saveTo,
      overwrite = false,
    } = inputSchema.parse(args ?? {});

    if (saveTo && !file) {
      return fail(
        Object.assign(new Error("'saveTo' requiere 'file': dice que archivo del bundle guardar."), {
          hint: "Listar los archivos con includeContent:true y pedir uno con file=<ruta>.",
        }),
        { tool: "cpi_iflow_read" }
      );
    }

    // Modo "guardar a disco": la copia la escribe el server directo del ZIP, byte a byte.
    if (saveTo) {
      const f = await saveBundleFile(ctx.client, id, { version, kind, file, saveTo, overwrite });
      return ok(
        `${f.name} (${f.size} bytes${f.binary ? ", binario" : ""}) guardado byte a byte en:\n${f.savedTo}` +
          // Ignorarlo en silencio pareceria que la tool lo olvido; decirlo cierra la duda.
          (includeContent
            ? "\n\n(includeContent se ignora en este modo: con saveTo solo se guarda el archivo)"
            : "")
      );
    }

    // Modo "ver un archivo": no tiene sentido mezclarlo con la metadata, seria ruido alrededor
    // de lo unico que se pidio.
    if (file) {
      const f = await readBundleFile(ctx.client, id, { version, kind, file, maxBytes });
      if (f.binary) {
        return ok(
          `${f.name} (${f.size} bytes) es BINARIO: no se puede mostrar como texto.\n\n` +
            `Los .p12, .jar y demas se manejan desde la UI del tenant.`
        );
      }
      return ok(
        [
          `${f.name}  —  ${f.size} bytes${f.truncated ? `, mostrando los primeros ${maxBytes}` : ""}`,
          "",
          f.text,
          f.truncated
            ? `\n…(cortado en ${maxBytes} caracteres — pedir maxBytes mas grande para ver el resto)`
            : "",
        ].join("\n")
      );
    }

    const meta = await readArtifact(ctx.client, id, { version, kind });
    if (!meta) return ok(`No existe el artefacto "${id}" (${kind}) en version "${version}".`);

    const blocks = [`${kind} ${id} (version ${version})`, "", kv(meta)];

    // Configurations es exclusiva del iFlow: para el resto ni se pide.
    const [configs, resources] = await Promise.all([
      kind === "iflow" ? listConfigurations(ctx.client, id, { version }).catch(() => []) : [],
      listResources(ctx.client, id, { version, kind }).catch(() => []),
    ]);

    if (kind === "iflow") {
      blocks.push(
        "",
        configs.length
          ? `Parametros externalizados (${configs.length}):\n${table(configs, ["ParameterKey", "ParameterValue", "DataType"])}`
          : "Sin parametros externalizados."
      );
    }

    if (resources.length) {
      // `Name` se copia tal cual al argumento `file`: no se recorta.
      blocks.push(
        "",
        `Recursos (${resources.length}):`,
        table(resources, ["Name", "ResourceType"], { sinRecortar: ["Name"] })
      );
    }

    if (includeContent) {
      const buf = await downloadArtifact(ctx.client, id, { version, kind });
      const entries = listZipEntries(buf);
      blocks.push(
        "",
        `Bundle: ${buf.length} bytes, ${entries.length} archivos:`,
        // La ruta es lo que se pasa en `file` en la llamada siguiente: recortarla la vuelve inservible.
        table(
          entries.map((e) => ({ archivo: e.name, bytes: e.size })),
          ["archivo", "bytes"],
          { sinRecortar: ["archivo"] }
        ),
        "",
        `Para ver el contenido de uno: cpi_iflow_read(id="${id}"${kind === "iflow" ? "" : `, kind="${kind}"`}, file="<archivo>").`
      );
    } else if (resources.length) {
      blocks.push(
        "",
        `Para ver el contenido de un recurso: cpi_iflow_read(id="${id}"${kind === "iflow" ? "" : `, kind="${kind}"`}, file="${resources[0].Name}").`
      );
    }

    return ok(blocks.join("\n"));
  } catch (err) {
    return fail(err, { tool: "cpi_iflow_read" });
  }
}

export const definition = {
  name: "cpi_iflow_read",
  description:
    "Lee un artefacto de diseño: iFlow por default, o un message mapping / script collection / " +
    "value mapping segun 'kind'. Devuelve metadata, parametros externalizados (Configurations, " +
    "solo iFlow) y recursos internos. " +
    "Con includeContent=true tambien descarga el bundle y lista los archivos del ZIP. " +
    "Con file=<ruta o nombre> devuelve el CONTENIDO de ese archivo — el Groovy, el XSLT, el WSDL " +
    "o el propio .iflw —, que es lo que hay que leer para saber que hace realmente el flujo. " +
    "Con file + saveTo=<ruta local> GUARDA ese archivo en disco byte a byte (tambien binarios) — " +
    "la forma confiable de sacar un .mmap o un XSD del bundle para compararlo afuera. " +
    "Los parametros externalizados son lo que hay que mirar para saber que se puede " +
    "reconfigurar sin tocar el modelo.",
  inputSchema,
  jsonSchema,
};
