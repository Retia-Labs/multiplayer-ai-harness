// What counts as a link to related work, and what a link is allowed to be.
//
// This is shared because it has to be agreed in two places that do not trust each other: a
// client checks before offering to store one, and the host checks before writing it into a
// log everybody else will render. Only the host's answer decides anything - a client that
// skipped the check would still be refused - but a client that could not check would have to
// send a URL just to find out it was never going to be accepted.
//
// The rule is narrow on purpose. A tracker link is an ordinary web address, and everything
// else that can appear in an href is a way of running something in a reader's browser or
// smuggling content past a boundary: javascript:, data:, blob:, file:, vbscript:. There is no
// allowlist of hosts, because which tracker a team uses is their business.

export const LINK_SCHEMES = ['https:', 'http:'];
export const MAX_LINK_URL = 2048;
export const MAX_LINK_TITLE = 200;

export class LinkError extends Error { constructor(code) { super(code); this.code = code; } }

/**
 * Normalise a related-work URL, or say why it is not one.
 *
 * Returns the parsed href rather than the caller's string, so what gets stored is what a
 * browser would actually resolve - not a string that reads like one address and navigates to
 * another.
 */
export function normalizeLink(raw) {
  if (typeof raw !== 'string') throw new LinkError('invalid_link_url');
  const value = raw.trim();
  if (!value || value.length > MAX_LINK_URL) throw new LinkError('invalid_link_url');
  let url;
  try { url = new URL(value); } catch { throw new LinkError('invalid_link_url'); }
  if (!LINK_SCHEMES.includes(url.protocol)) throw new LinkError('unsupported_link_scheme');
  // Credentials in a URL are a phishing shape - https://github.com@evil.example reads as
  // GitHub and goes somewhere else - and no tracker needs them.
  if (url.username || url.password) throw new LinkError('credentials_in_link');
  if (!url.hostname) throw new LinkError('invalid_link_url');
  const href = url.toString();
  if (href.length > MAX_LINK_URL) throw new LinkError('invalid_link_url');
  return href;
}

export function normalizeLinkTitle(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw new LinkError('invalid_link_title');
  // Control characters would let a title fake a second line, or a different label.
  const value = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!value) return null;
  if (value.length > MAX_LINK_TITLE) throw new LinkError('invalid_link_title');
  return value;
}

// What a reader should see for a link, without ever being asked to read a full URL to work
// out where it goes. The host is what matters for that judgement, so it leads.
export function describeLink(href) {
  try {
    const url = new URL(href);
    return { host: url.hostname, path: url.pathname + url.search, insecure: url.protocol === 'http:' };
  } catch {
    return { host: null, path: null, insecure: false };
  }
}
