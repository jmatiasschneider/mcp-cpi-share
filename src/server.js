/**
 * createServer(deps) — registra las tools y devuelve el Server MCP.
 *
 * ⚠️ Esta capa NO conoce el transporte. Nada de stdio ni HTTP aca ni en src/tools/.
 * El entrypoint (bin/stdio.js hoy, bin/http.js si alguna vez llega la Fase 2) es el
 * unico que sabe como se habla con el cliente.
 *
 * El contexto viaja POR INVOCACION (`handler(args, ctx)`), no capturado en un closure.
 * Con stdio hay un solo ctx y da igual; con HTTP hay N sesiones concurrentes, cada una
 * con su token e identidad. Es una linea por tool ahora y una refactorizacion despues.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import * as ping from "./tools/cpi-ping.js";
import * as packages from "./tools/cpi-packages.js";
import * as iflowList from "./tools/cpi-iflow-list.js";
import * as iflowRead from "./tools/cpi-iflow-read.js";
import * as download from "./tools/cpi-download.js";
import * as messages from "./tools/cpi-messages.js";
import * as messageDetail from "./tools/cpi-message-detail.js";
import * as trace from "./tools/cpi-trace.js";
import * as deployed from "./tools/cpi-deployed.js";
import * as credentials from "./tools/cpi-credentials.js";
import * as packageCreate from "./tools/cpi-package-create.js";
import * as iflowClone from "./tools/cpi-iflow-clone.js";
import * as iflowConfigure from "./tools/cpi-iflow-configure.js";
import * as iflowUpdate from "./tools/cpi-iflow-update.js";
import * as iflowExternalize from "./tools/cpi-iflow-externalize.js";
import * as iflowMapping from "./tools/cpi-iflow-mapping.js";
import * as iflowValidate from "./tools/cpi-iflow-validate.js";
import * as deploy from "./tools/cpi-deploy.js";
import * as undeploy from "./tools/cpi-undeploy.js";
import * as iflowDelete from "./tools/cpi-iflow-delete.js";
import * as invoke from "./tools/cpi-invoke.js";

const MODULES = [
  // lectura
  ping,
  packages,
  iflowList,
  iflowRead,
  download,
  messages,
  messageDetail,
  trace,
  deployed,
  credentials,
  // escritura
  packageCreate,
  iflowClone,
  iflowConfigure,
  iflowUpdate,
  iflowExternalize,
  iflowMapping,
  iflowValidate,
  deploy,
  undeploy,
  iflowDelete,
  // ejecucion (plano de runtime, service key del plan `integration-flow`)
  invoke,
];

/**
 * Hints de comportamiento por tool. Si falta una, el server avisa por stderr:
 * es facil olvidarse al agregar una tool nueva y el cliente MCP los usa para
 * decidir que puede ejecutar sin confirmacion.
 */
const ANNOTATIONS = {
  cpi_ping: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  cpi_packages: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  cpi_iflow_list: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  cpi_iflow_read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  // Solo LEE del tenant; escribe un .zip local en saveTo (igual que el saveTo de cpi_iflow_read).
  // Un archivo existente no se pisa sin overwrite:true — sin esa barrera, el readOnlyHint que
  // el cliente usa para auto-aprobar taparia una sobreescritura local silenciosa.
  cpi_download: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  cpi_messages: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  cpi_message_detail: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  cpi_trace: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  cpi_deployed: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  cpi_credentials: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },

  // Escritura. `destructiveHint` marca las que pisan algo que ya existe.
  // Crear un package no pisa nada: si el Id existe, el tenant rechaza con 500.
  cpi_package_create: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  cpi_iflow_clone: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  cpi_iflow_configure: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  cpi_iflow_update: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  cpi_iflow_externalize: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  // Idempotente: reescribe siempre las mismas seis propiedades y una sola clausula de capability.
  cpi_iflow_mapping: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  cpi_iflow_validate: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  cpi_deploy: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  cpi_undeploy: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  cpi_iflow_delete: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },

  // No escribe en el tenant, pero EJECUTA: el iFlow puede tocar sistemas de verdad.
  // readOnlyHint:false es a proposito — que el cliente pida confirmacion.
  cpi_invoke: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

/**
 * Tools con efecto: bloqueadas si el profile es readonly.
 * cpi_iflow_validate NO esta aca: valida sin modificar nada.
 *
 * `cpi_invoke` si esta, aunque no escriba en el tenant: ejecuta un iFlow, y ese iFlow puede
 * mandar una orden a un backend real. Un profile readonly tiene que ser inofensivo de verdad,
 * no solo no dejar rastro en Cloud Integration.
 */
const WRITE_TOOLS = new Set([
  "cpi_package_create",
  "cpi_iflow_clone",
  "cpi_iflow_configure",
  "cpi_iflow_update",
  "cpi_iflow_externalize",
  "cpi_iflow_mapping",
  "cpi_deploy",
  "cpi_undeploy",
  "cpi_iflow_delete",
  "cpi_invoke",
]);

const log = (...a) => console.error("[mcp-cpi]", ...a);

/**
 * @param {{config: object,
 *          client: import("./core/client.js").CpiClient,
 *          runtimeClient?: import("./core/runtime-client.js").RuntimeClient|null}} deps
 *
 * `runtimeClient` es opcional: un profile sin la key del plan `integration-flow` es config
 * valida. Las tools que lo necesitan chequean `ctx.runtime` y explican que falta.
 */
export function createServer({ config, client, runtimeClient = null }) {
  const server = new Server(
    // La version es la del package.json: dos numeros distintos confunden un diagnostico.
    { name: "mcp-cpi", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  const byName = new Map();
  for (const mod of MODULES) {
    const def = mod.definition;
    if (byName.has(def.name)) throw new Error(`Tool duplicada: ${def.name}`);
    if (!ANNOTATIONS[def.name]) log(`AVISO: la tool ${def.name} no tiene entrada en ANNOTATIONS`);
    byName.set(def.name, mod);
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...byName.values()].map((m) => ({
      name: m.definition.name,
      description: m.definition.description,
      inputSchema: m.definition.jsonSchema,
      annotations: ANNOTATIONS[m.definition.name] ?? {},
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const mod = byName.get(name);

    if (!mod) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Tool desconocida: ${name}. Disponibles: ${[...byName.keys()].join(", ")}`,
          },
        ],
      };
    }

    if (config.policy === "readonly" && WRITE_TOOLS.has(name)) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              `La tool ${name} escribe en el tenant y el profile "${config.profile}" esta en ` +
              `policy "readonly". Para habilitarla, cambiar "policy" a "readwrite" en systems.json.`,
          },
        ],
      };
    }

    // El contexto se arma por invocacion: es la costura que permite HTTP multi-sesion.
    const ctx = {
      client,
      // Los DOS planos del tenant. `client` administra (plan `api`), `runtime` ejecuta
      // (plan `integration-flow`). Puede venir null.
      runtime: runtimeClient,
      policy: config.policy,
      profile: config.profile,
      label: config.label,
      // `oauth` puede faltar: un profile con solo el bloque `runtime` es config valida.
      // Hoy stdio.js corta antes de llegar aca, pero esta capa no debe asumirlo.
      identity: config.oauth?.clientid ?? null,
    };

    try {
      return await mod.handler(args ?? {}, ctx);
    } catch (err) {
      // Red de seguridad: las tools no deberian hacer throw nunca.
      log(`ERROR no capturado en ${name}:`, err?.stack ?? err);
      return {
        isError: true,
        content: [{ type: "text", text: `Error interno en ${name}: ${err?.message ?? err}` }],
      };
    }
  });

  return server;
}

export const toolNames = () => MODULES.map((m) => m.definition.name);
