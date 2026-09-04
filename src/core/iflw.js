/**
 * iflw — lectura y reescritura del modelo de un iFlow y de sus parametros externalizados.
 *
 * Es un modulo de FORMATO, como zip.js: no sabe de HTTP ni de OData. Le entra texto y le sale
 * texto. La orquestacion (bajar el bundle, subirlo) vive en ops/write.js.
 *
 * Dos formatos conviven adentro del bundle:
 *
 *  - `…/<nombre>.iflw` — BPMN2 con las propiedades de cada componente como pares
 *    `<ifl:property><key>K</key><value>V</value></ifl:property>`. Un valor vacio se escribe
 *    `<value/>`, no `<value></value>`.
 *  - `src/main/resources/parameters.prop` — properties de Java: `Nombre=valor` con `:` y `=`
 *    escapados en el valor.
 *
 * Externalizar un parametro = poner `{{Nombre}}` como valor en el .iflw y declarar
 * `Nombre=<default>` en parameters.prop.
 *
 * ⚠️ Verificado contra el tenant el 2026-08-05: **parameters.propdef NO hace falta**. Se
 * externalizaron tres parametros dejando el propdef con `<param_references/>` vacio y los tres
 * aparecieron igual en la navegacion `Configurations`, con DataType xsd:string, y el artefacto
 * paso el Validate. El propdef parece ser metadata del editor de Eclipse, no del tenant.
 */

const PROP_RE = /<key>([\s\S]*?)<\/key>\s*(?:<value>([\s\S]*?)<\/value>|<value\s*\/>)/g;

/** Escapa un string para meterlo en un regex. */
const rx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Todas las propiedades del modelo, en orden de aparicion.
 * @returns {{key: string, value: string}[]}
 */
export function listProperties(xml) {
  const out = [];
  for (const m of String(xml).matchAll(PROP_RE)) {
    out.push({ key: m[1].trim(), value: (m[2] ?? "").trim() });
  }
  return out;
}

/**
 * Propiedades que tiene sentido ofrecer para externalizar: las que tienen un valor y no son
 * ruido del editor. Se filtra por lista negra explicita y no por heuristica, para no esconder
 * algo que el usuario si quiera parametrizar.
 */
const RUIDO = new Set([
  "cmdVariantUri",
  "componentVersion",
  "ComponentType",
  "ComponentNS",
  "ComponentSWCVName",
  "ComponentSWCVId",
  "TransportProtocol",
  "TransportProtocolVersion",
  "MessageProtocol",
  "MessageProtocolVersion",
  "ifl:type",
  "direction",
  "system",
  "Name",
  "activityType",
  "bodyType",
]);

export function externalizableProperties(xml) {
  const vistos = new Map();
  for (const p of listProperties(xml)) {
    if (!p.value || RUIDO.has(p.key)) continue;
    if (p.value.startsWith("{{") && p.value.endsWith("}}")) continue; // ya externalizado
    // Se cuenta cuantas veces aparece cada clave: si aparece mas de una, hay que desambiguar.
    const prev = vistos.get(p.key);
    if (prev) prev.push(p.value);
    else vistos.set(p.key, [p.value]);
  }
  return [...vistos].map(([key, values]) => ({ key, values, ambiguo: values.length > 1 }));
}

/**
 * Reemplaza el valor de una propiedad por `{{name}}`.
 *
 * @param {string} xml
 * @param {{key: string, name: string, currentValue?: string}} p
 *   `currentValue` desambigua cuando la misma clave aparece en varios componentes
 *   (`componentVersion` esta por todos lados, pero tambien pasa con claves reales).
 * @returns {{xml: string, oldValue: string}}
 * @throws si no matchea nada o si matchea de forma ambigua. Nunca reemplaza "el primero que
 *   encuentre": elegir en silencio cual de varios componentes se toca seria el peor default.
 */
export function externalizeProperty(xml, { key, name, currentValue }) {
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) {
    throw new Error(
      `"${name}" no sirve como nombre de parametro: solo letras, numeros, guion bajo y punto, ` +
        `y no puede empezar con numero.`
    );
  }

  const re = new RegExp(
    `(<key>\\s*${rx(key)}\\s*</key>\\s*)<value>([\\s\\S]*?)</value>`,
    "g"
  );

  const matches = [...String(xml).matchAll(re)].filter(
    (m) => currentValue === undefined || m[2].trim() === currentValue
  );

  if (!matches.length) {
    throw new Error(
      currentValue === undefined
        ? `No hay ninguna propiedad "${key}" con valor en el modelo.`
        : `No hay ninguna propiedad "${key}" cuyo valor sea "${currentValue}".`
    );
  }
  if (matches.length > 1) {
    const vals = matches.map((m) => `"${m[2].trim()}"`).join(", ");
    throw new Error(
      `La propiedad "${key}" aparece ${matches.length} veces (valores: ${vals}). ` +
        `Indicar cual con "currentValue" para no tocar el componente equivocado.`
    );
  }

  const m = matches[0];
  const oldValue = m[2].trim();
  const xmlNuevo =
    String(xml).slice(0, m.index) +
    `${m[1]}<value>{{${name}}}</value>` +
    String(xml).slice(m.index + m[0].length);

  return { xml: xmlNuevo, oldValue };
}

// --- pasos de mapping -------------------------------------------------------

/**
 * Un paso del modelo es un `<bpmn2:callActivity>` y su tipo esta en la propiedad `activityType`.
 * No hay callActivity anidados en un .iflw, asi que el no-greedy alcanza para aislar el bloque.
 */
const CALL_ACTIVITY_RE = /<(?:\w+:)?callActivity\b[^>]*>[\s\S]*?<\/(?:\w+:)?callActivity>/g;

const openTag = (block) => block.match(/^<[^>]*>/)?.[0] ?? "";
const tagAttr = (block, name) =>
  openTag(block).match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? "";

/**
 * Los pasos de Message Mapping del modelo, con lo que hoy tienen apuntado.
 *
 * Se devuelve `id` y `name` porque son las dos formas en que alguien identifica un paso: el
 * `CallActivity_7` sale de leer el .iflw, y el "Message Mapping 1" es lo que se ve en la UI.
 */
export function mappingSteps(xml) {
  const out = [];
  for (const m of String(xml).matchAll(CALL_ACTIVITY_RE)) {
    const props = new Map(listProperties(m[0]).map((p) => [p.key, p.value]));
    if (props.get("activityType") !== "Mapping") continue;
    out.push({
      id: tagAttr(m[0], "id"),
      name: tagAttr(m[0], "name"),
      mappingType: props.get("mappingType") ?? "",
      mappingname: props.get("mappingname") ?? "",
      messageMappingBundleId: props.get("messageMappingBundleId") ?? "",
      index: m.index,
      length: m[0].length,
    });
  }
  return out;
}

const escXml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Un valor vacio se escribe `<value/>`, que es como lo escribe SAP. */
const valueTag = (v) => (v === "" ? "<value/>" : `<value>${escXml(v)}</value>`);

/**
 * Escribe una propiedad DENTRO de un bloque de paso: la reemplaza si existe, la agrega si no.
 *
 * Reemplazar solo lo que ya esta no alcanza: un paso de mapping recien puesto en el modelo
 * puede no traer todavia `messageMappingBundleId`, y sin esa clave la referencia no resuelve.
 */
function setBlockProperty(block, key, value) {
  const re = new RegExp(
    `(<key>\\s*${rx(key)}\\s*</key>\\s*)(?:<value>[\\s\\S]*?</value>|<value\\s*/>)`
  );
  // El reemplazo va por funcion: en un string, `$&` y `$1` los expande String.replace, y un
  // valor que los contenga se reinyectaria el texto matcheado.
  if (re.test(block)) return { block: block.replace(re, (_m, head) => head + valueTag(value)), added: false };

  const cierre = block.match(/([ \t]*)<\/(?:\w+:)?extensionElements>/);
  if (!cierre) {
    throw new Error(`El paso no tiene <extensionElements>: no se le puede escribir "${key}".`);
  }
  const ind = cierre[1];
  const pfx = block.match(/<(\w+):property>/)?.[1] ?? "ifl";
  const nuevo =
    `${ind}    <${pfx}:property>\n` +
    `${ind}        <key>${key}</key>\n` +
    `${ind}        ${valueTag(value)}\n` +
    `${ind}    </${pfx}:property>\n`;

  return { block: block.replace(cierre[0], () => nuevo + cierre[0]), added: true };
}

/** El paso pedido, o un error que nombra los que hay. Nunca elige "el primero" en silencio. */
function elegirPaso(pasos, step) {
  if (!pasos.length) {
    const err = new Error("El modelo no tiene ningun paso de Message Mapping.");
    err.hint =
      "La referencia se pone sobre un paso que ya existe: el arquetipo tiene que traer el " +
      "Message Mapping puesto. Agregarlo desde cero es editar el BPMN, que esta fuera de alcance.";
    throw err;
  }
  if (step !== undefined) {
    const hit = pasos.filter((p) => p.id === step || p.name === step);
    if (!hit.length) {
      const err = new Error(`No hay ningun paso de mapping que se llame o tenga Id "${step}".`);
      err.hint = `Pasos disponibles: ${pasos.map((p) => `${p.id} ("${p.name}")`).join(", ")}`;
      throw err;
    }
    if (hit.length > 1) {
      const err = new Error(`"${step}" identifica ${hit.length} pasos a la vez.`);
      err.hint = `Usar el Id: ${hit.map((p) => p.id).join(", ")}`;
      throw err;
    }
    return hit[0];
  }
  if (pasos.length > 1) {
    const err = new Error(`El modelo tiene ${pasos.length} pasos de mapping.`);
    err.hint = `Indicar cual con "step": ${pasos.map((p) => `${p.id} ("${p.name}")`).join(", ")}`;
    throw err;
  }
  return pasos[0];
}

/**
 * Apunta un paso de mapping del modelo a un message mapping del package (referencia, no copia).
 *
 * Las seis propiedades salen de DISCOVERY, leidas de un iFlow que la UI dejo enganchado.
 * `mappingReference=static` + `source:String="reference"` en el MANIFEST es lo que distingue el
 * caso referenciado del embebido; escribir solo esto y no el manifiesto deja el bundle OSGi sin
 * declarar la dependencia, asi que las dos mitades van juntas (ver ops/write.js).
 *
 * @param {{step?: string, mappingId: string, mmapPath: string}} p
 *   `mmapPath` es la ruta REAL del .mmap dentro del bundle del mapping, leida del bundle. No se
 *   deriva del Id porque el nombre del archivo no es predecible: el tenant lo normaliza al clonar,
 *   pero un bundle importado a mano puede traer cualquier nombre.
 * @returns {{xml, step, before: object, values: object, agregadas: string[]}}
 */
export function setMappingReference(xml, { step, mappingId, mmapPath }) {
  const pasos = mappingSteps(xml);
  const elegido = elegirPaso(pasos, step);

  if (!mmapPath.endsWith(".mmap")) {
    throw new Error(`"${mmapPath}" no es un .mmap: no sirve como destino de la referencia.`);
  }
  const sinExt = mmapPath.slice(0, -".mmap".length);

  const values = {
    mappinguri: `dir://mmap/${mmapPath}`,
    mappingname: sinExt.split("/").pop(),
    mappingpath: sinExt,
    messageMappingBundleId: mappingId,
    mappingType: "MessageMapping",
    mappingReference: "static",
  };

  let block = String(xml).slice(elegido.index, elegido.index + elegido.length);
  const agregadas = [];
  for (const [k, v] of Object.entries(values)) {
    const r = setBlockProperty(block, k, v);
    block = r.block;
    if (r.added) agregadas.push(k);
  }

  return {
    xml: String(xml).slice(0, elegido.index) + block + String(xml).slice(elegido.index + elegido.length),
    step: { id: elegido.id, name: elegido.name },
    before: {
      mappingname: elegido.mappingname,
      messageMappingBundleId: elegido.messageMappingBundleId,
      mappingType: elegido.mappingType,
    },
    values,
    agregadas,
  };
}

// --- parameters.prop (properties de Java) -----------------------------------

/**
 * Parsea un .properties simple. Alcanza para este archivo: lo escribe SAP o lo escribimos
 * nosotros, no es entrada libre del usuario. No soporta continuacion de linea con `\`.
 */
export function parseProps(text) {
  const out = new Map();
  for (const linea of String(text ?? "").split(/\r?\n/)) {
    const l = linea.trim();
    if (!l || l.startsWith("#") || l.startsWith("!")) continue;
    const i = l.search(/(?<!\\)[=:]/);
    if (i < 0) continue;
    out.set(unescapeProp(l.slice(0, i).trim()), unescapeProp(l.slice(i + 1).trim()));
  }
  return out;
}

const escapeProp = (s) => String(s).replace(/([=:\\])/g, "\\$1");
const unescapeProp = (s) => String(s).replace(/\\([=:\\])/g, "$1");

/** Serializa el .properties conservando un encabezado con fecha, como hace SAP. */
export function writeProps(map) {
  const lineas = [`#${new Date().toUTCString()}`];
  for (const [k, v] of map) lineas.push(`${escapeProp(k)}=${escapeProp(v)}`);
  return lineas.join("\n") + "\n";
}
