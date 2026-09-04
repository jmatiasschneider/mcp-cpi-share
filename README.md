# mcp-cpi

MCP server para operar un tenant de **SAP Integration Suite — Cloud Integration** desde Claude Code.
21 tools: leer packages, iFlows y logs; crear, clonar, configurar, validar y deployar artefactos;
invocar un iFlow y leer los payloads de cada paso. Todas verificadas contra un tenant real.

Este README es para **usarlo desde otro repo**. Para trabajar sobre el server, ver [CLAUDE.md](CLAUDE.md).

## Requisitos

- Node.js 18.15 o superior (`node --version`).
- Acceso de lectura a este repo por git (SSH o `gh auth login`): es privado.
- Una **service key** del tenant, plan `api` (ver *Credenciales*).

## 1. Instalarlo en tu repo

Desde la raíz del repo donde vas a trabajar:

```bash
npm install github:jmatiasschneider/mcp-cpi-share#v0.1.0
```

El `#v0.1.0` fija la versión: todos instalan el mismo commit, y el `package-lock.json` de este
repo fija a su vez cada dependencia del server. Para actualizar, cambiar el tag.

Si tu repo no tiene `package.json`, antes:

```bash
npm init -y
```

## 2. Credenciales

En el BTP Cockpit, en la subaccount del tenant: **Instances and Subscriptions → Process
Integration Runtime**, instancia con plan **`api`** → *Service Keys* → crear una. El JSON que
baja trae `clientid`, `clientsecret`, `tokenurl` y `url`: se pegan tal cual.

```bash
cp node_modules/mcp-cpi/systems.example.json systems.json
```

Completar el bloque `oauth` del profile `dev`. El bloque `runtime` (plan `integration-flow`)
es opcional: solo hace falta para `cpi_invoke`; si no lo tenés, borralo del profile.

⚠️ **`systems.json` va al `.gitignore` de tu repo.** Y el secreto nunca se pega en el chat con
Claude: se escribe directo en el archivo.

`policy` arranca en `readonly`: las tools que escriben o ejecutan quedan bloqueadas. Subirla a
`readwrite` solo en el profile del tenant donde se desarrolla.

## 3. Registrarlo en Claude Code

Crear `.mcp.json` en la raíz de tu repo:

```json
{
  "mcpServers": {
    "mcp-cpi": {
      "command": "node",
      "args": ["node_modules/mcp-cpi/bin/stdio.js"],
      "env": {
        "CPI_PROFILE": "dev",
        "CPI_SYSTEMS": "systems.json"
      }
    }
  }
}
```

`CPI_SYSTEMS` es la ruta de tus credenciales, relativa a la raíz del repo. `CPI_PROFILE` elige
el profile dentro del archivo: con dos tenants (`dev`, `qas`) se declaran dos entradas, una por
profile, con nombres `mcp-cpi-dev` y `mcp-cpi-qas`.

Reabrir el repo en Claude Code y pedirle `cpi_ping`: si contesta con el tenant y los scopes del
token, está andando.

## 4. La skill (opcional, recomendada)

El procedimiento para crear un iFlow y migrar una interfaz desde PI/PO vive en una skill. Se copia
al repo, no se instala global:

```bash
cp -r node_modules/mcp-cpi/.claude/skills/mcp-cpi-iflows .claude/skills/
```

Claude la toma al reabrir el workspace. Al actualizar el server, volver a copiarla.

## Actualizar

```bash
npm install github:jmatiasschneider/mcp-cpi-share#v0.2.0
```

y volver a copiar la skill.

## Para desarrollar el server

```bash
git clone git@github.com:jmatiasschneider/mcp-cpi-share.git && cd mcp-cpi-share
npm ci                                  # instala exactamente lo que dice package-lock.json
cp systems.example.json systems.json    # acá sí va en la raíz; está gitignoreado
git config core.hooksPath .githooks     # hook de pre-commit, una vez por clone
npm test                                # unitarios + boot; no toca el tenant
```

`npm ci` y no `npm install`: el primero instala el lock tal cual y falla si no coincide con
`package.json`; el segundo puede reescribirlo.

Los smoke tests (`npm run smoke`, `smoke:write`, `smoke:deploy`) van contra el tenant real y dan
por existente un package `DEVtest` con un iFlow `test` adentro. Lo que crean lleva prefijo `zz_`
y se borra al terminar. Detalle en [CLAUDE.md](CLAUDE.md); lo verificado contra el API, en
[DISCOVERY.md](DISCOVERY.md).

## Seguridad

- Nunca se loggea ni se devuelve un `clientsecret` o un token. De las credenciales del tenant
  solo salen **nombres**.
- `cpi_invoke` ejecuta un iFlow, y ese iFlow puede pegarle a un backend real. Por eso está
  bloqueada en `readonly` aunque no escriba en Cloud Integration.
- No hay tool para borrar un package: se lleva puesto todo lo que tiene adentro.
