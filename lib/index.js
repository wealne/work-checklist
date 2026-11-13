/**
 * work-checklist — host half.
 *
 * Runs a small reverse proxy on its own loopback port so the DingTalk AI Table
 * SPA can be embedded in the Harness UI as a same-origin-from-the-iframe's-view
 * document. Two upstreams are multiplexed:
 *
 *   /            -> https://alidocs.dingtalk.com
 *   /__login/... -> https://login.dingtalk.com
 *
 * Why a separate listener instead of a `ctx.webServer` prefix route: the SPA's
 * router reads `location.pathname` and redirects anything that is not a
 * document route back to `/i/desktop`. A mount prefix therefore cannot work.
 *
 * Authentication is handled entirely by the proxy: Set-Cookie responses are
 * captured into a server-side jar and replayed on every upstream request, so the
 * login QR code renders inside the embedded panel and the browser never needs
 * third-party cookies for alidocs.dingtalk.com.
 */
import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import z from '@deepseek-ai/schemastery';

const DOCS = 'https://alidocs.dingtalk.com';
const LOGIN = 'https://login.dingtalk.com';
const LOGIN_PREFIX = '/__login';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Hop-by-hop headers plus the ones we always overwrite ourselves. */
const DROP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'content-encoding', 'content-length', 'host', 'origin',
  'referer', 'cookie', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'accept-encoding',
]);

const stripManifest = new Set([
  'content-security-policy', 'content-security-policy-report-only',
  'x-frame-options', 'strict-transport-security',
]);

/**
 * Injected into the login document only. Its scripts build root-relative paths
 * such as `/oauth2/generate_qrcode` at runtime, which must stay under the login
 * mount or they would be attributed to the docs upstream.
 */
const LOGIN_PATCH = `<script>(function(){var L=${JSON.stringify(LOGIN_PREFIX)};var O=${JSON.stringify(LOGIN)};
function fix(u){
  if(typeof u!=="string")return u;
  if(u.indexOf(O)===0)return location.origin+L+u.slice(O.length);
  if(u.charAt(0)!=="/"||u.charAt(1)==="/")return u;
  if(u===L||u.indexOf(L+"/")===0)return u;
  return L+u;
}
var F=window.fetch;if(F)window.fetch=function(i,o){try{if(typeof i==="string")i=fix(i);else if(i&&i.url)i=new Request(fix(i.url),i);}catch(e){}return F.call(this,i,o);};
var X=window.XMLHttpRequest&&window.XMLHttpRequest.prototype.open;
if(X)window.XMLHttpRequest.prototype.open=function(m,u){try{arguments[1]=fix(u);}catch(e){}return X.apply(this,arguments);};
})();</script>`;

/**
 * Injected into the document shell only. The sheet's own left navigator opens
 * expanded on every load and does not remember the choice, so collapse it as
 * soon as the control exists.
 *
 * The viewer is hidden (zero width) until the host seat grows, so "narrow" is
 * not evidence of success — only a click is. Click once and stop: expanding it
 * by hand afterwards stays expanded for the rest of the session.
 */
const DOCS_PATCH = `<script>(function(){
  var tries = 0;
  var clicked = false;
  function step(){
    if (clicked) return true;
    var sides = document.querySelectorAll('#notable-sidebar');
    for (var i = 0; i < sides.length; i++) {
      var button = sides[i].querySelector('[data-role="Catalog_Expand"]');
      if (!button) continue;
      button.click();
      clicked = true;
      return true;
    }
    return false;
  }
  function tick(){
    if (step()) return;
    if (++tries > 600) return;
    setTimeout(tick, 100);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tick);
  else tick();
})();</script>`;

/** One `Set-Cookie` header, reduced to something this origin will accept. */
function parseSetCookie(raw) {
  const eq = raw.indexOf('=');
  if (eq < 0) return null;
  const name = raw.slice(0, eq).trim();
  const semi = raw.indexOf(';');
  const value = (semi < 0 ? raw.slice(eq + 1) : raw.slice(eq + 1, semi)).trim();
  if (!name) return null;
  return { name, value, header: `${name}=${value}; Path=/; SameSite=Lax` };
}

/** Owns the upstream cookie jar and its on-disk form. */
class CookieJar {
  constructor(file) {
    this.file = file;
    this.map = new Map();
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') this.map.set(k, v);
      }
    } catch {
      /* absent or unreadable: start empty and let the login flow fill it */
    }
  }

  /** @param {string[]} headers */
  absorb(headers) {
    const out = [];
    for (const raw of headers) {
      const parsed = parseSetCookie(raw);
      if (!parsed) continue;
      this.map.set(parsed.name, parsed.value);
      out.push(parsed.header);
    }
    if (out.length) void this.save();
    return out;
  }

  get(name) {
    return this.map.get(name);
  }

  header() {
    return [...this.map].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  names() {
    return [...this.map.keys()];
  }

  async save() {
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file, JSON.stringify(Object.fromEntries(this.map), null, 2), 'utf8');
    } catch {
      /* persistence is best-effort; the jar still works in memory */
    }
  }
}

/**
 * @param {{ port: number, docUrl: string, cookieFile: string }} options
 */
function createProxy({ port, docUrl, cookieFile }) {
  const jar = new CookieJar(cookieFile);
  let origin = '';
  let embedded = docUrl;
  const configuredUrl = docUrl;
  let upgrading = false;

  const enc = encodeURIComponent;

  /** `s` encoded `depth` times. */
  const encN = (s, depth) => {
    let out = s;
    for (let i = 0; i < depth; i += 1) out = enc(out);
    return out;
  };

  const docsBare = DOCS.slice('https:'.length); // //alidocs.dingtalk.com
  const loginBare = LOGIN.slice('https:'.length); // //login.dingtalk.com
  const originBare = () => origin.slice('http:'.length); // //127.0.0.1:PORT

  /**
   * Rewrite every spelling of an upstream origin to the loopback one: absolute,
   * protocol-relative, and percent-encoded at any nesting depth. Depth matters
   * because OAuth echoes the document URL inside `redirect_uri`, which is itself
   * escaped, and again inside that parameter's `continue` value.
   */
  const toLocal = (text) => {
    let out = text;
    for (let depth = 0; depth <= 3; depth += 1) {
      out = out
        .replaceAll(encN(DOCS, depth), encN(origin, depth))
        .replaceAll(encN(docsBare, depth), encN(originBare(), depth))
        .replaceAll(encN(LOGIN, depth), encN(origin + LOGIN_PREFIX, depth))
        .replaceAll(encN(loginBare, depth), encN(originBare() + LOGIN_PREFIX, depth));
    }
    return out;
  };

  /**
   * Attribute an inbound path to an upstream.
   *
   * Only login's own route space is redirected to login.dingtalk.com. A Referer
   * heuristic must not be used here: the OAuth callback lands on
   * `/dingtalk_sso_call_back`, which is an alidocs endpoint that happens to be
   * reached from the login page.
   */
  const route = (pathname) => {
    if (pathname === LOGIN_PREFIX || pathname.startsWith(`${LOGIN_PREFIX}/`)) {
      return { upstream: LOGIN, path: pathname.slice(LOGIN_PREFIX.length) || '/', login: true };
    }
    // Login scripts occasionally build root-relative paths at runtime; those all
    // live under /oauth2/.
    if (pathname === '/oauth2' || pathname.startsWith('/oauth2/')) {
      return { upstream: LOGIN, path: pathname, login: true };
    }
    return { upstream: DOCS, path: pathname, login: false };
  };

  /**
   * The document *shell* (`/i/nodes/<uuid>`) starts its login with
   * `response_type=none`, which looks like a plain "just establish a session"
   * request. The login page rejects it outright — it renders a red toast
   * saying `Authorization Code Flow Only! responseType must be code` and the
   * scan then has nowhere to return to. The inner editor URL
   * (`/iframe/notable?...`) uses the working shape instead:
   *
   *   response_type=code
   *   redirect_uri=<docs>/dingtalk_sso_call_back?continue=<the page to land on>
   *
   * so promote the shell's request to exactly that shape. Login is then a
   * normal authorization-code round trip and the SSO callback drops the user
   * back on the document.
   */
  const promoteLogin = (loc) => {
    let u;
    try {
      u = new URL(loc);
    } catch {
      return loc;
    }
    if (u.origin !== LOGIN || u.pathname !== '/oauth2/auth') return loc;
    if (u.searchParams.get('response_type') !== 'none') return loc;
    const target = u.searchParams.get('redirect_uri');
    if (!target) return loc;
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('redirect_uri', `${DOCS}/dingtalk_sso_call_back?continue=${enc(target)}`);
    return u.toString();
  };

  /**
   * Redirects need the same treatment as bodies: the OAuth round trip carries
   * both upstream origins, nested several encodings deep.
   */
  const rewriteLocation = (loc) => (loc ? toLocal(promoteLogin(loc)) : loc);

  const server = http.createServer(async (req, res) => {
    const url = req.url || '/';
    const q = url.indexOf('?');
    const pathname = q < 0 ? url : url.slice(0, q);
    const search = q < 0 ? '' : url.slice(q);

    if (pathname === '/__health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, cookies: jar.names() }));
      return;
    }

    const { upstream, path, login } = route(pathname);
    const target = upstream + path + search;

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!DROP.has(k.toLowerCase())) headers[k] = v;
    }
    const cookie = jar.header();
    if (cookie) headers.cookie = cookie;
    headers['user-agent'] = USER_AGENT;
    headers.referer = (login ? LOGIN : DOCS) + '/';
    headers.origin = login ? LOGIN : DOCS;
    headers['accept-encoding'] = 'identity';
    const xsrf = jar.get('XSRF-TOKEN');
    if (xsrf) headers['x-xsrf-token'] = xsrf;

    try {
      const upstreamResponse = await fetch(target, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : req,
        redirect: 'manual',
        duplex: 'half',
      });

      const contentType = upstreamResponse.headers.get('content-type') || '';
      const isHtml = /text\/html/i.test(contentType);
      let body = Buffer.from(await upstreamResponse.arrayBuffer());

      if (isHtml) {
        let text = toLocal(body.toString('utf8'));
        if (login && text.includes('<head>')) text = text.replace('<head>', `<head>${LOGIN_PATCH}`);
        else if (login) text = LOGIN_PATCH + text;
        else if (text.includes('<head>')) text = text.replace('<head>', `<head>${DOCS_PATCH}`);
        else text = DOCS_PATCH + text;
        body = Buffer.from(text, 'utf8');
      }

      const out = {};
      for (const [k, v] of upstreamResponse.headers) {
        const lower = k.toLowerCase();
        if (DROP.has(lower) || lower === 'set-cookie') continue;
        out[k] = v;
      }
      const setCookies = jar.absorb(upstreamResponse.headers.getSetCookie?.() ?? []);
      if (setCookies.length) out['set-cookie'] = setCookies;
      if (isHtml && xsrf) {
        out['set-cookie'] = [...(out['set-cookie'] ?? []), `XSRF-TOKEN=${xsrf}; Path=/; SameSite=Lax`];
      }
      // Login just landed: the jar can now read the shell, so fetch the editor
      // URL in the background. The panel picks it up on its next config read.
      if (pathname.startsWith('/dingtalk_sso_call_back')) {
        void self.upgrade().catch(() => {});
      }
      const location = upstreamResponse.headers.get('location');
      if (location) out.location = rewriteLocation(location);
      for (const name of stripManifest) delete out[name];
      if (isHtml) out['content-type'] = 'text/html; charset=utf-8';

      res.writeHead(upstreamResponse.status, out);
      res.end(body);
    } catch (error) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`work-checklist proxy error: ${String(error)}`);
    }
  });

  const self = {
    jar,
    async start(requested) {
      await jar.load();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(requested, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      const address = server.address();
      const bound = typeof address === 'object' && address ? address.port : requested;
      origin = `http://127.0.0.1:${bound}`;
      return bound;
    },
    stop() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
    get origin() {
      return origin;
    },
    get docUrl() {
      return embedded;
    },
    /** The URL the user configured, before any shell->editor resolution. */
    get configuredUrl() {
      return configuredUrl;
    },
    /** Replace the embedded document once the shell URL has been resolved. */
    setDocUrl(next) {
      if (typeof next === 'string' && next) embedded = next;
    },
    /**
     * Re-run shell->editor resolution now that a session exists.
     *
     * On a fresh install the jar is empty when the proxy starts, so the shell
     * fetch redirects to login and no editor URL can be harvested; the panel
     * then loads the shell URL itself. That works, but the shell is a wrapper
     * that re-embeds the editor and is slower to settle. Once login has landed
     * — an SSO callback reached us with `dingtalk_sso_call_back` — retry the
     * harvest so the next panel load points straight at the editor.
     *
     * Returns true when the embedded URL changed.
     */
    async upgrade() {
      if (upgrading) return false;
      if (!configuredUrl.includes(SHELL_NODE)) return false;
      if (embedded.includes(INNER_EDITOR)) return false;
      if (!jar.names().length) return false;
      upgrading = true;
      try {
        const next = await resolveDocUrl(configuredUrl, jar);
        if (!next.includes(INNER_EDITOR) || next === embedded) return false;
        embedded = next;
        return true;
      } catch {
        return false;
      } finally {
        upgrading = false;
      }
    },
  };

  return self;
}

export const name = 'work-checklist';

export const inject = ['webServer'];

/** Thrown when the panel is opened before a document address is configured. */
const NO_URL = 'work-checklist: no document address configured';

/**
 * Loader-row schema, rendered by the plugin manager's config form.
 *
 * `url` accepts whatever the user has in their address bar. The `i/nodes/<id>`
 * form is the document shell; its HTML carries the editor URL the panel should
 * actually embed, so it is resolved on first use (see `resolveDocUrl`). The
 * `iframe/notable` form is already the editor and is used verbatim.
 *
 * It deliberately ships empty: every table is private to its workspace, so a
 * hardcoded default would only ever point at someone else's document.
 */
const Config = z.object({
  url: z
    .string()
    .default('')
    .description('钉钉文档链接，浏览器地址栏里的 /i/nodes/... 或 /iframe/notable?... 都可以。')
    .volatile(),
  port: z
    .natural()
    .default(0)
    .description('本地代理端口。0 表示每次启动自动分配一个空闲端口。')
    .volatile(),
});

export { Config };

const INNER_EDITOR = '/iframe/notable';
const SHELL_NODE = '/i/nodes/';

/**
 * The document shell HTML embeds the editor URL that the panel must load. Pull
 * it out with a narrow regex rather than parsing 48 KB of JSON: the page is
 * server-rendered and the field is a plain escaped string.
 */
function extractEditorUrl(html) {
  const match = /"pcChildAppUrl"\s*:\s*"([^"]+)"/.exec(html);
  if (!match) return '';
  // The value is JSON-escaped inside the HTML, so `\/` shows up as `/` later.
  return match[1].replace(/\\\//g, '/').replace(/\\u002F/gi, '/');
}

/**
 * Turn the configured URL into the URL the iframe should load.
 *
 * Editor URLs pass straight through. Shell URLs need one authenticated fetch to
 * harvest the editor URL; when that fails (logged out, network) the shell URL is
 * returned unchanged, because the shell renders its own login page and is still
 * a usable thing to show.
 *
 * The harvested editor URL names the document but not the sheet or view — those
 * only ride along in the shell URL's `iframeQuery` parameter — so they are
 * carried across explicitly. Without that the panel would open on whichever
 * sheet happens to be first.
 */
async function resolveDocUrl(docUrl, jar) {
  if (docUrl.includes(INNER_EDITOR) || !docUrl.includes(SHELL_NODE)) return docUrl;
  try {
    const response = await fetch(docUrl, {
      redirect: 'manual',
      headers: { cookie: jar.header(), 'user-agent': USER_AGENT },
    });
    if (!response.ok) return docUrl;
    const html = await response.text();
    const editorUrl = extractEditorUrl(html);
    if (!editorUrl.startsWith('http')) return docUrl;
    return carrySheetParams(docUrl, editorUrl);
  } catch {
    return docUrl;
  }
}

/**
 * Copy `sheetId` / `viewId` from the shell URL's `iframeQuery` onto the editor
 * URL, leaving anything the editor URL already specifies intact.
 */
function carrySheetParams(shellUrl, editorUrl) {
  let query = '';
  try {
    query = new URL(shellUrl).searchParams.get('iframeQuery') ?? '';
  } catch {
    return editorUrl;
  }
  if (!query) return editorUrl;
  const wanted = new URLSearchParams(query);
  let target;
  try {
    target = new URL(editorUrl);
  } catch {
    return editorUrl;
  }
  for (const key of ['sheetId', 'viewId']) {
    const value = wanted.get(key);
    if (value && !target.searchParams.has(key)) target.searchParams.set(key, value);
  }
  return target.toString();
}

/**
 * A `.volatile()` field arrives as a cosmokit `Volatile` reference: a frozen
 * plain object exposing `get()` plus a `Symbol(cosmokit.volatile.write)` slot.
 * `typeof`/`JSON.stringify` see an opaque `{}`, so reading `config.url` directly
 * would silently fall back to the default instead of the value the user saved.
 * Reading through `get()` also tracks later live commits, because the reference
 * stays put and only its value moves.
 */
function unwrapVolatile(value) {
  if (value === null || typeof value !== 'object') return value;
  if (typeof value.get !== 'function') return value;
  if (!Object.getOwnPropertySymbols(value).some((symbol) => String(symbol).includes('cosmokit.volatile'))) {
    return value;
  }
  try {
    return value.get();
  } catch {
    return value;
  }
}

/** Unwrap every volatile reference so the plain config can be read normally. */
function plainConfig(config) {
  if (config === null || typeof config !== 'object') return {};
  const plain = {};
  for (const key of Object.keys(config)) plain[key] = unwrapVolatile(config[key]);
  return plain;
}

export function apply(ctx, config) {
  const webServer = ctx.get('webServer');
  const cookieFile = join(homedir(), '.dsh', 'work-checklist', 'cookies.json');

  let proxy = null;
  let boundPort = 0;
  let ready = null;
  let signature = '';

  /**
   * The config arrives once, but its `volatile` fields stay live: the reference
   * is fixed and only the value behind `get()` moves. So the effective settings
   * must be re-read per request instead of being captured here, otherwise a
   * saved edit would only take effect after a plugin reload.
   */
  const currentSignature = () => {
    const plain = plainConfig(config);
    return `${plain.url || ''}\u0000${plain.port ?? 0}`;
  };

  const startWith = async (plain) => {
    const docUrl = plain.url || '';
    if (!docUrl) throw new Error(NO_URL);
    if (proxy) {
      const previous = proxy;
      proxy = null;
      await previous.stop().catch(() => {});
    }
    boundPort = 0;
    proxy = createProxy({
      port: plain.port ?? 0,
      docUrl,
      cookieFile,
    });
    boundPort = await proxy.start(plain.port ?? 0);
    // Shell URLs carry the editor URL in their HTML; pull it out once per start.
    proxy.setDocUrl(await resolveDocUrl(proxy.docUrl, proxy.jar));
    // The configured document origin is rewritten to the live loopback origin.
    return proxy.docUrl.replace(DOCS, proxy.origin);
  };

  /** Resolve the local embed URL, (re)starting the proxy when settings changed. */
  const ensure = () => {
    const wanted = currentSignature();
    if (!ready || wanted !== signature) {
      signature = wanted;
      const plain = plainConfig(config);
      ready = startWith(plain).catch((cause) => {
        ready = null;
        signature = '';
        throw cause;
      });
    }
    return ready;
  };

  ctx.effect(() => {
    const dispose = webServer.register({
      kind: 'exact',
      path: '/work-checklist/config',
      async handler(req, res) {
        let url = '';
        let error = '';
        // "Not configured" is a normal first-run state, not a failure: report it
        // separately so the panel can point at the settings form instead of
        // showing an error string.
        const configured = !!(plainConfig(config).url || '');
        if (configured) {
          try {
            url = await ensure();
          } catch (cause) {
            error = String(cause);
          }
          // A fresh install embeds the shell URL because there was no session to
          // read the editor URL with. Once the jar has one, upgrade it here so a
          // plain panel reload lands straight on the editor.
          if (!error && proxy) {
            const upgraded = await proxy.upgrade().catch(() => false);
            if (upgraded) url = proxy.docUrl.replace(DOCS, proxy.origin);
          }
        }
        res.writeHead(error ? 500 : 200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(
          JSON.stringify({
            url,
            port: boundPort,
            cookies: proxy ? proxy.jar.names() : [],
            configured,
            error,
          }),
        );
      },
    });
    return () => {
      dispose();
    };
  }, 'work-checklist: config route');

  ctx.effect(
    () => () => {
      const running = proxy;
      proxy = null;
      if (running) void running.stop().catch(() => {});
    },
    'work-checklist: proxy listener',
  );

  // Start eagerly so the first panel open is instant; failure is surfaced later
  // by the config route rather than thrown during activation. Nothing is started
  // before an address is configured — see the NO_URL guard in `startWith`.
  if (plainConfig(config).url) void ensure().catch(() => {});
}
