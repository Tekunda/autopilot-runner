// Fetches, verifies, and loads the PRIVATE pack-gate bundle -- the deterministic pack gates
// the runner used to bundle statically.
//
// THE EXPOSURE THIS EXISTS TO CLOSE. runner-dist/ is mirrored verbatim into the PUBLIC repo
// Tekunda/autopilot-runner on every release. Because src/runner/gate-registry.ts imported the
// pack gates statically, src/packaging/build-runner-dist.ts had to copy 18 licensed pack files
// into that public tree -- 4,527 lines of paid gate logic, readable by anyone. Nothing
// from src/packs/ ships there any more. Instead the pack gates are published as a PRIVATE
// release asset and pulled in here, per gate stage.
//
// THE TRUST BOUNDARY. This runs inside the customer's CI job, which holds the customer's
// credentials, and it downloads CODE THIS PROCESS THEN IMPORTS. The release host is not
// trusted; the control plane's SIGNATURE is. Concretely:
//   1. Everything about the fetch -- url, sha256, token -- comes from the SIGNED grant
//      (ExecutionGrant.packBundle). None of it is runner-side input, none is tenant-editable,
//      and a tampered value fails verifyGrant before this module is ever reached.
//   2. https only (a loopback host may use http: tests, and a self-hosted mirror on the
//      runner itself) -- for the signed url AND for every redirect it leads to. The release
//      host's 302 to signed storage is followed BY HAND, and the bearer token is presented to
//      the signed origin only, never to a redirect target of the host's choosing. A hop to a
//      private, loopback or link-local ADDRESS (or to `localhost` and its RFC 6761 `.localhost`
//      subtree) is refused BEFORE the socket, so it cannot probe the CI job's own
//      network. That check reads the URL, NOT the address it resolves to, so it is no defence
//      against DNS REBINDING: a name the release host controls that resolves to a private
//      address is still connected to. Closing that needs resolve-then-pin-the-socket, which
//      Node's fetch does not offer; the checksum still decides what may be loaded.
//   3. The response is size-capped AS IT ARRIVES (content-length up front, plus a running
//      count over the body stream, so an undeclared multi-gigabyte body is refused rather
//      than buffered), then CHECKSUM-VERIFIED against the signed sha256 before it is parsed,
//      before a byte reaches the disk, and before anything is imported.
//   4. Extraction goes to a fresh 0700 temp directory, never into the runner's own tree, and
//      that directory is REMOVED again on the way out -- success or failure -- so a
//      self-hosted runner does not accumulate copies of licensed source under os.tmpdir().
//      Every path in the bundle is shape-checked AND re-checked to resolve under that root,
//      so a `../` in a manifest key cannot escape it.
//   5. Only gates whose id is in the grant's signed `gateSpecs` are ever registered
//      (run-gate-stage.ts) -- the bundle cannot introduce a gate the tenant didn't pay for.
//   6. The token appears in exactly one place: the Authorization header. Every error message
//      built here carries a SANITIZED url (no userinfo, no query, no fragment) and never the
//      token, because these strings reach logs and the published telemetry digest.
//
// WHAT THIS IS NOT. The bundle is imported into THIS process, with this process's privileges.
// There is no sandbox, no isolate, no separate uid -- Node offers none the runner can rely on
// here. The checksum proves the bytes are the ones the control plane signed for; it proves
// nothing about what they do. See the "Residual risk" section of
// docs/runbooks/purge-packs-from-public-runner.md.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { PackBundleGrant } from '../contracts/types.ts';
import type { Gate } from '../gates/types.ts';
import { isSha256Hex, verifySha256 } from './checksum.ts';

/** 8 MiB. The real bundle is ~225KB of TypeScript source (231,175 bytes across 21 files when
 *  last measured), so the cap sits ~35x above it -- it only has to stop a hostile or broken host
 *  from streaming until the job dies, never to constrain honest growth. The exact byte count
 *  drifts with every pack edit; the ORDER OF MAGNITUDE is the load-bearing part. */
export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

/** The on-the-wire bundle: a single JSON document, so ONE sha256 covers the whole thing.
 *  `files` keys are paths relative to the bundle root, mirroring their layout under src/. */
export interface PackBundleManifest {
  format: 1;
  entry: string;
  files: Record<string, string>;
}

// Which step failed. Callers key on the CODE (structure), never on the prose -- the same
// discipline serve-and-gate.ts's BuildPhase uses.
export type PackBundleFailure =
  | 'invalid-spec'
  | 'token-expired'
  | 'unreachable'
  | 'http-status'
  | 'bad-redirect'
  | 'too-large'
  | 'checksum-mismatch'
  | 'malformed-bundle'
  | 'unsafe-path'
  | 'load-failed';

export class PackBundleError extends Error {
  readonly code: PackBundleFailure;
  constructor(code: PackBundleFailure, message: string) {
    super(message);
    this.name = 'PackBundleError';
    this.code = code;
  }
}

export interface LoadPackBundleDeps {
  /** Injectable fetch for tests; defaults to the global. */
  fetchImpl?: typeof fetch;
  /** Clock override for tests; defaults to the current time. */
  now?: Date;
  /** Where to extract. Defaults to a fresh 0700 directory under os.tmpdir(). */
  extractRoot?: string;
  /** Injectable dynamic import for tests; defaults to a real `import()` of the entry file. */
  importModule?: (fileUrl: string) => Promise<unknown>;
  /** Response size cap; defaults to MAX_BUNDLE_BYTES. */
  maxBytes?: number;
}

// A URL safe to put in a log line or an error message: scheme/host/path only. Strips
// userinfo, query and fragment, any of which could carry a credential in some hosting
// schemes (a pre-signed asset URL puts its signature in the query string).
export function sanitizeBundleUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '<unparseable url>';
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

/** Literal IPv4 ranges a HOP may never resolve to: `[first octet, second-octet lo, hi]`.
 *  A `lo`/`hi` spanning 0-255 means the whole /8. */
const PRIVATE_IPV4_RANGES: readonly (readonly [number, number, number])[] = [
  [0, 0, 255], // 0.0.0.0/8 -- "this host on this network"
  [10, 0, 255], // RFC1918
  [100, 64, 127], // RFC6598 CGNAT
  [127, 0, 255], // loopback
  [169, 254, 254], // RFC3927 link-local -- AWS/GCP/Azure IMDS all live at 169.254.169.254
  [172, 16, 31], // RFC1918
  [192, 168, 168], // RFC1918
];

/** Literal IPv6 prefixes a HOP may never resolve to, as an inclusive range over the FIRST
 *  hextet. Both matter on a dual-stack self-hosted runner in an IPv6 VPC, where they are
 *  ordinary internal addresses rather than exotica. */
const PRIVATE_IPV6_FIRST_HEXTET: readonly (readonly [number, number])[] = [
  [0xfc00, 0xfdff], // fc00::/7 unique-local (RFC4193) -- the IPv6 answer to RFC1918
  [0xfe80, 0xfebf], // fe80::/10 link-local (RFC4291)
  // fec0::/10 site-local: DEPRECATED (RFC3879) and unallocated -- but unallocated is not
  // blocked, and a kernel with a route for it will use it. Never a real bundle host, exactly
  // like the 0.0.0.0/8 and 100.64/10 rows above.
  [0xfec0, 0xfeff],
];

const IPV6_FIRST_HEXTET = /^([0-9a-f]{1,4}):/;

// IPv4 carried inside an IPv6 literal, in both spellings the URL parser produces:
// `::ffff:127.0.0.1` -> `::ffff:7f00:1` (IPv4-MAPPED), and the deprecated IPv4-COMPATIBLE
// `::127.0.0.1` -> `::7f00:1`. Either walks straight past a dotted-quad check.
const IPV4_IN_IPV6 = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

function ipv4Octets(host: string): number[] | undefined {
  const mapped = IPV4_IN_IPV6.exec(host);
  if (mapped) {
    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff];
  }
  const octets = host.split('.');
  if (octets.length !== 4) return undefined;
  const parsed = octets.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return parsed.some((n) => Number.isNaN(n) || n > 255) ? undefined : parsed;
}

/**
 * Whether a hop target is a private, loopback, link-local or unspecified address.
 *
 * This is deliberately NOT a host allow-list. Apart from `localhost` and the `.localhost`
 * subtree it matches ADDRESSES only, so every DNS name -- which is every real storage host --
 * passes untouched and "any release host" stays true, while the release host loses the ability
 * to aim the runner at the CI job's own network. RFC 6761 6.3 reserves `localhost` AND every
 * name ending in `.localhost` to loopback, and that reservation is mandated and universal
 * (macOS, systemd-resolved, Windows), so denying the whole subtree costs that generality
 * nothing -- while `foo.localhost` really does resolve to 127.0.0.1 and ::1 everywhere.
 *
 * Only canonical spellings need handling: `next` is built by `new URL(location, current)`, and
 * the WHATWG parser already normalizes the exotic IPv4 forms (`2130706433`, `0x7f000001`,
 * `0177.0.0.1`, `127.1`, `127.0.0.1.` all become `127.0.0.1`) and compresses and lowercases
 * IPv6. Hostnames arrive lowercased, and an IPv6 literal arrives bracketed.
 *
 * WHAT THIS DOES NOT DO: it reads the URL, not the resolved address, so it is no defence
 * against DNS REBINDING -- a name the release host controls that resolves to a private address
 * is still connected to. Closing that needs resolve-then-pin-the-socket, which Node's fetch
 * does not offer. See the residual-risk note in the module header.
 */
function isPrivateLiteralHost(hostname: string): boolean {
  // The rooted FQDN form, and it can be rooted more than once. The parser folds `127.0.0.1.` to
  // `127.0.0.1` but keeps `localhost.` verbatim, and every trailing dot resolves identically.
  const bare = hostname.replace(/\.+$/, '');
  // isLoopback() is defined fifty lines up and already says what loopback means in this module
  // -- including `localhost`. A second spelling of the same idea is somewhere for the two to
  // drift apart, which is how `localhost` came to be missing from here in the first place.
  //
  // `.localhost` is deliberately NOT pushed down into isLoopback. RFC 6761 6.3 reserves the
  // whole subtree, so it belongs in the HOP rule -- but isLoopback also backs
  // isAllowedBundleUrl, and through it parseSpec and the control plane's config-load check in
  // tenant-store.ts. Widening it there would quietly let a tenant configure a `*.localhost`
  // bundle url over plain http, which is a different decision nobody asked for.
  if (isLoopback(bare) || bare.endsWith('.localhost')) return true;
  const host = bare.startsWith('[') ? bare.slice(1, -1) : bare;
  if (host === '::') return true;
  const octets = ipv4Octets(host);
  if (octets) {
    return PRIVATE_IPV4_RANGES.some(([first, lo, hi]) => octets[0] === first && octets[1] >= lo && octets[1] <= hi);
  }
  const hextet = IPV6_FIRST_HEXTET.exec(host);
  if (!hextet) return false;
  const first = Number.parseInt(hextet[1], 16);
  return PRIVATE_IPV6_FIRST_HEXTET.some(([lo, hi]) => first >= lo && first <= hi);
}

/**
 * The transport rule for a bundle URL: parseable, and https unless it is loopback.
 *
 * Exported so the CONTROL PLANE can apply the identical rule at config-load time
 * (tenant-store.ts). Both sides must agree: this runs at the end of the pipeline, where a
 * violation is a non-transient `invalid-spec` that fails every pack gate at once; the tenant
 * store runs at the start, where the same mistake is a legible config error. Two hand-written
 * copies of this predicate would drift and reopen exactly that gap, so there is one.
 */
export function isAllowedBundleUrl(value: URL | string): boolean {
  let url: URL;
  if (value instanceof URL) {
    url = value;
  } else {
    try {
      url = new URL(value);
    } catch {
      return false;
    }
  }
  return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname));
}

// Shape-checks the signed spec before any I/O. A grant that reached here already verified, so
// a bad spec is a control-plane wiring bug, not an attack -- but it must still stop the stage
// rather than produce a half-configured fetch.
function parseSpec(spec: PackBundleGrant): URL {
  let url: URL;
  try {
    url = new URL(spec.url);
  } catch {
    throw new PackBundleError('invalid-spec', 'pack bundle url is not a valid URL');
  }
  if (!isAllowedBundleUrl(url)) {
    throw new PackBundleError(
      'invalid-spec',
      `pack bundle url must be https (or http on a loopback host), got "${url.protocol}//${url.host}"`,
    );
  }
  if (!isSha256Hex(spec.sha256)) {
    throw new PackBundleError('invalid-spec', 'pack bundle sha256 is not a lowercase hex sha256 digest');
  }
  return url;
}

// Fails BEFORE the request, so an expired credential reports as itself instead of as an
// opaque 401 from the release host -- the two need different operator responses (re-issue the
// grant vs. check the release's permissions).
function assertTokenFresh(spec: PackBundleGrant, now: Date): void {
  if (!spec.tokenExpiresAt) return;
  const expiresAt = new Date(spec.tokenExpiresAt);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new PackBundleError('invalid-spec', 'pack bundle tokenExpiresAt is not a valid ISO 8601 timestamp');
  }
  if (now.getTime() >= expiresAt.getTime()) {
    throw new PackBundleError(
      'token-expired',
      `pack bundle access token expired at ${expiresAt.toISOString()} (now ${now.toISOString()}) -- re-issue the grant`,
    );
  }
}

// What to tell an operator about a refusal, which depends ENTIRELY on who refused.
//
// The "re-issue the grant" hint is about the grant's pack-bundle token, so only the host that
// was actually shown that token may offer it. requestBundle drops the Authorization header
// before the first hop, so a 403 from a redirect target is its OWN pre-signed url expiring or
// being refused -- and an operator sent to re-issue the pack-bundle token for that re-issues
// the wrong credential and loops on the wrong remedy. This string is the entire operator-facing
// artifact (it is copied verbatim into the gate's findings), so it has to name the right one.
function refusalHint(status: number, fromSignedOrigin: boolean): string {
  if (status !== 401 && status !== 403) return '';
  return fromSignedOrigin
    ? ' -- the grant\'s pack-bundle token was rejected or has no read access to the release'
    : ' -- this is the redirect target, which is deliberately sent none of our credentials; its own' +
        ' pre-signed url was refused or has expired, so re-issuing the grant will not help';
}

// Rejects a response before any of its body is read: a non-2xx status, or a content-length that
// already declares more than the cap. Split out of fetchPackBundle to keep that function's
// happy path readable.
function assertResponseAcceptable(
  response: Response,
  maxBytes: number,
  safeUrl: string,
  fromSignedOrigin: boolean,
): void {
  if (!response.ok) {
    const hint = refusalHint(response.status, fromSignedOrigin);
    throw new PackBundleError('http-status', `pack bundle fetch failed: HTTP ${response.status} from ${safeUrl}${hint}`);
  }

  // Enforce the cap BEFORE the bytes are in memory, in both the ways a host can announce or
  // hide its size. `await response.arrayBuffer()` would buffer the whole body first, so a
  // hostile or broken host streaming gigabytes would OOM the job before any check ran -- it
  // would still fail closed, but by killing the runner rather than by refusing the download.
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new PackBundleError('too-large', `pack bundle declares ${declared} bytes, over the ${maxBytes}-byte cap (${safeUrl})`);
  }
}

/** GitHub answers an asset url with exactly one 302 to signed storage; a self-hosted mirror may
 *  add one of its own in front of it. Three leaves both room and still bounds a redirect loop.
 *
 *  A mirror that redirects MUST serve the final hop without auth: the token is dropped after the
 *  first hop unconditionally, same-origin included, so a mirror that still demands it on the hop
 *  it redirects to will answer 401 and the gate stage will fail closed. Serve the bytes on the
 *  signed url itself, or make the hop target unauthenticated. */
const MAX_BUNDLE_REDIRECTS = 3;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

// Resolves a redirect's Location against the url that produced it, and applies the two rules a
// HOP must satisfy which the SIGNED url does not. Split out of requestBundle so the hop policy
// is one thing and the request loop is another.
function resolveHopTarget(location: string, current: URL, signedOriginIsHttpLoopback: boolean): URL {
  // Derived, never passed in: a `safeUrl` parameter can silently disagree with `current`, and
  // then every message below names the wrong host.
  const safeUrl = sanitizeBundleUrl(current.href);
  let next: URL;
  try {
    next = new URL(location, current);
  } catch {
    throw new PackBundleError('bad-redirect', `pack bundle host redirected to an unparseable location (${safeUrl})`);
  }
  if (!isAllowedBundleUrl(next) || (next.protocol !== 'https:' && !signedOriginIsHttpLoopback)) {
    throw new PackBundleError(
      'bad-redirect',
      `pack bundle host redirected to ${sanitizeBundleUrl(next.href)}, which is not https (from ${safeUrl})`,
    );
  }
  // https alone was not enough. `//127.0.0.1:P/x` (scheme-relative, so it inherits https) and
  // `https://127.0.0.1:P/x` from the untrusted release host each opened a REAL TCP connection
  // to the CI job's loopback -- only the `http:` spelling had been closed. Refused BEFORE the
  // socket, never after: a guard that dials first has already answered "is this port open?"
  // for whoever can read the gate's findings.
  if (!signedOriginIsHttpLoopback && isPrivateLiteralHost(next.hostname)) {
    throw new PackBundleError(
      'bad-redirect',
      `pack bundle host redirected to the private address ${sanitizeBundleUrl(next.href)} (from ${safeUrl})`,
    );
  }
  return next;
}

/**
 * Issues the request and follows the release host's redirect by hand, returning the final
 * response together with the sanitized url that produced it (so an HTTP error names the host
 * that actually answered).
 *
 * BOTH halves of this are load-bearing, and the obvious spelling of each is silently wrong. A
 * GitHub release-asset url content-negotiates on `Accept`:
 *
 *   - `application/json` answers 200 with the asset's METADATA record (id, name, size, ...).
 *     That is valid JSON and it is NOT the bundle, so it fails the digest check and the stage
 *     reports `checksum-mismatch` -- a true statement about bytes nobody asked for, and a
 *     completely misleading account of what went wrong.
 *   - `application/octet-stream` is what returns the bytes, and the answer to it is a 302 to a
 *     signed storage host. `redirect: 'error'` turns the only response the asset url ever
 *     gives into a thrown fetch, reported as `unreachable` against a host that replied at once.
 *
 * So: octet-stream, and follow the hop. It is followed MANUALLY rather than with
 * `redirect: 'follow'` because three decisions the customer's credential depends on then get
 * made here, in the open, instead of inside whichever fetch implementation is installed: the
 * Authorization header is dropped after the first hop, each target must satisfy the same
 * https/loopback rule as the signed url, and the number of hops is bounded.
 */
async function requestBundle(
  url: URL,
  spec: PackBundleGrant,
  fetchImpl: typeof fetch,
  originSafeUrl: string,
): Promise<{ response: Response; safeUrl: string; fromSignedOrigin: boolean }> {
  let current = url;
  let safeUrl = originSafeUrl;
  // isAllowedBundleUrl's http-loopback carve-out exists for a SIGNED self-hosted-mirror url --
  // something the control plane chose. Extending it to a HOP would let the release host aim a
  // blind GET at the CI job's own loopback, and since the sanitized url and status are echoed
  // into the gate's findings, at a port/status oracle readable by anyone who can see the PR
  // check. So a hop may leave https only when the signed origin had already left it.
  const signedOriginIsHttpLoopback = url.protocol === 'http:';
  // Presented to the SIGNED origin and to nothing else. The redirect target is the release
  // host's choice, and a pre-signed storage url already carries its own credentials in its
  // query string -- replaying the customer's GitHub token to it would hand that credential to
  // a third-party host for no gain.
  let authorization = spec.token ? `Bearer ${spec.token}` : undefined;

  for (let hop = 0; ; hop += 1) {
    let response: Response;
    try {
      response = await fetchImpl(current, {
        headers: {
          accept: 'application/octet-stream',
          ...(authorization ? { authorization } : {}),
        },
        redirect: 'manual',
      });
    } catch (err) {
      // Deliberately does NOT interpolate the caught error: a fetch failure can include the
      // target URL, and a signed asset URL carries credentials in its query.
      const code = (err as { code?: unknown } | null)?.code;
      throw new PackBundleError(
        'unreachable',
        `pack bundle host unreachable at ${safeUrl}${typeof code === 'string' ? ` (${code})` : ''}`,
      );
    }

    if (!REDIRECT_STATUSES.has(response.status)) return { response, safeUrl, fromSignedOrigin: hop === 0 };

    // Nothing in a redirect body is wanted, and an unread body holds its socket open. The
    // cancel's own failure is irrelevant -- we are about to either follow the hop or throw.
    // eslint-disable-next-line no-restricted-syntax -- justified immediately above
    await response.body?.cancel().catch(() => undefined);

    // The budget first: a host that answers a 4th bodiless 302 has exhausted its hops, and
    // saying "no Location header" about it would name the wrong problem.
    if (hop >= MAX_BUNDLE_REDIRECTS) {
      throw new PackBundleError(
        'bad-redirect',
        `pack bundle fetch exceeded ${MAX_BUNDLE_REDIRECTS} redirects, starting at ${originSafeUrl}`,
      );
    }
    const location = response.headers.get('location');
    if (!location) {
      throw new PackBundleError(
        'bad-redirect',
        `pack bundle host answered HTTP ${response.status} with no Location header (${safeUrl})`,
      );
    }

    current = resolveHopTarget(location, current, signedOriginIsHttpLoopback);
    safeUrl = sanitizeBundleUrl(current.href);
    authorization = undefined;
  }
}

/** Downloads the bundle and returns its EXACT bytes. Nothing is interpreted here. */
export async function fetchPackBundle(spec: PackBundleGrant, deps: LoadPackBundleDeps = {}): Promise<Uint8Array> {
  const url = parseSpec(spec);
  assertTokenFresh(spec, deps.now ?? new Date());

  const fetchImpl = deps.fetchImpl ?? fetch;
  const maxBytes = deps.maxBytes ?? MAX_BUNDLE_BYTES;

  const { response, safeUrl, fromSignedOrigin } = await requestBundle(url, spec, fetchImpl, sanitizeBundleUrl(spec.url));

  assertResponseAcceptable(response, maxBytes, safeUrl, fromSignedOrigin);

  const body = response.body;
  if (!body) {
    // No stream to meter (a fetch polyfill, or a 204). arrayBuffer() is bounded by the
    // content-length check above in every case where the host declared one honestly.
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new PackBundleError('too-large', `pack bundle is ${bytes.byteLength} bytes, over the ${maxBytes}-byte cap (${safeUrl})`);
    }
    return bytes;
  }

  return readCapped(body, maxBytes, safeUrl);
}

// Reads a response body chunk by chunk, refusing it the moment it crosses `maxBytes` rather
// than after it is all in memory. Split out of fetchPackBundle so the metering loop is one
// thing and the request/status handling above is another.
async function readCapped(body: ReadableStream<Uint8Array>, maxBytes: number, safeUrl: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        // Abort the transfer rather than drain it: the point of the cap is to stop reading. The
        // cancel's own failure is irrelevant -- we are already throwing the error that matters,
        // and letting a teardown rejection replace it would hide the reason the stage failed.
        // eslint-disable-next-line no-restricted-syntax -- justified immediately above
        await reader.cancel().catch(() => undefined);
        throw new PackBundleError('too-large', `pack bundle exceeded the ${maxBytes}-byte cap after ${received} bytes (${safeUrl})`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// A bundle path is safe when it is a relative, forward-slashed .ts path built from plain
// segments -- no absolute path, no drive letter, no `.`/`..` segment, no backslash. Checked
// as a SHAPE first and then again by resolution below, because the two catch different
// things (this rejects `..` outright; resolution catches symlink-free path tricks a shape
// check can miss on other platforms).
const SAFE_BUNDLE_PATH = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*\.ts$/;

function assertSafeBundlePath(relPath: string, root: string): string {
  if (!SAFE_BUNDLE_PATH.test(relPath) || relPath.split('/').some((seg) => seg === '.' || seg === '..')) {
    throw new PackBundleError('unsafe-path', `pack bundle contains an unsafe file path: ${JSON.stringify(relPath)}`);
  }
  const abs = path.resolve(root, relPath);
  const within = path.relative(root, abs);
  if (within.startsWith('..') || path.isAbsolute(within)) {
    throw new PackBundleError('unsafe-path', `pack bundle file path escapes the extraction root: ${JSON.stringify(relPath)}`);
  }
  return abs;
}

/** Parses verified bytes into a manifest. Called ONLY after verifySha256 passed. */
export function parsePackBundle(bytes: Uint8Array): PackBundleManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new PackBundleError('malformed-bundle', 'pack bundle is not valid JSON');
  }
  const manifest = parsed as Partial<PackBundleManifest> | null;
  if (!manifest || typeof manifest !== 'object' || manifest.format !== 1) {
    throw new PackBundleError('malformed-bundle', 'pack bundle has no recognized "format": 1 header');
  }
  if (typeof manifest.entry !== 'string' || !manifest.files || typeof manifest.files !== 'object') {
    throw new PackBundleError('malformed-bundle', 'pack bundle is missing "entry" or "files"');
  }
  for (const [rel, source] of Object.entries(manifest.files)) {
    if (typeof source !== 'string') {
      throw new PackBundleError('malformed-bundle', `pack bundle file ${JSON.stringify(rel)} is not a string`);
    }
  }
  // Object.hasOwn, not `in`: `in` walks the prototype chain, so a manifest declaring
  // `entry: "toString"` would pass this check with no such file, and extract() would then hand
  // an empty path to pathToFileURL -- which resolves to the process CWD. It happens to fail
  // afterwards, but by accident rather than by design, and an own-property check is the same
  // one line.
  if (!Object.hasOwn(manifest.files, manifest.entry)) {
    throw new PackBundleError('malformed-bundle', `pack bundle entry ${JSON.stringify(manifest.entry)} is not one of its files`);
  }
  return manifest as PackBundleManifest;
}

// Writes the manifest into a fresh private directory. 0700 on the directory and 0600 on every
// file: the extracted source is licensed IP sitting on a shared CI host, and nothing else on
// that host has any business reading it.
async function extract(manifest: PackBundleManifest, root: string): Promise<string> {
  let entryAbs = '';
  for (const [rel, source] of Object.entries(manifest.files)) {
    const abs = assertSafeBundlePath(rel, root);
    await mkdir(path.dirname(abs), { recursive: true, mode: 0o700 });
    await writeFile(abs, source, { encoding: 'utf8', mode: 0o600 });
    if (rel === manifest.entry) entryAbs = abs;
  }
  return entryAbs;
}

/**
 * The whole path, in order: fetch -> checksum-verify -> parse -> extract -> import -> validate.
 *
 * Every failure throws a PackBundleError with its own code and its own message. NOTHING here
 * degrades to "carry on without the pack gates": the caller turns any throw into a failed gate
 * stage, because a stage that reports green over gates that never executed is worse than no
 * gate at all (post-mortem TEK-3691).
 */
export async function loadPackBundleGates(spec: PackBundleGrant, deps: LoadPackBundleDeps = {}): Promise<Gate[]> {
  const bytes = await fetchPackBundle(spec, deps);

  // BEFORE parsing, BEFORE any write, BEFORE any import.
  const checksum = verifySha256(bytes, spec.sha256);
  if (!checksum.ok) {
    throw new PackBundleError(
      'checksum-mismatch',
      `pack bundle failed integrity check -- ${checksum.reason}. Refusing to load it; the gate stage cannot run.`,
    );
  }

  const manifest = parsePackBundle(bytes);
  // A caller-supplied root is the caller's to clean up (tests); one we mint is ours. The
  // extracted tree is LICENSED SOURCE sitting on a CI host: leaving it behind means every gate
  // stage deposits another copy under os.tmpdir() forever. Moot on an ephemeral hosted runner,
  // but a self-hosted runner -- exactly what the loopback carve-out above exists to support --
  // accumulates them across jobs and tenants, readable by anything running as the same user.
  const ownedRoot = deps.extractRoot ? undefined : await mkdtemp(path.join(os.tmpdir(), 'autopilot-packs-'));
  const root = deps.extractRoot ?? ownedRoot!;
  await mkdir(root, { recursive: true, mode: 0o700 });

  try {
    const entryAbs = await extract(manifest, root);

    const importModule = deps.importModule ?? ((fileUrl: string): Promise<unknown> => import(fileUrl));
    let mod: unknown;
    try {
      mod = await importModule(pathToFileURL(entryAbs).href);
    } catch (err) {
      throw new PackBundleError(
        'load-failed',
        `pack bundle entry ${JSON.stringify(manifest.entry)} failed to load: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const factory = (mod as { runnerPackGates?: unknown } | null)?.runnerPackGates;
    if (typeof factory !== 'function') {
      throw new PackBundleError('load-failed', 'pack bundle entry does not export a runnerPackGates() function');
    }

    const gates: unknown = (factory as () => unknown)();
    if (!Array.isArray(gates) || gates.some((gate) => !isGate(gate))) {
      throw new PackBundleError('load-failed', 'pack bundle runnerPackGates() did not return an array of gates');
    }
    return gates as Gate[];
  } finally {
    // Safe even though the gates are still live: Node has already evaluated the modules into
    // memory, and nothing in a pack gate re-reads its own source at run time. Best-effort --
    // failing to tidy up must never turn a working gate stage into a failed one.
    //
    // But not SILENT. This module's contract (top of file) is that the extraction directory is
    // removed success or failure, so a self-hosted runner does not accumulate copies of licensed
    // source under os.tmpdir(). A discarded failure here is exactly the case where that stops
    // being true, and the operator who has to go looking is the only one who can act on it.
    if (ownedRoot) {
      await rm(ownedRoot, { recursive: true, force: true }).catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[pack-bundle] could not remove the extraction directory ${ownedRoot}: ${reason} -- ` +
            'licensed pack source may remain on this runner; remove it manually\n',
        );
      });
    }
  }
}

function isGate(value: unknown): value is Gate {
  const gate = value as { id?: unknown; run?: unknown } | null;
  return !!gate && typeof gate === 'object' && typeof gate.id === 'string' && typeof gate.run === 'function';
}
