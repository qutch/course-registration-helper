// Local server for the course scheduler. It serves the page in public/ and
// relays requests to Banner, which browsers can't call directly (no CORS).
// The full class list for a term is downloaded once and kept in .cache/.

import { createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchCorequisites, fetchInstructors, fetchSections, getTerms } from './lib/banner.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const CACHE_DIR = join(ROOT, '.cache');
const PORT = Number(process.env.PORT) || 4747;
const HOST = '127.0.0.1';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const catalogs = new Map(); // term -> { term, fetchedAt, sections, subjects }
const loads = new Map(); // term -> { loaded, total, error }
const coreqCache = new Map(); // "term:crn" -> [{ subject, number, title }]
const instructorCaches = new Map(); // term -> { [crn]: { names, at } }
const INSTRUCTOR_TTL_MS = 12 * 60 * 60 * 1000;
let termsCache = null;

const isTerm = (value) => /^\d{6}$/.test(value ?? '');
const isSubject = (value) => /^[A-Z]{2,6}$/.test(value ?? '');
const isCourseNumber = (value) => /^[A-Z0-9]{1,6}$/.test(value ?? '');
const isCrn = (value) => /^\d{4,6}$/.test(value ?? '');

// Bump when the saved class list gains or changes fields, so older copies are
// downloaded again instead of quietly missing data (2: NUPath attributes).
const CATALOG_VERSION = 2;

const cachePath = (term) => join(CACHE_DIR, `term-${term}.json`);

async function saveCatalog(catalog) {
  await mkdir(CACHE_DIR, { recursive: true });
  const temporary = `${cachePath(catalog.term)}.tmp`;
  await writeFile(temporary, JSON.stringify(catalog));
  await rename(temporary, cachePath(catalog.term));
}

async function readCatalog(term) {
  if (catalogs.has(term)) return catalogs.get(term);
  try {
    const catalog = JSON.parse(await readFile(cachePath(term), 'utf8'));
    if (catalog.version !== CATALOG_VERSION) return null;
    await applyInstructors(term, catalog.sections);
    catalogs.set(term, catalog);
    return catalog;
  } catch {
    return null;
  }
}

// ---- Instructors -------------------------------------------------------------
// Banner only reveals instructors one section at a time, so they are looked up
// for the classes someone actually picks and remembered in their own file,
// which survives re-downloading the class list.

const instructorPath = (term) => join(CACHE_DIR, `instructors-${term}.json`);

async function readInstructors(term) {
  if (!instructorCaches.has(term)) {
    let cache = {};
    try {
      cache = JSON.parse(await readFile(instructorPath(term), 'utf8'));
    } catch {}
    instructorCaches.set(term, cache);
  }
  return instructorCaches.get(term);
}

/** Copy the instructors we already know onto freshly downloaded sections. */
async function applyInstructors(term, sections) {
  const cache = await readInstructors(term);
  for (const section of sections) {
    const known = cache[section.crn];
    if (!known) continue;
    section.instructors = known.names;
    section.instructorsKnown = true;
  }
}

/** Look up whoever teaches each section, skipping ones checked recently. */
async function lookUpInstructors(term, sections) {
  const cache = await readInstructors(term);
  const stale = sections.filter((section) => !cache[section.crn] || Date.now() - cache[section.crn].at > INSTRUCTOR_TTL_MS);
  await mapLimit(stale, 6, async (section) => {
    try {
      cache[section.crn] = { names: await fetchInstructors(term, section.crn), at: Date.now() };
    } catch (error) {
      console.warn(`Could not look up the instructor for CRN ${section.crn}:`, error.message);
    }
  });
  if (stale.length) {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(instructorPath(term), JSON.stringify(cache));
  }
  await applyInstructors(term, sections);
}

function startLoad(term) {
  const existing = loads.get(term);
  if (existing && !existing.error) return existing;
  const load = { loaded: 0, total: 0, error: null };
  loads.set(term, load);
  fetchSections(term, {}, {
    onProgress: (loaded, total) => {
      load.loaded = loaded;
      load.total = total;
    },
  })
    .then(async ({ sections, subjects, expected }) => {
      if (sections.length < expected) {
        console.warn(`Term ${term}: Banner reported ${expected} sections but ${sections.length} arrived.`);
      }
      await applyInstructors(term, sections);
      const catalog = { version: CATALOG_VERSION, term, fetchedAt: Date.now(), sections, subjects };
      catalogs.set(term, catalog);
      loads.delete(term);
      await saveCatalog(catalog);
      console.log(`Term ${term}: saved ${sections.length} sections.`);
    })
    .catch((error) => {
      console.error(`Term ${term}: load failed -`, error.message);
      load.error = error.message;
    });
  return load;
}

async function handleCatalog(url) {
  const term = url.searchParams.get('term');
  if (!isTerm(term)) return [400, { error: 'Unknown term.' }];
  const wantsFresh = url.searchParams.get('refresh') === '1';
  const running = loads.get(term);

  if (running?.error && !wantsFresh) {
    loads.delete(term);
    return [200, { status: 'error', message: running.error }];
  }
  if (!running || running.error) {
    const catalog = wantsFresh ? null : await readCatalog(term);
    if (catalog) return [200, { status: 'ready', ...catalog }];
  }
  const load = startLoad(term);
  return [200, { status: 'loading', loaded: load.loaded, total: load.total }];
}

async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Re-fetch a handful of courses so their seat counts are current, and find out who teaches them. */
async function handleRefresh(body) {
  const { term, courses } = body ?? {};
  if (!isTerm(term) || !Array.isArray(courses)) return [400, { error: 'Bad request.' }];
  const wanted = courses
    .filter((course) => isSubject(course?.subject) && isCourseNumber(course?.number))
    .slice(0, 15);

  const fresh = await mapLimit(wanted, 3, async ({ subject, number }) => {
    const { sections } = await fetchSections(term, { txt_subject: subject, txt_courseNumber: number });
    return {
      subject,
      number,
      sections: sections.filter((section) => section.subject === subject && section.number === number),
    };
  });
  await lookUpInstructors(term, fresh.flatMap((course) => course.sections)).catch((error) =>
    console.error('Could not look up instructors:', error.message),
  );

  const catalog = await readCatalog(term);
  if (catalog) {
    for (const course of fresh) {
      catalog.sections = catalog.sections
        .filter((section) => !(section.subject === course.subject && section.number === course.number))
        .concat(course.sections);
    }
    saveCatalog(catalog).catch((error) => console.error('Could not save the class list:', error.message));
  }
  return [200, { refreshedAt: Date.now(), courses: fresh }];
}

async function handleCoreqs(url) {
  const term = url.searchParams.get('term');
  const crn = url.searchParams.get('crn');
  if (!isTerm(term) || !isCrn(crn)) return [400, { error: 'Bad request.' }];
  const key = `${term}:${crn}`;
  if (!coreqCache.has(key)) {
    const catalog = await readCatalog(term);
    const codeByName = new Map(Object.entries(catalog?.subjects ?? {}).map(([code, name]) => [name, code]));
    const coreqs = (await fetchCorequisites(term, crn))
      .map((coreq) => ({
        subject: codeByName.get(coreq.subjectDescription),
        number: coreq.number,
        title: coreq.title,
      }))
      .filter((coreq) => coreq.subject);
    coreqCache.set(key, coreqs);
  }
  return [200, { coreqs: coreqCache.get(key) }];
}

async function handleTerms() {
  if (!termsCache || Date.now() - termsCache.at > 60 * 60 * 1000) {
    termsCache = { at: Date.now(), terms: await getTerms() };
  }
  return [200, { terms: termsCache.terms }];
}

async function readJsonBody(request) {
  let text = '';
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 100_000) throw new Error('Request too large.');
  }
  return JSON.parse(text || '{}');
}

async function handleApi(request, url) {
  if (request.method === 'GET' && url.pathname === '/api/terms') return handleTerms();
  if (request.method === 'GET' && url.pathname === '/api/catalog') return handleCatalog(url);
  if (request.method === 'GET' && url.pathname === '/api/coreqs') return handleCoreqs(url);
  if (request.method === 'POST' && url.pathname === '/api/refresh') return handleRefresh(await readJsonBody(request));
  return [404, { error: 'Not found.' }];
}

async function serveStatic(url, response) {
  const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = normalize(join(PUBLIC_DIR, relative));
  if (!file.startsWith(PUBLIC_DIR + sep)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const contents = await readFile(file);
    response.writeHead(200, {
      'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    response.end(contents);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
  if (!url.pathname.startsWith('/api/')) return serveStatic(url, response);
  try {
    const [status, payload] = await handleApi(request, url);
    response.writeHead(status, { 'Content-Type': CONTENT_TYPES['.json'], 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(payload));
  } catch (error) {
    console.error(`${request.method} ${url.pathname} failed -`, error.message);
    response.writeHead(502, { 'Content-Type': CONTENT_TYPES['.json'] });
    response.end(JSON.stringify({ error: "Couldn't reach Northeastern's class search. Try again in a moment." }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Course scheduler is running at http://localhost:${PORT}`);
});
