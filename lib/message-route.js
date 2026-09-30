/**
 * Teacher consult — the panel's routes for consult bodies.
 *
 * ONE BODY AT A TIME, ON DEMAND
 * -----------------------------
 * The list the panel renders comes from `/teacher-consult/status`, which returns
 * audit rows: model, effort, latency, tokens, a bounded `reply_head`. Those rows
 * are small and bounded, which is what makes polling the status route cheap.
 *
 * Full bodies are the opposite: a single consult body can be tens of kilobytes,
 * and a history of them is megabytes. So bodies are NOT in the status payload and
 * are never bulk-loaded. The panel asks for exactly the one record the reader
 * selected, by id, and caches only what it has already shown.
 *
 * WHAT CANNOT BE REACHED FROM HERE
 * --------------------------------
 *   - An arbitrary path. The caller supplies a `consult_id`, never a filename.
 *     `MessageStore.pathFor` accepts only a UUID shape and then asserts the
 *     resolved parent is the store directory, so `../../` has nothing to attach
 *     to. A caller cannot name a file this store did not write.
 *   - A consult. Nothing on this path reserves a budget slot, spawns codex or
 *     calls Jev. Reading, refreshing and clearing are all free.
 *   - The audit log. Clearing bodies deletes files under the body directory only;
 *     `consults.jsonl`, the budget counters and the token totals are untouched.
 *
 * Same exposure rule as the status route: same-origin loopback only.
 */

import { sendJson, isTrustedRequest } from './status-route.js';

export const MESSAGE_PATH = '/teacher-consult/message';
export const CLEAR_PATH = '/teacher-consult/messages/clear';

/**
 * The header that turns a clear request into a deliberate one.
 *
 * The panel already asks the reader to confirm, so this is not the confirmation
 * step — it is what stops a request that was never meant to be a clear (a bare
 * `POST` from an address bar, a form, another script's retry) from being treated
 * as one. A destructive route should require the caller to say what it means.
 */
export const CLEAR_CONFIRM_HEADER = 'x-teacher-consult-confirm';
export const CLEAR_CONFIRM_VALUE = 'clear-messages';

/** Parse the request URL. The host is irrelevant; only the query is read. */
function requestUrl(req) {
  try {
    return new URL(req?.url ?? '/', 'http://127.0.0.1');
  } catch {
    return null;
  }
}

/**
 * Mount the body routes.
 *
 * @param {{register: Function}} webServer
 * @param {import('./messages.js').MessageStore} store
 * @returns {unknown[]} the registry disposers.
 */
export function installReadRoute(webServer, store) {
  return webServer.register({
    name: 'teacher-consult-message',
    kind: 'exact',
    path: MESSAGE_PATH,
    handler: async (req, res) => {
      if (req?.method !== undefined && req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: `method ${req.method} is not allowed; this route is read-only` });
        return;
      }
      if (!isTrustedRequest(req)) {
        sendJson(res, 403, { ok: false, error: 'request refused: same-origin loopback only' });
        return;
      }
      const url = requestUrl(req);
      const id = url === null ? null : url.searchParams.get('id');
      if (id === null || id.length === 0) {
        sendJson(res, 400, { ok: false, error: 'a consult id is required' });
        return;
      }
      let result;
      try {
        result = store.read(id);
      } catch (error) {
        sendJson(res, 409, { ok: false, error: String(error?.message ?? error) });
        return;
      }
      // `invalid consult id` and `not_found` are both 404: a caller that probes
      // ids learns only that the id is not readable, never why.
      if (!result.ok) {
        sendJson(res, 404, { ok: false, error: 'no stored body for this consult id' });
        return;
      }
      sendJson(res, 200, { ok: true, record: result.record });
    },
  });
}

export function installClearRoute(webServer, store) {
  return webServer.register({
    name: 'teacher-consult-messages-clear',
    kind: 'exact',
    path: CLEAR_PATH,
    handler: async (req, res) => {
      if (req?.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST is required to clear stored bodies' });
        return;
      }
      if (!isTrustedRequest(req)) {
        sendJson(res, 403, { ok: false, error: 'request refused: same-origin loopback only' });
        return;
      }
      if (req?.headers?.[CLEAR_CONFIRM_HEADER] !== CLEAR_CONFIRM_VALUE) {
        sendJson(res, 400, {
          ok: false,
          error: `refused: send header ${CLEAR_CONFIRM_HEADER}: ${CLEAR_CONFIRM_VALUE} to confirm`,
        });
        return;
      }
      let result;
      try {
        result = store.clear();
      } catch (error) {
        sendJson(res, 409, { ok: false, error: String(error?.message ?? error) });
        return;
      }
      // The audit log, the budget and the token totals are deliberately not part
      // of this response and not part of this operation.
      sendJson(res, result.ok ? 200 : 207, {
        ok: result.ok,
        removed: result.removed,
        failed: result.failed,
        errors: result.errors.slice(0, 10),
      });
    },
  });
}

/** Both routes, for callers that want to install them together. */
export function installMessageRoutes(webServer, store) {
  return [installReadRoute(webServer, store), installClearRoute(webServer, store)];
}
