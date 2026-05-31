'use strict';

// ---------------------------------------------------------------------------
// Lightweight ad / tracker blocker built on session.webRequest.
// Matches request hostnames against a built-in blocklist of known ad &
// analytics domains (suffix match, so sub.doubleclick.net is covered too).
// Counts blocks per session so the UI can show a shield badge.
// ---------------------------------------------------------------------------

// A compact, hand-picked blocklist of common ad/tracker/analytics endpoints.
// (Real adblockers ship 100k+ rules; this covers the heavy hitters and is
//  trivial to extend.)
const BLOCKED_DOMAINS = [
  // Google ads / analytics
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
  'google-analytics.com', 'googletagmanager.com', 'googletagservices.com',
  'adservice.google.com', 'pagead2.googlesyndication.com', 'analytics.google.com',
  // Facebook / Meta
  'connect.facebook.net', 'an.facebook.com',
  // Amazon ads
  'amazon-adsystem.com', 'adsystem.amazon.com',
  // Major ad networks / exchanges
  'adnxs.com', 'rubiconproject.com', 'pubmatic.com', 'criteo.com', 'criteo.net',
  'casalemedia.com', 'openx.net', 'taboola.com', 'outbrain.com', 'mgid.com',
  'media.net', 'smartadserver.com', 'adform.net', 'sharethrough.com',
  'bidswitch.net', 'contextweb.com', 'gumgum.com', 'teads.tv', 'spotxchange.com',
  // Analytics / tracking
  'scorecardresearch.com', 'quantserve.com', 'quantcount.com', 'hotjar.com',
  'mixpanel.com', 'segment.com', 'segment.io', 'amplitude.com', 'fullstory.com',
  'mouseflow.com', 'crazyegg.com', 'newrelic.com', 'nr-data.net',
  'bugsnag.com', 'branch.io', 'adjust.com', 'appsflyer.com', 'kochava.com',
  'chartbeat.com', 'parsely.com', 'optimizely.com', 'yandex.ru/metrika',
  'mc.yandex.ru', 'matomo.cloud', 'clarity.ms', 'bat.bing.com',
];

// Split the list once at load: plain host suffixes vs. entries with a path
// (e.g. 'yandex.ru/metrika'), which need a full-URL substring match. This keeps
// the per-request hot loop from re-checking `d.includes('/')` on every entry.
const HOST_RULES = BLOCKED_DOMAINS.filter((d) => !d.includes('/'));
const PATH_RULES = BLOCKED_DOMAINS.filter((d) => d.includes('/'));

function hostnameOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

function isBlocked(url) {
  const host = hostnameOf(url);
  if (!host) return false;
  if (HOST_RULES.some((d) => host === d || host.endsWith('.' + d))) return true;
  return PATH_RULES.some((d) => url.includes(d));
}

/**
 * Install the blocker on a session.
 * @param {Electron.Session} sess
 * @param {() => boolean} enabled  live read of the "blockAds" setting
 * @param {(delta:number) => void} onBlock  called when a request is blocked
 */
function attach(sess, enabled, onBlock) {
  sess.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    if (enabled() && details.resourceType !== 'mainFrame' && isBlocked(details.url)) {
      onBlock(1);
      return callback({ cancel: true });
    }
    callback({ cancel: false });
  });
}

module.exports = { attach, isBlocked, BLOCKED_DOMAINS };
