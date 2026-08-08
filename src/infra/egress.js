// infra/egress.js — route OUTBOUND upstream fetches through an HTTP proxy when
// the standard proxy env vars are set. D1DX patch (DL-4333).
//   • installEnvProxyDispatcher() — install undici's EnvHttpProxyAgent as the
//     global dispatcher, so EVERY global fetch() in the process (provider
//     forward, SSE relay, OAuth token + profile, the warmer/prober) inherits it.
//     No per-call-site wiring, nothing to keep in sync.
//
// Why this exists: the container sets HTTP_PROXY/HTTPS_PROXY/NO_PROXY plus
// NODE_USE_ENV_PROXY=1, but NODE_USE_ENV_PROXY is a Node 24 feature and the
// image runs Node 20 — so the setting is inert there and undici opened DIRECT
// sockets to api.anthropic.com, silently bypassing the egress-chooser sidecar.
// This installs the same dispatcher Node 24 would install, explicitly.
//
// Fail-open by construction, in both directions:
//   • No proxy env  → returns immediately, global dispatcher untouched, zero
//     behaviour change (the Mac local-mode path and every plain CLI run).
//   • undici absent → warn on stderr and continue DIRECT. undici is a declared
//     dependency, but the "mirror src/ into the global install" deploy path
//     (see apps/teamclaude/CLAUDE.md → "D1DX fork patches") copies no
//     node_modules, so the import is dynamic and guarded rather than static —
//     a missing module must never stop the proxy from starting.
// The proxy itself failing open is the sidecar's job, not ours: egress-chooser
// tries the residential proxy and falls back to direct egress per request.

// Standard precedence: lowercase before uppercase, https before http — the same
// order undici's EnvHttpProxyAgent itself reads them in.
function proxyEnvUrl() {
  return process.env.https_proxy || process.env.HTTPS_PROXY ||
         process.env.http_proxy || process.env.HTTP_PROXY || null;
}

// A proxy URL may carry credentials (http://user:pass@host). Never log them.
function redactProxyUrl(url) {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '';
    }
    return u.toString();
  } catch {
    return '<unparseable proxy url>';
  }
}

// Install the env-driven proxy dispatcher. Returns true when installed.
// Notices go to STDERR — `teamclaude env` prints shell `export` lines on stdout
// and is meant to be eval'd; stdout must stay clean.
export async function installEnvProxyDispatcher() {
  const proxyUrl = proxyEnvUrl();
  if (!proxyUrl) return false;

  try {
    const { setGlobalDispatcher, EnvHttpProxyAgent } = await import('undici');
    // EnvHttpProxyAgent (not a bare ProxyAgent) because it reads HTTP_PROXY /
    // HTTPS_PROXY / NO_PROXY itself and applies NO_PROXY per destination — so
    // loopback self-calls (the CLI's http://localhost:<port>/teamclaude/*) and
    // tailnet names stay DIRECT while upstream goes through the proxy. A bare
    // ProxyAgent has no NO_PROXY notion and would tunnel those too.
    setGlobalDispatcher(new EnvHttpProxyAgent());
    console.error(`Egress: upstream fetches via ${redactProxyUrl(proxyUrl)} (NO_PROXY="${process.env.NO_PROXY || process.env.no_proxy || ''}")`);
    return true;
  } catch (err) {
    console.error(`Warning: proxy env is set but undici is unavailable — upstream fetches stay DIRECT (${err.code || err.message})`);
    return false;
  }
}
