/**
 * Teacher consult — the read-only status route behind the 协作中心 panel.
 *
 * WHY A ROUTE AND NOT A TOOL
 * --------------------------
 * The teacher roster, the current task's remaining budget and the consult history
 * are already answerable by the `teacher_status` TOOL, but a tool result only
 * exists inside a model turn: the GUI cannot ask for one without making the model
 * ask. The 协作中心 panel is a browser widget, so it needs the same snapshot over
 * HTTP.
 *
 * A VIEW, NOT A FOURTH CONSULT ENTRY
 * ----------------------------------
 * This route is a pure read. It touches no codex process, spends no consult slot,
 * and never calls Jev — the advisory budget is bounded per task and a dashboard
 * that could silently consume it would be spending the user's money for a repaint.
 * The single side effect it can have is the same one `teacher_status` already has:
 * `budget.describe()` materializes an empty per-session state entry for the
 * session it is asked about. It cannot increment a counter.
 *
 * It also deliberately exposes NO way to start a consult. A manual consult from
 * the panel would have to bypass the budget ledger or re-implement it, and the
 * budget is the load-bearing part of the teacher design. The panel shows; the
 * model asks.
 *
 * EXPOSURE
 * --------
 * Same rule as the mailbox route and hindsight-ui-button: same-origin loopback
 * only. The host already requires a token to reach the app at all, but a panel
 * reachable from a LAN address would publish the roster, the consult history and
 * the token/latency of every past consult to the whole network. What is returned
 * is a bounded summary — no API key, no environment, no full replies (the log's
 * own `reply_head` cap is already applied at write time and is not widened here).
 */

/** Loopback hostnames, including the `*.localhost` family browsers resolve locally. */
export function isLoopbackHost(hostname) {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1' ||
    hostname.endsWith('.localhost')
  );
}

/**
 * Whether a request came from the app's own page on the loopback interface.
 *
 * @param {{headers?: Record<string, string|undefined>}} req
 * @returns {boolean}
 */
export function isTrustedRequest(req) {
  const host = req?.headers?.host;
  if (typeof host !== 'string' || host === '') return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (!isLoopbackHost(hostUrl.hostname)) return false;
  if (req?.headers?.['sec-fetch-site'] === 'cross-site') return false;
  const origin = req?.headers?.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

/**
 * @param {{writeHead: Function, end: Function}} res
 * @param {number} status
 * @param {unknown} body
 */
export function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export const STATUS_PATH = '/teacher-consult/status';

/**
 * Mount the read-only teacher status route.
 *
 * @param {{register: Function}} webServer
 * @param {() => object} snapshot - builds the payload; must be a pure read.
 * @returns {unknown} the registry disposer.
 */
export function installStatusRoute(webServer, snapshot) {
  return webServer.register({
    name: 'teacher-consult-status',
    kind: 'exact',
    path: STATUS_PATH,
    handler: async (req, res) => {
      // A status read is a GET; anything else is refused rather than silently
      // treated as one, so a future write route cannot be reached by accident.
      if (req?.method !== undefined && req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: `method ${req.method} is not allowed; this route is read-only` });
        return;
      }
      if (!isTrustedRequest(req)) {
        sendJson(res, 403, { error: 'request refused: same-origin loopback only' });
        return;
      }
      try {
        sendJson(res, 200, snapshot());
      } catch (error) {
        sendJson(res, 409, { error: String(error?.message ?? error) });
      }
    },
  });
}
