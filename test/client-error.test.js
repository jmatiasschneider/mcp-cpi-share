/**
 * Unitarios del renderizado de errores del CpiClient cuando el cuerpo viene en XML.
 *
 * Con `Accept: application/octet-stream` (las descargas raw de /$value) la API devuelve el
 * error OData en XML, no en JSON (verificado el 2026-08-26). Sin el fallback, el mensaje que
 * ve el modelo era el volcado del XML entero en vez de la frase util.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CpiClient } from "../src/core/client.js";

const XML_404 =
  "<?xml version='1.0' encoding='UTF-8'?>" +
  '<error xmlns="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">' +
  "<code>Not Found</code>" +
  '<message xml:lang="en">Integration package {ZZNOEXISTE} does not exist.</message></error>';

/** fetch falso: responde el token y despues el error que se le indique. */
function fetchFalso({ status, body }) {
  return async (url) => {
    if (String(url).includes("/oauth/token")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: "tok", expires_in: 3600 }),
        text: async () => "",
      };
    }
    return {
      ok: false,
      status,
      headers: { get: () => null },
      text: async () => body,
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
}

function cliente(respuesta) {
  return new CpiClient({
    oauth: {
      clientid: "id",
      clientsecret: "secreto",
      tokenurl: "https://auth.example/oauth/token",
      url: "https://api.example",
    },
    fetchImpl: fetchFalso(respuesta),
  });
}

test("un error con cuerpo XML llega como la frase del <message>, no como el volcado", async () => {
  await assert.rejects(
    () => cliente({ status: 404, body: XML_404 }).get("IntegrationPackages('ZZNOEXISTE')/$value", { raw: true }),
    (err) => {
      assert.equal(err.status, 404);
      assert.match(err.message, /Integration package \{ZZNOEXISTE\} does not exist\./);
      assert.ok(!err.message.includes("<message"), `el XML no deberia aparecer: ${err.message}`);
      return true;
    }
  );
});

test("un error con cuerpo JSON sigue extrayendo error.message.value", async () => {
  const body = JSON.stringify({ error: { message: { value: "Id duplicado." } } });
  await assert.rejects(
    () => cliente({ status: 500, body }).get("IntegrationPackages", {}),
    (err) => {
      assert.match(err.message, /HTTP 500 — Id duplicado\./);
      return true;
    }
  );
});
