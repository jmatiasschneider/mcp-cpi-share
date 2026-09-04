/**
 * ops/design — packages y artefactos de diseño.
 *
 * Recordar el hallazgo del discovery: IntegrationDesigntimeArtifacts NO es consultable
 * de primer nivel (501). Solo se llega navegando desde IntegrationPackages.
 */

import { writeFileSync } from "node:fs";

import { clean, odataQuote, isBinary } from "../client.js";
import { readZip } from "../zip.js";

const PACKAGE_FIELDS = [
  "Id",
  "Name",
  "Description",
  "ShortText",
  "Version",
  "Vendor",
  "Mode",
  "CreatedBy",
  "CreationDate",
  "ModifiedBy",
  "ModifiedDate",
];

/**
 * Lista de packages del tenant.
 *
 * `$top` y `$skip` funcionan; `$inlinecount=allpages` NO (501 "$count is not supported"),
 * asi que el total exacto no se puede saber. Para responder `hasMore` sin mentir se pide
 * un registro de mas y se descarta.
 *
 * @returns {Promise<{rows: object[], hasMore: boolean}>}
 */
export async function listPackages(client, { top = 100, skip = 0 } = {}) {
  const { rows } = await client.get(`IntegrationPackages?$top=${top + 1}&$skip=${skip}`);
  const hasMore = rows.length > top;
  return {
    rows: rows.slice(0, top).map((r) => clean(r, { fields: PACKAGE_FIELDS })),
    hasMore,
  };
}

/**
 * Crea un integration package vacio.
 *
 * Verificado contra el tenant el 2026-08-10 (`ZZPKGPRUEBA`): `POST IntegrationPackages` con
 * `Id` + `Name` + `ShortText` + `Version` devuelve el package creado. No hace falta CSRF,
 * igual que en el resto de la escritura.
 *
 * `ShortText` es lo que la UI muestra como descripcion corta de la tarjeta, y el tenant lo
 * quiere presente: por eso cae al `name` en vez de mandarse vacio.
 *
 * ⚠️ Un Id duplicado NO da 409: da **500 con el motivo en `error.message.value`**, igual que
 * al crear un artefacto. Reintentar no ayuda.
 */
export async function createPackage(
  client,
  { id, name, shortText, description, version = "1.0.0" }
) {
  const body = {
    Id: id,
    Name: name ?? id,
    ShortText: shortText ?? name ?? id,
    Version: version,
  };
  if (description) body.Description = description;

  const { rows } = await client.post("IntegrationPackages", body);
  return rows.length ? clean(rows[0], { fields: PACKAGE_FIELDS }) : { Id: id, ...body };
}

/**
 * Entity set por tipo de artefacto.
 *
 * Las cuatro familias son gemelas en lo que importa para leerlas: misma key compuesta
 * (`Id` + `Version`), mismo `ArtifactContent` binario y mismo `/$value` que devuelve el bundle
 * en ZIP. Por eso alcanza con parametrizar el entity set en vez de duplicar las operaciones.
 *
 * Donde SI difieren es en las navegaciones: `Configurations` es exclusiva del iFlow (los
 * mappings no tienen parametros externalizados), y `Validate` no existe fuera del iFlow.
 */
const ARTIFACT_KINDS = {
  iflow: "IntegrationDesigntimeArtifacts",
  mapping: "MessageMappingDesigntimeArtifacts",
  script: "ScriptCollectionDesigntimeArtifacts",
  valuemapping: "ValueMappingDesigntimeArtifacts",
};

export const artifactKinds = () => Object.keys(ARTIFACT_KINDS);

export function entitySet(kind) {
  const set = ARTIFACT_KINDS[kind];
  if (!set) {
    throw new Error(`kind "${kind}" no valido. Opciones: ${artifactKinds().join(", ")}`);
  }
  return set;
}

/**
 * La key de un artefacto, ya lista para concatenarle una navegacion o `/$value`.
 * Se exporta porque `ops/write.js` construye las mismas URLs para escribir.
 */
export const artifactKey = (kind, id, version) =>
  `${entitySet(kind)}(Id='${odataQuote(id)}',Version='${odataQuote(version)}')`;

/**
 * Artefactos de un package. `kind` filtra el tipo; por default trae los iFlows.
 *
 * ⚠️ Verificado el 2026-08-04: sobre ESTA navegacion el tenant **ignora `$skip` en silencio**
 * (con 1 artefacto, `$top=1&$skip=1` devuelve 1 fila en vez de 0). No tira error: te daria la
 * misma pagina para siempre. Por eso se pagina del lado del cliente, no en la query.
 *
 * El precio es traer todos los artefactos del package; a cambio el total es exacto. Un package
 * tiene decenas de artefactos, no millones, asi que el intercambio conviene.
 *
 * @returns {Promise<{rows: object[], total: number, hasMore: boolean}>}
 */
export async function listArtifacts(client, packageId, { kind = "iflow", top = 50, skip = 0 } = {}) {
  const { rows } = await client.get(
    `IntegrationPackages('${odataQuote(packageId)}')/${entitySet(kind)}`
  );
  const total = rows.length;
  return {
    rows: rows.slice(skip, skip + top).map((r) => clean(r, { fields: ARTIFACT_FIELDS })),
    total,
    hasMore: skip + top < total,
  };
}

const ARTIFACT_FIELDS = [
  "Id",
  "Version",
  "PackageId",
  "Name",
  "Description",
  "Sender",
  "Receiver",
  "CreatedBy",
  "CreatedAt",
  "ModifiedBy",
  "ModifiedAt",
];

/** Metadata de un artefacto puntual. `kind` elige la familia; default iFlow. */
export async function readArtifact(client, id, { version = "active", kind = "iflow" } = {}) {
  const { rows } = await client.get(artifactKey(kind, id, version));
  if (!rows.length) return null;
  return clean(rows[0], { fields: [...ARTIFACT_FIELDS, "Comment"] });
}

/**
 * Descarga el bundle del artefacto. `/$value` devuelve el binario;
 * sin `/$value` devolves el registro JSON (con ArtifactContent en base64).
 */
export async function downloadArtifact(client, id, { version = "active", kind = "iflow" } = {}) {
  return client.get(`${artifactKey(kind, id, version)}/$value`, { raw: true });
}

/**
 * Descarga el zip de un package ENTERO — el mismo que produce el boton Export de la UI.
 *
 * Verificado el 2026-08-26: adentro va un `<guid>_content` por artefacto (que es el bundle del
 * artefacto, identico al de `/$value` salvo que sin `metainfo.prop`) mas la metadata del export
 * (`resources.cnt` con el mapa guid→Id en base64, `contentmetadata.md`, `hash`,
 * `ExportInformation.info`). Un package vacio tambien exporta: zip con solo la metadata.
 *
 * ⚠️ Si CUALQUIER artefacto del package esta sin versionar (draft), el tenant rechaza el export
 * ENTERO con un 500 que lista los drafts. No hay export parcial: la salida es versionar en la
 * UI ("Save as version") o bajar los artefactos de a uno, que si funciona sobre drafts.
 */
export async function downloadPackage(client, id) {
  try {
    return await client.get(`IntegrationPackages('${odataQuote(id)}')/$value`, { raw: true });
  } catch (err) {
    if (err.status === 500 && /draft state/i.test(err.message)) {
      err.hint =
        "El tenant no exporta un package con artefactos sin versionar (draft). Opciones: " +
        "versionarlos en la UI (Save as version) o bajarlos de a uno con id=<artefacto>, " +
        "que funciona aunque esten en draft.";
    }
    throw err;
  }
}

/**
 * Parametros externalizados. Solo el iFlow tiene la navegacion `Configurations`: un message
 * mapping no tiene parametros externalizables, asi que pedirselo seria un 404 confuso.
 */
export async function listConfigurations(client, id, { version = "active", kind = "iflow" } = {}) {
  if (kind !== "iflow") {
    throw new Error(`Los artefactos de tipo "${kind}" no tienen parametros externalizados.`);
  }
  const { rows } = await client.get(`${artifactKey(kind, id, version)}/Configurations`);
  return rows.map((r) => clean(r));
}

/** Archivos internos del bundle (XSLT, Groovy, WSDL, XSD...). */
export async function listResources(client, id, { version = "active", kind = "iflow" } = {}) {
  const { rows } = await client.get(`${artifactKey(kind, id, version)}/Resources`);
  return rows.map((r) => clean(r));
}

/** Lista los archivos del bundle. La implementacion de ZIP vive en core/zip.js. */
export function listZipEntries(buf) {
  return readZip(buf);
}

/**
 * Contenido de UN archivo del bundle: el Groovy, el XSLT, el WSDL, el .iflw.
 *
 * Va por el ZIP y no por la navegacion `Resources`. Ojo: NO es que Resources no sirva —el
 * 2026-08-10 se verifico que `Resources(Name,ResourceType)/$value` SI devuelve el contenido, y
 * coincide byte a byte con la entrada del ZIP—. Va por el ZIP porque una sola descarga trae todo
 * el bundle y no exige conocer el `ResourceType`, que la navegacion si pide. El precio es traer
 * el bundle entero para leer un archivo; con bundles de pocos KB el intercambio conviene.
 *
 * @param {string} file ruta dentro del ZIP, o el nombre del archivo a secas si es inequivoco.
 * @returns {Promise<{name, size, text, binary, truncated, files}>}
 */
export async function readBundleFile(
  client,
  id,
  { version = "active", kind = "iflow", file, maxBytes = 20000 } = {}
) {
  const zip = await downloadArtifact(client, id, { version, kind });
  const entries = readZip(zip, { content: true });
  const nombres = entries.map((e) => e.name);

  // Exacto primero; despues por nombre de archivo, que es como lo va a pedir cualquiera que
  // haya leido la lista de Resources (ahi los nombres vienen sin ruta).
  let hit = entries.find((e) => e.name === file);
  if (!hit) {
    const porBase = entries.filter((e) => e.name.split("/").pop() === file);
    if (porBase.length === 1) hit = porBase[0];
    else if (porBase.length > 1) {
      const err = new Error(`Hay ${porBase.length} archivos llamados "${file}" en el bundle.`);
      err.hint = `Indicar la ruta completa: ${porBase.map((e) => e.name).join(", ")}`;
      throw err;
    }
  }
  if (!hit) {
    const err = new Error(`El bundle de "${id}" no contiene "${file}".`);
    err.hint = `Archivos disponibles: ${nombres.join(", ")}`;
    throw err;
  }

  const binary = isBinary(hit.data);
  const text = binary ? "" : hit.data.toString("utf8");

  return {
    name: hit.name,
    size: hit.data.length,
    binary,
    text: text.slice(0, maxBytes),
    truncated: text.length > maxBytes,
    files: nombres,
    data: hit.data,
  };
}

/**
 * Escritura local compartida por todos los "guardar a disco". No crea directorios: un destino
 * inexistente es un error con hint, no un mkdir silencioso.
 *
 * Y tampoco PISA: sin `overwrite`, un archivo que ya existe es un error. Estas tools van
 * anotadas `readOnlyHint:true` (no tocan el tenant) y el cliente puede auto-aprobarlas sin
 * confirmacion; sobreescribir un archivo local en silencio por esa via seria mentirle a la
 * anotacion. El flag "wx" hace del chequeo y la escritura una sola operacion, sin carrera.
 */
function writeLocal(saveTo, data, { overwrite = false } = {}) {
  try {
    writeFileSync(saveTo, data, overwrite ? {} : { flag: "wx" });
  } catch (e) {
    if (e.code === "EEXIST") {
      const err = new Error(`Ya existe "${saveTo}": no se pisa un archivo local sin pedirlo.`);
      err.hint = "Para reemplazarlo, repetir la llamada con overwrite:true; o elegir otra ruta.";
      throw err;
    }
    const err = new Error(`No se pudo escribir "${saveTo}": ${e.message}`);
    err.hint = "El directorio destino tiene que existir; conviene pasar una ruta absoluta.";
    throw err;
  }
}

/**
 * Guarda el zip de export de un package en el filesystem LOCAL, byte a byte.
 *
 * Se valida que sea un ZIP legible ANTES de escribir: en un backup, un archivo corrupto en
 * disco es peor que un error. `artifacts` cuenta los `<guid>_content` (uno por artefacto).
 *
 * @returns {Promise<{size: number, artifacts: number, savedTo: string}>}
 */
export async function savePackageZip(client, id, { saveTo, overwrite = false }) {
  const buf = await downloadPackage(client, id);
  const artifacts = readZip(buf).filter((e) => e.name.endsWith("_content")).length;
  writeLocal(saveTo, buf, { overwrite });
  return { size: buf.length, artifacts, savedTo: saveTo };
}

/**
 * Guarda el bundle COMPLETO de un artefacto en el filesystem LOCAL, byte a byte.
 * A diferencia de saveBundleFile (un archivo de adentro), aca va el ZIP entero.
 *
 * @returns {Promise<{size: number, files: number, savedTo: string}>}
 */
export async function saveArtifactZip(
  client,
  id,
  { version = "active", kind = "iflow", saveTo, overwrite = false } = {}
) {
  const buf = await downloadArtifact(client, id, { version, kind });
  const files = readZip(buf).length;
  writeLocal(saveTo, buf, { overwrite });
  return { size: buf.length, files, savedTo: saveTo };
}

/**
 * Guarda UN archivo del bundle en el filesystem LOCAL, byte a byte.
 *
 * Existe porque el contenido que muestra readBundleFile viaja como texto por el protocolo, y
 * re-tipear un archivo desde esa salida corrompe los blobs base64 de un `.mmap`: la unica
 * copia confiable es la que el server escribe directo del ZIP al disco. Nacio el 2026-08-25
 * para validar mappings importados del ESR contra el export `.tpz` de PRD.
 *
 * No crea directorios: un destino inexistente es un error con hint, no un mkdir silencioso.
 *
 * @returns {Promise<{name, size, binary, savedTo}>}
 */
export async function saveBundleFile(
  client,
  id,
  { version = "active", kind = "iflow", file, saveTo, overwrite = false } = {}
) {
  const f = await readBundleFile(client, id, { version, kind, file, maxBytes: 100 });
  writeLocal(saveTo, f.data, { overwrite });
  return { name: f.name, size: f.size, binary: f.binary, savedTo: saveTo };
}

