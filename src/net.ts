// Proxy support for Node's global fetch.
//
// Node's fetch (undici) does NOT honor http_proxy/https_proxy/all_proxy/
// no_proxy environment variables the way curl, git, or python-requests do.
// Without an explicit dispatcher every fetch goes direct — which fails behind
// a corporate/GFW proxy (UND_ERR_CONNECT_TIMEOUT). EnvHttpProxyAgent reads
// the standard proxy env vars and routes accordingly, so the proxy the user
// already configured "just works" for both web_search and the API client.
//
// Installed once at process startup (see cli.tsx) before any fetch runs.

import { setGlobalDispatcher, EnvHttpProxyAgent } from "undici";

/**
 * Route global fetch through the proxy named by http_proxy / https_proxy /
 * all_proxy (respecting no_proxy). No-op when none are set, so direct-connect
 * environments are unaffected.
 */
export function installProxyFromEnv(): void {
  const proxy =
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.HTTP_PROXY ||
    process.env.all_proxy ||
    process.env.ALL_PROXY;
  if (!proxy) return;
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

// Self-install on import. cli.tsx imports this module first, and ESM evaluates
// imports in order, so this runs before any other module body (and thus before
// any fetch). Idempotent and a no-op without a proxy env var.
installProxyFromEnv();
