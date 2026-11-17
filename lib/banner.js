// Client for Northeastern's Banner class-search API.
// Reference: https://jennydaman.gitlab.io/nubanned/
//
// Banner ties a search to a session: you POST the term to /term/search to
// get authorised cookies, then GET /searchResults/searchResults with them.

const BASE = 'https://nubanner.neu.edu/StudentRegistrationSsb/ssb';
const PAGE_SIZE = 500; // Banner's maximum
const TIMEOUT_MS = 45_000;
const HEADERS = { 'User-Agent': 'course-scheduler (personal schedule planner)' };

const DAY_FIELDS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text) {
  if (!text) return '';
  return String(text)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match);
}

/** "0950" -> 590 minutes after midnight. */
export function parseTime(hhmm) {
  if (!hhmm || !/^\d{4}$/.test(hhmm)) return null;
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(2));
}

/** "01/13/2027" -> 20270113, so date ranges compare as plain numbers. */
export function parseDate(mdy) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(mdy ?? '');
  return match ? Number(match[3] + match[1] + match[2]) : null;
}

// Banner's attribute code for each NUPath, where it isn't just "NC" + the code.
const NUPATH_RENAMES = { W1: 'WF', W3: 'WD' }; // first-year and advanced writing

/**
 * The NUPath requirements a section fulfills, as their two-letter codes
 * ("NCFQ" -> "FQ", "NCW1" -> "WF"). Banner also lists the retired NU Core
 * attributes with similar NC.. codes, so only those described as NUpath count.
 */
export function nupathCodes(attributes) {
  return (attributes ?? [])
    .filter((attr) => /^NC[A-Z0-9]{2}$/.test(attr.code ?? '') && /\bNUpath\b/i.test(attr.description ?? ''))
    .map((attr) => NUPATH_RENAMES[attr.code.slice(2)] ?? attr.code.slice(2));
}

/** Reduce Banner's very large section record to what the scheduler needs. */
export function slimSection(raw) {
  const meetings = [];
  for (const entry of raw.meetingsFaculty ?? []) {
    const mt = entry.meetingTime;
    if (!mt) continue;
    const start = parseTime(mt.beginTime);
    const end = parseTime(mt.endTime);
    const days = DAY_FIELDS.flatMap((field, index) => (mt[field] ? [index] : []));
    if (start === null || end === null || end <= start || days.length === 0) continue;
    meetings.push({
      days,
      start,
      end,
      where: [mt.buildingDescription, mt.room].filter(Boolean).map(decodeEntities).join(' '),
      startDate: parseDate(mt.startDate) ?? 0,
      endDate: parseDate(mt.endDate) ?? 99991231,
    });
  }
  const instructors = (raw.faculty ?? [])
    .map((person) => decodeEntities(person.displayName))
    .filter(Boolean);
  return {
    crn: raw.courseReferenceNumber,
    subject: raw.subject,
    number: raw.courseNumber,
    title: decodeEntities(raw.courseTitle).trim(),
    section: raw.sequenceNumber,
    campus: decodeEntities(raw.campusDescription),
    type: decodeEntities(raw.scheduleTypeDescription),
    method: decodeEntities(raw.instructionalMethodDescription),
    credits: raw.creditHours ?? raw.creditHourLow ?? 0,
    seats: raw.seatsAvailable ?? 0,
    capacity: raw.maximumEnrollment ?? 0,
    waitSeats: raw.waitAvailable ?? 0,
    waitCapacity: raw.waitCapacity ?? 0,
    honors: (raw.sectionAttributes ?? []).some((attr) => /honors/i.test(attr.description ?? '')),
    nupath: nupathCodes(raw.sectionAttributes),
    instructors,
    meetings,
  };
}

/**
 * Pull the corequisite rows out of the HTML Banner returns. The table has
 * between 3 and 5 columns depending on the course, so find the course-number
 * cell and read the subject and title from either side of it.
 */
export function parseCorequisites(html) {
  const coreqs = [];
  const section = /<section[^>]*coReqs[^>]*>([\s\S]*?)<\/section>/i.exec(html ?? '');
  const body = /<tbody>([\s\S]*?)<\/tbody>/i.exec(section ? section[1] : '');
  if (!body) return coreqs;
  for (const row of body[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) =>
      decodeEntities(cell[1].replace(/<[^>]+>/g, '')).trim(),
    );
    const at = cells.findIndex((cell) => /^\d{4}[A-Z]?$/.test(cell));
    if (at < 1) continue;
    coreqs.push({ subjectDescription: cells[at - 1], number: cells[at], title: cells[at + 1] ?? '' });
  }
  return coreqs;
}

async function request(path, options = {}) {
  const response = await fetch(BASE + path, {
    redirect: 'manual', // a redirect means Banner bounced us to the login page
    signal: AbortSignal.timeout(TIMEOUT_MS),
    ...options,
    headers: { ...HEADERS, ...options.headers },
  });
  if (response.status !== 200) {
    await response.arrayBuffer().catch(() => {});
    throw new Error(`Banner answered ${response.status} for ${path.split('?')[0]}`);
  }
  return response;
}

async function requestJson(path, options) {
  const response = await request(path, options);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Banner sent something other than JSON for ${path.split('?')[0]}`);
  }
}

export async function getTerms() {
  const terms = await requestJson('/classSearch/getTerms?offset=1&max=30&searchTerm=');
  return terms.map((term) => ({ code: term.code, description: decodeEntities(term.description) }));
}

async function openSession(term) {
  const response = await request('/term/search?mode=search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: new URLSearchParams({ term, studyPath: '', studyPathText: '', startDatepicker: '', endDatepicker: '' }),
  });
  await response.arrayBuffer();
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
}

async function searchPage(cookie, term, filters, offset) {
  const query = new URLSearchParams({
    ...filters,
    txt_term: term,
    startDatepicker: '',
    endDatepicker: '',
    pageOffset: String(offset),
    pageMaxSize: String(PAGE_SIZE),
    sortColumn: 'subjectDescription',
    sortDirection: 'asc',
  });
  const result = await requestJson(`/searchResults/searchResults?${query}`, { headers: { Cookie: cookie } });
  if (!result.success) throw new Error('Banner rejected the search');
  return result;
}

async function withRetries(attempts, task) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
    }
  }
  throw lastError;
}

/**
 * Fetch every section matching `filters` (for example { txt_subject: 'CS',
 * txt_courseNumber: '3000' }, or {} for the whole term), following pagination.
 * Returns { sections, subjects, expected } where subjects maps code -> name.
 */
export async function fetchSections(term, filters = {}, { onProgress, workers = 3 } = {}) {
  const byCrn = new Map();
  const subjects = {};
  const absorb = (rows) => {
    for (const raw of rows ?? []) {
      byCrn.set(raw.courseReferenceNumber, slimSection(raw));
      subjects[raw.subject] = decodeEntities(raw.subjectDescription);
    }
  };

  // Each attempt opens a fresh session, which also recovers from an expired one.
  const loadPage = (offset) =>
    withRetries(3, async () => searchPage(await openSession(term), term, filters, offset));

  const first = await loadPage(0);
  const expected = first.totalCount ?? 0;
  absorb(first.data);
  onProgress?.(byCrn.size, expected);

  const offsets = [];
  for (let offset = PAGE_SIZE; offset < expected; offset += PAGE_SIZE) offsets.push(offset);

  const worker = async () => {
    const cookie = { value: null };
    while (offsets.length) {
      const offset = offsets.shift();
      const page = await withRetries(3, async (attempt) => {
        if (!cookie.value || attempt > 0) cookie.value = await openSession(term);
        return searchPage(cookie.value, term, filters, offset);
      });
      absorb(page.data);
      onProgress?.(byCrn.size, expected);
    }
  };
  await Promise.all(Array.from({ length: Math.min(workers, offsets.length) }, worker));

  return { sections: [...byCrn.values()], subjects, expected };
}

/**
 * Who teaches a section. The search results leave this blank, so it has to be
 * asked for one section at a time. Returns names as Banner writes them
 * ("Lovelace, Ada"), primary instructor first; empty if nobody is assigned yet.
 */
export async function fetchInstructors(term, crn) {
  const query = new URLSearchParams({ term, courseReferenceNumber: crn });
  const result = await requestJson(`/searchResults/getFacultyMeetingTimes?${query}`);
  return instructorNames(result);
}

export function instructorNames(result) {
  const people = (result?.fmt ?? []).flatMap((entry) => entry.faculty ?? []);
  people.sort((a, b) => Number(Boolean(b.primaryIndicator)) - Number(Boolean(a.primaryIndicator)));
  return [...new Set(people.map((person) => decodeEntities(person.displayName).trim()).filter(Boolean))];
}

export async function fetchCorequisites(term, crn) {
  const response = await request('/searchResults/getCorequisites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: new URLSearchParams({ term, courseReferenceNumber: crn }),
  });
  return parseCorequisites(await response.text());
}
