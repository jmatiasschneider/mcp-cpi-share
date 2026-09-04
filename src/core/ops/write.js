/**
 * ops/write — creacion, clonado, validacion y deploy de artefactos.
 *
 * Contratos verificados contra el tenant (ver DISCOVERY.md):
 *  - POST /IntegrationDesigntimeArtifacts  -> 201. NO requiere X-CSRF-Token con Bearer.
 *    SAP asigna Version='1.0.0'; para leer/borrar despues se usa Version='active'.
 *  - Un Id duplicado devuelve HTTP 500 (no 409) con el motivo en error.message.value.
 *  - El tenant NUNCA compara el Bundle-SymbolicName contra el Id: ni al crear, ni al deployar
 *    (verificado el 2026-08-10 — un iFlow con el simbolo cambiado deploya y funciona). Lo que
 *    hace es CONGELARLO: el PUT rechaza con 400 cualquier cambio de esa clave. Por eso
 *    cloneArtifact() lo reescribe al clonar — es la unica oportunidad —, y por eso hay que
 *    hacerlo igual: dos bundles OSGi con el mismo simbolo colisionan si los dos se deployan.
 */

import { odataQuote, clean } from "../client.js";
import { readZip, writeZip } from "../zip.js";
import {
  externalizableProperties,
  externalizeProperty,
  mappingSteps,
  setMappingReference,
  parseProps,
  writeProps,
} from "../iflw.js";
import { downloadArtifact, entitySet, artifactKey } from "./design.js";

const MANIFEST = "META-INF/MANIFEST.MF";
const PROJECT = ".project";

// --- CRUD -------------------------------------------------------------------

/**
 * Crea un artefacto nuevo. `content` es un Buffer con el ZIP del bundle.
 *
 * `kind` elige la familia (iflow por default). Las cuatro se escriben igual: mismo cuerpo
 * con `ArtifactContent` en base64, solo cambia el entity set.
 */
export async function createArtifact(client, { id, name, packageId, content, kind = "iflow" }) {
  const { rows } = await client.post(entitySet(kind), {
    Id: id,
    Name: name ?? id,
    PackageId: packageId,
    ArtifactContent: content.toString("base64"),
  });
  return rows.length ? clean(rows[0], { fields: ["Id", "Version", "Name", "PackageId"] }) : { Id: id };
}

/** Reemplaza el contenido de un artefacto existente. Queda como borrador. */
export async function updateArtifact(
  client,
  { id, version = "active", name, content, kind = "iflow" }
) {
  const body = {};
  if (name) body.Name = name;
  if (content) body.ArtifactContent = content.toString("base64");

  await client.put(artifactKey(kind, id, version), body);
  return { Id: id, updated: Object.keys(body) };
}

/**
 * Los archivos que sostienen el artefacto: sin ellos el bundle deja de ser un bundle. El
 * `.iflw` se protege por sufijo y no por ruta porque su nombre no es predecible: en un clon
 * conserva el nombre del original.
 */
const NO_REMOVIBLES = new Set([MANIFEST, PROJECT, "metainfo.prop"]);

/**
 * Reemplaza, agrega y/o elimina archivos ADENTRO del bundle, sin tocar el resto.
 *
 * Es la forma util de editar un iFlow existente: bajar el ZIP, cambiar el Groovy / XSLT /
 * el .iflw, y volver a subirlo entero. `updateArtifact` sola no alcanza porque el API pide
 * el bundle completo en base64, no un archivo suelto. Eliminar funciona por la misma via:
 * el PUT reemplaza el bundle completo, asi que resubirlo sin un archivo lo borra.
 *
 * El MANIFEST.MF NO se reescribe: este artefacto ya existe con su Id, y el manifiesto que
 * tiene es el correcto. Reescribirlo aca (como si fuera un clon) lo romperia. Y eliminarlo
 * —igual que el .project, el metainfo.prop o el .iflw— se rechaza antes de bajar nada.
 *
 * Una ruta de removeFiles que no existe en el bundle es error, no un no-op: la unica forma
 * de pedirla es un typo, y "no borro nada y no aviso" es el sintoma mas caro de depurar.
 *
 * @param {{name?: string, data: string|Buffer}[]} [files] rutas relativas dentro del ZIP,
 *   con la misma forma que devuelve cpi_iflow_read(includeContent:true).
 * @param {string[]} [removeFiles] rutas a eliminar del bundle, mismas convenciones.
 */
export async function updateArtifactFiles(
  client,
  { id, version = "active", files = [], removeFiles = [], name, kind = "iflow" }
) {
  // Chequeos que no dependen del bundle van ANTES de la descarga: un pedido invalido no
  // tiene que costar un round-trip al tenant.
  const protegidos = removeFiles.filter((n) => NO_REMOVIBLES.has(n) || n.endsWith(".iflw"));
  if (protegidos.length) {
    const err = new Error(`No se puede eliminar: ${protegidos.join(", ")}.`);
    err.hint =
      "MANIFEST.MF, .project, metainfo.prop y el .iflw son la estructura del bundle; " +
      "sin ellos el artefacto deja de funcionar. No se elimino nada.";
    throw err;
  }
  const enAmbos = files.filter((f) => removeFiles.includes(f.name)).map((f) => f.name);
  if (enAmbos.length) {
    const err = new Error(`En 'files' y en 'removeFiles' a la vez: ${enAmbos.join(", ")}.`);
    err.hint = "Escribir y eliminar la misma ruta es contradictorio. No se cambio nada.";
    throw err;
  }

  const zip = await downloadArtifact(client, id, { version, kind });
  const entries = readZip(zip, { content: true });
  const existing = new Set(entries.map((e) => e.name));

  const inexistentes = removeFiles.filter((n) => !existing.has(n));
  if (inexistentes.length) {
    const err = new Error(
      `Ruta(s) a eliminar que no existen en el bundle: ${inexistentes.join(", ")}.`
    );
    err.hint =
      `Las rutas son las que lista cpi_iflow_read(id="${id}", includeContent:true). ` +
      "No se cambio nada.";
    throw err;
  }

  const byName = new Map(files.map((f) => [f.name, f.data]));
  const remove = new Set(removeFiles);
  const replaced = files.filter((f) => existing.has(f.name)).map((f) => f.name);
  const added = files.filter((f) => !existing.has(f.name)).map((f) => f.name);

  const out = entries
    .filter((e) => !remove.has(e.name))
    .map((e) =>
      byName.has(e.name) ? { name: e.name, data: byName.get(e.name) } : { name: e.name, data: e.data }
    );
  for (const n of added) out.push({ name: n, data: byName.get(n) });

  // El tenant rechaza un bundle con parameters.prop pero sin parameters.propdef: el PUT da
  // `500 — InputStream cannot be null`, que no nombra al culpable (verificado el 2026-08-29,
  // probe-remove-file). La dependencia es asimetrica — propdef solo, o ninguno de los dos,
  // se aceptan — asi que se ataja aca con un error que si lo nombra.
  const finales = new Set(out.map((e) => e.name));
  if (finales.has(PARAMS_PROP) && !finales.has(PARAMS_PROPDEF)) {
    const err = new Error(
      `El bundle quedaria con ${PARAMS_PROP} pero sin ${PARAMS_PROPDEF}, y eso el tenant lo ` +
        `rechaza con un 500 criptico.`
    );
    err.hint = "Eliminar los dos juntos, o ninguno. No se cambio nada.";
    throw err;
  }

  const content = writeZip(out);
  await updateArtifact(client, { id, version, name, content, kind });

  return { Id: id, replaced, added, removed: removeFiles, bytes: content.length, files: out.length };
}

// --- externalizar parametros -------------------------------------------------

const PARAMS_PROP = "src/main/resources/parameters.prop";
const PARAMS_PROPDEF = "src/main/resources/parameters.propdef";

/** El .iflw no se llama como el artefacto: en un clon conserva el nombre del original. */
function findIflw(entries) {
  const hit = entries.find((e) => e.name.endsWith(".iflw"));
  if (!hit) throw new Error("El bundle no contiene ningun archivo .iflw: no es un iFlow.");
  return hit;
}

/** Las propiedades del modelo que se pueden externalizar, para poder elegir sin adivinar. */
export async function inspectParameters(client, { id, version = "active" }) {
  const zip = await downloadArtifact(client, id, { version });
  const entries = readZip(zip, { content: true });
  const iflw = findIflw(entries).data.toString("utf8");
  const props = readZip(zip, { content: true }).find((e) => e.name === PARAMS_PROP);

  return {
    candidatos: externalizableProperties(iflw),
    yaExternalizados: [...parseProps(props?.data?.toString("utf8") ?? "")].map(([k, v]) => ({
      name: k,
      default: v,
    })),
  };
}

/**
 * Externaliza propiedades del modelo: pone `{{Nombre}}` como valor en el .iflw y declara el
 * default en parameters.prop.
 *
 * Es lo que convierte un iFlow hecho a mano en un ARQUETIPO clonable: sin esto, clonar copia
 * los valores hardcodeados y hay que abrir el editor para cambiarlos. Con esto, el clon se
 * ajusta entero con cpi_iflow_configure.
 *
 * Verificado el 2026-08-05: los parametros aparecen en la navegacion Configurations, el
 * artefacto pasa el Validate y setConfiguration los cambia sin tocar el modelo.
 *
 * @param {{key: string, name: string, currentValue?: string, default?: string}[]} params
 */
export async function externalizeParameters(client, { id, version = "active", params }) {
  const zip = await downloadArtifact(client, id, { version });
  const entries = readZip(zip, { content: true });

  const iflwEntry = findIflw(entries);
  let iflw = iflwEntry.data.toString("utf8");

  const propsEntry = entries.find((e) => e.name === PARAMS_PROP);
  const props = parseProps(propsEntry?.data?.toString("utf8") ?? "");

  const hechos = [];
  for (const p of params) {
    // externalizeProperty tira si no matchea o si es ambiguo: no se reemplaza a ciegas.
    const { xml, oldValue } = externalizeProperty(iflw, {
      key: p.key,
      name: p.name,
      currentValue: p.currentValue,
    });
    iflw = xml;
    const valorDefault = p.default ?? oldValue;
    props.set(p.name, valorDefault);
    hechos.push({ key: p.key, name: p.name, oldValue, default: valorDefault });
  }

  await updateArtifactFiles(client, {
    id,
    version,
    files: [
      { name: iflwEntry.name, data: iflw },
      { name: PARAMS_PROP, data: writeProps(props) },
    ],
  });

  return { Id: id, iflw: iflwEntry.name, params: hechos };
}

export async function deleteArtifact(client, { id, version = "active", kind = "iflow" }) {
  await client.del(artifactKey(kind, id, version));
  return { Id: id, deleted: true };
}

// --- validar / deployar -----------------------------------------------------

/** Devuelve el texto crudo de un FunctionImport que retorna Edm.String. */
async function callFunction(client, name, params) {
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}='${odataQuote(v)}'`)
    .join("&");
  const buf = await client.request("POST", `${name}?${qs}`, {
    raw: true,
    headers: { Accept: "application/json" },
  });
  const text = Buffer.isBuffer(buf) ? buf.toString("utf8").trim() : "";
  // Puede venir JSON envuelto ({"d":{"NombreDeLaFuncion":"..."}}) o texto pelado
  try {
    const j = JSON.parse(text);
    const d = j?.d;
    if (d && typeof d === "object") {
      const v = Object.values(d).find((x) => typeof x === "string");
      return v ?? JSON.stringify(d);
    }
    return typeof j === "string" ? j : text;
  } catch {
    return text;
  }
}

/**
 * Valida el artefacto SIN deployarlo. Devuelve el texto del resultado.
 *
 * ⚠️ Solo existe `ValidateIntegrationDesigntimeArtifact`: no hay Validate para mappings ni para
 * script collections. Para esas familias el primer feedback real llega recien en el deploy, y
 * por eso cada intento sale mas caro que con un iFlow.
 */
export function validateArtifact(client, { id, version = "active", kind = "iflow" }) {
  if (kind !== "iflow") {
    const err = new Error(`No existe validacion para los artefactos de tipo "${kind}".`);
    err.hint = "Solo los iFlows tienen Validate. Para el resto, el deploy es la primera verificacion.";
    throw err;
  }
  return callFunction(client, "ValidateIntegrationDesigntimeArtifact", { Id: id, Version: version });
}

/** Corre el chequeo de design guidelines. */
export function checkGuidelines(client, { id, version = "active" }) {
  return callFunction(client, "ExecuteIntegrationDesigntimeArtifactsGuidelines", {
    Id: id,
    Version: version,
  });
}

/**
 * FunctionImport de deploy por familia. Verificados en el `$metadata` del 2026-08-08; el dump
 * de julio solo declaraba el de iFlow, asi que el tenant gano estos en una actualizacion.
 */
const DEPLOY_FUNCTION = {
  iflow: "DeployIntegrationDesigntimeArtifact",
  mapping: "DeployMessageMappingDesigntimeArtifact",
  script: "DeployScriptCollectionDesigntimeArtifact",
  valuemapping: "DeployValueMappingDesigntimeArtifact",
};

/**
 * Dispara el deploy.
 *
 * ⚠️ Solo el de iFlow devuelve TaskId. `DeployMessageMappingDesigntimeArtifact` responde con el
 * **body vacio** aunque el deploy arranque bien (verificado el 2026-08-08 sobre MM_TEST_TRIVIAL).
 * Tomar eso por error es un falso negativo sobre un deploy exitoso — ya paso en la primera
 * corrida de la sonda. Sin TaskId no hay `BuildAndDeployStatus` que consultar: hay que esperar
 * sobre `IntegrationRuntimeArtifacts` con `waitForRuntime`.
 *
 * @returns {Promise<string>} el TaskId, o cadena vacia si la familia no lo devuelve.
 */
export async function deployArtifact(client, { id, version = "active", kind = "iflow" }) {
  const fn = DEPLOY_FUNCTION[kind];
  if (!fn) {
    throw new Error(
      `No hay FunctionImport de deploy para "${kind}". Opciones: ${Object.keys(DEPLOY_FUNCTION).join(", ")}`
    );
  }
  return callFunction(client, fn, { Id: id, Version: version });
}

/** true si esa familia informa el avance del deploy con un TaskId consultable. */
export const deployDevuelveTaskId = (kind = "iflow") => kind === "iflow";

/**
 * Saca un artefacto del runtime.
 *
 * No hay FunctionImport de undeploy en el $metadata: se hace borrando el registro de
 * IntegrationRuntimeArtifacts. El artefacto de designtime NO se toca.
 */
export async function undeployArtifact(client, { id }) {
  await client.del(`IntegrationRuntimeArtifacts('${odataQuote(id)}')`);
  return { Id: id, undeployed: true };
}

/** Estado de un deploy disparado. BuildAndDeployStatus solo responde con la key. */
export async function deployStatus(client, taskId) {
  const { rows } = await client.get(`BuildAndDeployStatus(TaskId='${odataQuote(taskId)}')`);
  return rows.length ? clean(rows[0]) : null;
}

/**
 * Estados transitorios observados en el tenant. El deploy pasa por
 * BuildAndDeployStatus=DEPLOYING y el runtime por STARTING / STOPPING antes de
 * asentarse. Tratarlos como finales fue un bug real: el primer probe reporto
 * "no quedo en STARTED" sobre un artefacto que estaba arrancando bien.
 */
const TRANSIENT = new Set(["DEPLOYING", "PROCESSING", "IN_PROGRESS", "RUNNING", "STARTING", "STOPPING"]);

export const isTransient = (s) => {
  const v = String(s ?? "").toUpperCase();
  return v === "" || TRANSIENT.has(v) || v.endsWith("ING");
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Espera a que el deploy salga de DEPLOYING. Devuelve el ultimo estado observado. */
export async function waitForDeploy(client, taskId, { timeoutMs = 90000, everyMs = 3000 } = {}) {
  const until = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < until) {
    last = await deployStatus(client, taskId).catch(() => null);
    if (last && !isTransient(last.Status)) return last;
    await sleep(everyMs);
  }
  return last;
}

/**
 * Espera a que un artefacto se asiente en el runtime.
 * @returns el registro final, o null si desaparecio (caso undeploy).
 */
export async function waitForRuntime(
  client,
  id,
  { expectGone = false, timeoutMs = 90000, everyMs = 3000 } = {}
) {
  const { listDeployed } = await import("./runtime.js");
  const until = Date.now() + timeoutMs;
  let last = null;

  while (Date.now() < until) {
    const all = await listDeployed(client).catch(() => []);
    last = all.find((a) => a.Id === id) ?? null;

    if (expectGone && !last) return null;
    if (!expectGone && last && !isTransient(last.Status)) return last;

    await sleep(everyMs);
  }
  return last;
}

// --- clonar -----------------------------------------------------------------

/**
 * Reescribe el MANIFEST.MF de un bundle para que apunte a un artefacto nuevo.
 *
 * OJO con el formato: MANIFEST.MF parte las lineas largas a los 72 bytes y las continua
 * con una linea que arranca en espacio. Solo tocamos claves cuyo valor es corto (nombres
 * de bundle), asi que no hace falta re-wrappear — pero SI hay que respetar las
 * continuaciones existentes al parsear, o se rompe el Import-Package.
 */
export function rewriteManifest(text, { id, name }) {
  const KEYS = {
    "Bundle-Name": name ?? id,
    "Bundle-SymbolicName": `${id}; singleton:=true`,
    "Origin-Bundle-Name": name ?? id,
    "Origin-Bundle-SymbolicName": id,
  };

  const lines = text.split(/\r?\n/);
  const out = [];
  let skipping = false;

  for (const line of lines) {
    if (line.startsWith(" ")) {
      // linea de continuacion: pertenece a la clave anterior
      if (!skipping) out.push(line);
      continue;
    }
    skipping = false;
    const key = line.split(":")[0];
    if (Object.prototype.hasOwnProperty.call(KEYS, key)) {
      out.push(`${key}: ${KEYS[key]}`);
      skipping = true; // descartar las continuaciones del valor viejo
      continue;
    }
    out.push(line);
  }

  return out.join("\n");
}

/**
 * La clausula de capability con la que un iFlow declara que usa un message mapping del package.
 *
 * `source:String="reference"` es lo que la distingue del caso embebido (el .mmap adentro del
 * propio bundle del iFlow). Verificado en DISCOVERY sobre un iFlow que la UI dejo enganchado.
 */
export const messageMappingCapability = (id) =>
  `messagemapping.${id};resolution:=optional;bundleType:String="MessageMapping";source:String="reference"`;

/**
 * Parte `Clave: valor` en lineas de a lo sumo 72 bytes, como manda el formato del MANIFEST.
 * Las continuaciones arrancan con UN espacio, que no es parte del valor — por eso al plegar
 * llevan 71 bytes utiles y no 72.
 */
function foldHeader(key, value) {
  const buf = Buffer.from(`${key}: ${value}`, "utf8");
  const out = [buf.subarray(0, 72).toString("utf8")];
  for (let i = 72; i < buf.length; i += 71) {
    out.push(" " + buf.subarray(i, i + 71).toString("utf8"));
  }
  return out;
}

/**
 * Suma una clausula al header `Require-Capability`, respetando el que ya haya.
 *
 * Un MANIFEST no admite la misma clave dos veces: si el header ya existe, la clausula se agrega
 * a la lista separada por comas en vez de escribir un segundo `Require-Capability`.
 *
 * El resto del archivo pasa **literal**, incluidas las continuaciones del Import-Package: se
 * repliega solo la clave que se toca. Volver a plegar el manifiesto entero daria un archivo
 * equivalente pero distinto del que escribio SAP, y eso no se nota al crear el artefacto — se
 * nota al deployar.
 *
 * @returns {{text: string, changed: boolean}} `changed:false` si esa capability ya estaba.
 */
export function addRequireCapability(text, clause) {
  const KEY = "Require-Capability";
  const ns = clause.split(";")[0].trim();

  const out = [];
  let existente = null;
  let idx = -1;
  let enHeader = false;

  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith(" ")) {
      // linea de continuacion: pertenece a la clave anterior
      if (enHeader) existente += line.slice(1);
      else out.push(line);
      continue;
    }
    enHeader = false;
    if (line.split(":")[0] === KEY) {
      existente = line.slice(KEY.length + 1).replace(/^ /, "");
      idx = out.length;
      enHeader = true;
      continue;
    }
    out.push(line);
  }

  const yaEsta =
    existente !== null && existente.split(",").some((c) => c.split(";")[0].trim() === ns);
  const valor = existente === null ? clause : yaEsta ? existente : `${existente},${clause}`;
  const header = foldHeader(KEY, valor);

  if (idx >= 0) {
    out.splice(idx, 0, ...header);
  } else {
    // El manifiesto termina en linea vacia; el header va antes de esa cola, no despues.
    let fin = out.length;
    while (fin > 0 && out[fin - 1].trim() === "") fin--;
    out.splice(fin, 0, ...header);
  }

  const res = out.join("\n");
  return { text: res.endsWith("\n") ? res : res + "\n", changed: !yaEsta };
}

/**
 * Reescribe el <name> del descriptor de proyecto de Eclipse.
 *
 * El reemplazo va por funcion, no por string: en un string de reemplazo `$&` y `$1` son
 * patrones que String.replace expande, asi que un Id que los contenga se reinyectaria a si
 * mismo el texto matcheado.
 */
export function rewriteProject(text, { id }) {
  return text.replace(/<name>[^<]*<\/name>/, () => `<name>${id}</name>`);
}

/**
 * Clona un iFlow existente bajo un Id nuevo, reescribiendo el bundle.
 *
 * Este es el camino recomendado para crear iFlows: generar el BPMN desde cero es
 * inviable (el MANIFEST trae ~1.5 KB de Import-Package de internals de Camel/CXF).
 */
export async function cloneArtifact(
  client,
  { sourceId, sourceVersion = "active", targetId, targetName, targetPackageId, kind = "iflow" }
) {
  const zip = await downloadArtifact(client, sourceId, { version: sourceVersion, kind });
  const entries = readZip(zip, { content: true });

  const rewritten = entries.map((e) => {
    if (e.name === MANIFEST) {
      return {
        name: e.name,
        data: rewriteManifest(e.data.toString("utf8"), { id: targetId, name: targetName }),
      };
    }
    if (e.name === PROJECT) {
      return { name: e.name, data: rewriteProject(e.data.toString("utf8"), { id: targetId }) };
    }
    return { name: e.name, data: e.data };
  });

  const content = writeZip(rewritten);
  const created = await createArtifact(client, {
    id: targetId,
    name: targetName ?? targetId,
    packageId: targetPackageId,
    content,
    kind,
  });

  return {
    ...created,
    sourceId,
    bytes: content.length,
    files: rewritten.map((e) => e.name),
  };
}

// --- referenciar un message mapping desde un iFlow --------------------------

/** Los pasos de Message Mapping de un iFlow, para saber cual enganchar sin abrir la UI. */
export async function listMappingSteps(client, { id, version = "active" }) {
  const zip = await downloadArtifact(client, id, { version });
  const entries = readZip(zip, { content: true });
  const iflw = findIflw(entries);
  return { iflw: iflw.name, steps: mappingSteps(iflw.data.toString("utf8")) };
}

/**
 * Engancha un message mapping del package a un paso de un iFlow, por referencia.
 *
 * Toca DOS archivos del bundle del iFlow, y con uno solo no alcanza: las propiedades del paso en
 * el `.iflw` dicen a que apunta, y el `Require-Capability` del `MANIFEST.MF` es lo que declara la
 * dependencia en el bundle OSGi. Escribir solo el modelo deja un iFlow que "se ve" bien en el
 * editor y falla al resolver el mapping.
 *
 * El `.mmap` NO se copia adentro del iFlow: es un puntero de verdad. Por eso el mapping tiene que
 * estar deployado ANTES que el iFlow — no hay auto-deploy del referenciado.
 */
export async function referenceMapping(
  client,
  { iflowId, version = "active", mappingId, mappingVersion = "active", step }
) {
  // La ruta del .mmap se LEE del bundle en vez de derivarla del Id, porque el nombre del archivo
  // no es predecible desde afuera: al clonar, el tenant lo renombra al Id nuevo (2026-08-10), pero
  // un bundle importado a mano puede traer cualquier nombre. Leerlo acierta en los dos casos.
  const mzip = await downloadArtifact(client, mappingId, { version: mappingVersion, kind: "mapping" });
  const mmaps = readZip(mzip).filter((e) => e.name.endsWith(".mmap"));
  if (!mmaps.length) {
    const err = new Error(`El bundle de "${mappingId}" no contiene ningun .mmap.`);
    err.hint = "Verificar que el Id sea el de un message mapping y no el de otra familia.";
    throw err;
  }
  if (mmaps.length > 1) {
    const err = new Error(`El bundle de "${mappingId}" tiene ${mmaps.length} archivos .mmap.`);
    err.hint = `No se puede elegir a ciegas cual referenciar: ${mmaps.map((e) => e.name).join(", ")}`;
    throw err;
  }
  const mmapPath = mmaps[0].name;

  const zip = await downloadArtifact(client, iflowId, { version });
  const entries = readZip(zip, { content: true });

  const iflwEntry = findIflw(entries);
  const ref = setMappingReference(iflwEntry.data.toString("utf8"), { step, mappingId, mmapPath });

  const manEntry = entries.find((e) => e.name === MANIFEST);
  if (!manEntry) throw new Error(`El bundle de "${iflowId}" no tiene ${MANIFEST}.`);
  const man = addRequireCapability(
    manEntry.data.toString("utf8"),
    messageMappingCapability(mappingId)
  );

  await updateArtifactFiles(client, {
    id: iflowId,
    version,
    files: [
      { name: iflwEntry.name, data: ref.xml },
      { name: MANIFEST, data: man.text },
    ],
  });

  return {
    iflowId,
    mappingId,
    mmapPath,
    iflw: iflwEntry.name,
    step: ref.step,
    before: ref.before,
    values: ref.values,
    agregadas: ref.agregadas,
    manifestChanged: man.changed,
  };
}

// --- parametros externalizados ----------------------------------------------

/** Setea un parametro externalizado. Es la forma robusta de configurar un clon. */
export async function setConfiguration(
  client,
  { id, version = "active", key, value, dataType = "xsd:string" }
) {
  await client.put(
    `IntegrationDesigntimeArtifacts(Id='${odataQuote(id)}',Version='${odataQuote(version)}')` +
      `/$links/Configurations('${odataQuote(key)}')`,
    { ParameterValue: String(value), DataType: dataType }
  );
  return { key, value };
}
