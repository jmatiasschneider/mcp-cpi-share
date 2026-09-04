/**
 * Helpers de formato compartidos por las tools. NO es una tool.
 *
 * Regla de contexto: las respuestas van pensadas para que las lea un modelo, no una
 * consola. Texto compacto, sin adornos, y siempre diciendo cuando hay mas datos.
 */

export function ok(text) {
  return { content: [{ type: "text", text }] };
}

// --- errores de validacion --------------------------------------------------

/**
 * Un ZodError trae el detalle util en `issues`, pero su `.message` es el volcado JSON de
 * ese array: `[{"code":"too_small","minimum":100,"inclusive":true,...}]`. El modelo lo puede
 * parsear, pero gasta un turno en algo que se resuelve diciendole la frase.
 *
 * Se detecta por forma y no con `instanceof z.ZodError` a proposito: asi este modulo no
 * depende de zod ni de que haya una sola copia de zod en el arbol.
 */
const isZodError = (err) => err?.name === "ZodError" && Array.isArray(err.issues);

const issuePath = (p) => (p?.length ? p.join(".") : "(raiz)");

/** Un issue "el parametro no vino" vs "vino con el tipo equivocado". */
const esFaltante = (i) =>
  i.code === "invalid_type" &&
  (i.received === "undefined" ||
    (Object.prototype.hasOwnProperty.call(i, "input") && i.input === undefined));

/**
 * Una frase por issue. Los `code` cubren zod 3 y los renombres de zod 4
 * (`type`→`origin`, `invalid_literal`/`invalid_enum_value`→`invalid_value`); lo que no
 * matchee cae en el default, que sigue siendo legible.
 */
function describeIssue(i) {
  const p = issuePath(i.path);
  const tipo = i.type ?? i.origin;

  switch (i.code) {
    case "invalid_type":
      return esFaltante(i)
        ? `falta el parametro requerido "${p}" (${i.expected})`
        : `"${p}": se esperaba ${i.expected} y llego ${i.received}`;

    case "unrecognized_keys":
      return (i.keys ?? []).map((k) => `el parametro "${k}" no existe en esta tool`).join("\n  - ");

    case "too_small":
      if (tipo === "string") {
        return i.minimum === 1
          ? `"${p}": no puede estar vacio`
          : `"${p}": necesita al menos ${i.minimum} caracteres`;
      }
      if (tipo === "array") return `"${p}": necesita al menos ${i.minimum} elemento(s)`;
      return `"${p}": tiene que ser ${i.inclusive === false ? ">" : ">="} ${i.minimum}`;

    case "too_big":
      if (tipo === "string") return `"${p}": a lo sumo ${i.maximum} caracteres`;
      if (tipo === "array") return `"${p}": a lo sumo ${i.maximum} elemento(s)`;
      return `"${p}": tiene que ser ${i.inclusive === false ? "<" : "<="} ${i.maximum}`;

    case "invalid_literal":
      return `"${p}": tiene que ser exactamente ${JSON.stringify(i.expected)}`;

    case "invalid_enum_value":
      return `"${p}": tiene que ser uno de ${(i.options ?? []).join(", ")} (llego ${JSON.stringify(i.received)})`;

    // zod 4 unifico literal y enum en invalid_value.
    case "invalid_value": {
      const vals = i.values ?? [];
      return vals.length === 1
        ? `"${p}": tiene que ser exactamente ${JSON.stringify(vals[0])}`
        : `"${p}": tiene que ser uno de ${vals.join(", ")}`;
    }

    case "invalid_union": {
      const esperados = [
        ...new Set((i.unionErrors ?? []).flatMap((e) => e.issues ?? []).map((x) => x.expected).filter(Boolean)),
      ];
      return esperados.length
        ? `"${p}": tiene que ser ${esperados.join(" o ")}`
        : `"${p}": no coincide con ninguno de los tipos aceptados`;
    }

    default:
      return `"${p}": ${i.message}`;
  }
}

/**
 * Cuando falta exactamente un parametro y sobra exactamente uno, casi siempre es el mismo
 * argumento con el nombre equivocado. Es el caso que motivo todo esto:
 * cpi_message_detail(id=…) cuando el parametro se llama messageGuid.
 */
function sugerenciaDeRenombre(issues) {
  const faltan = issues.filter(esFaltante).map((i) => issuePath(i.path));
  const sobran = issues
    .filter((i) => i.code === "unrecognized_keys")
    .flatMap((i) => i.keys ?? []);

  return faltan.length === 1 && sobran.length === 1
    ? `Quizas "${sobran[0]}" queria ser "${faltan[0]}".`
    : null;
}

function renderZodError(err) {
  const lineas = err.issues.map(describeIssue).filter(Boolean);
  const sug = sugerenciaDeRenombre(err.issues);

  return (
    `Argumentos invalidos:\n  - ${lineas.join("\n  - ")}` +
    (sug ? `\n\nSugerencia: ${sug}` : "")
  );
}

/** Error con hint accionable. Las tools NUNCA hacen throw. */
export function fail(err, { tool } = {}) {
  const parts = [];
  parts.push(isZodError(err) ? renderZodError(err) : err?.message ?? String(err));
  if (err?.hint) parts.push(`\nSugerencia: ${err.hint}`);
  if (err?.url) parts.push(`\nURL: ${err.url}`);
  if (tool) parts.push(`\n(tool: ${tool})`);
  return { isError: true, content: [{ type: "text", text: parts.join("") }] };
}

/**
 * Tabla de ancho fijo a partir de objetos. `cols` define orden y encabezados.
 *
 * Recorta las celdas a `anchoMax` para que la tabla no se desarme, pero **marca el recorte con `…`**:
 * una celda cortada en silencio parece un valor completo, y el modelo la copia al argumento de la
 * llamada siguiente. Ya paso con las rutas del bundle de `cpi_iflow_read`.
 *
 * `sinRecortar` exceptua las columnas cuyo valor es un IDENTIFICADOR que hay que poder copiar
 * (rutas de archivo, Ids). Ahi vale mas una fila ancha que un valor inservible.
 *
 * @param {object[]} rows
 * @param {string[]} [cols]
 * @param {{anchoMax?: number, sinRecortar?: string[]}} [opts]
 */
export function table(rows, cols, { anchoMax = 60, sinRecortar = [] } = {}) {
  if (!rows.length) return "(sin resultados)";
  const keys = cols ?? Object.keys(rows[0]);
  const entero = new Set(sinRecortar);

  const celda = (k, v) => {
    const s = String(v ?? "");
    if (entero.has(k) || s.length <= anchoMax) return s;
    return `${s.slice(0, anchoMax - 1)}…`;
  };

  const w = {};
  for (const k of keys) {
    w[k] = Math.max(k.length, ...rows.map((r) => celda(k, r[k]).length));
  }
  const line = (vals) => keys.map((k) => celda(k, vals[k]).padEnd(w[k])).join("  ").trimEnd();
  const header = keys.map((k) => k.padEnd(w[k])).join("  ").trimEnd();
  const sep = keys.map((k) => "-".repeat(w[k])).join("  ");
  return [header, sep, ...rows.map(line)].join("\n");
}

/** Lista clave: valor, saltando vacios. */
export function kv(obj, keys) {
  return (keys ?? Object.keys(obj))
    .filter((k) => obj[k] !== undefined && obj[k] !== null && obj[k] !== "")
    .map((k) => `${k}: ${obj[k]}`)
    .join("\n");
}

/**
 * Nota de paginacion. Se le pasan HECHOS, no se adivina: `total` cuando la entidad lo informa
 * (`$inlinecount`), `hasMore` cuando se pudo determinar pidiendo un registro de mas.
 *
 * El antecesor de esta funcion infería "puede haber mas" de `count >= top`, que miente cuando
 * la ultima pagina cae justa. Si no se sabe, ahora se dice que no se sabe.
 *
 * @param {{shown: number, skip?: number, total?: number|null, hasMore?: boolean|null}} p
 */
export function paging({ shown, skip = 0, total = null, hasMore = null }) {
  const siguiente = `pedi skip=${skip + shown} para la siguiente pagina`;

  if (total !== null && total !== undefined) {
    const hastaAca = skip + shown;
    return hastaAca < total
      ? `\n\n(${shown} de ${total} en total, desde skip=${skip} — ${siguiente})`
      : `\n\n(${shown} de ${total} en total: no hay mas)`;
  }
  if (hasMore === true) return `\n\n(${shown} desde skip=${skip}; hay mas — ${siguiente})`;
  if (hasMore === false) return `\n\n(${shown} desde skip=${skip}; no hay mas)`;
  return `\n\n(${shown} resultado(s); esta entidad no informa el total)`;
}
