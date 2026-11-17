// Schedule-fitting logic. Pure functions with no DOM access, so the same file
// runs in the browser and under `node --test`.
//
// Vocabulary:
//   section  one offering of a course (has a CRN and zero or more meetings)
//   meeting  { days: [0=Mon..6=Sun], start, end (minutes), startDate, endDate }
//   option   all sections of one course that meet at exactly the same times;
//            schedules are built from options so that ten identical-time
//            sections don't show up as ten "different" schedules
//   busy     a block of the week the student marked as unavailable

export const NO_CAMPUS = 'No campus, no room needed';
export const MAX_SCHEDULES = 20000;

export function meetingsOverlap(a, b) {
  if (a.end <= b.start || b.end <= a.start) return false;
  if (a.endDate < b.startDate || b.endDate < a.startDate) return false;
  return a.days.some((day) => b.days.includes(day));
}

export function sectionsConflict(a, b) {
  return a.meetings.some((ma) => b.meetings.some((mb) => meetingsOverlap(ma, mb)));
}

export function isOnline(section) {
  return section.campus === 'Online' || section.method === 'Online';
}

function hitsBusy(meeting, busy) {
  return busy.some((block) => meeting.days.includes(block.day) && meeting.start < block.end && block.start < meeting.end);
}

/**
 * Why a section can't be used under the current preferences, or null if it
 * can. Reasons: 'removed' | 'campus' | 'online' | 'honors' | 'full' |
 * 'early' | 'late' | 'dayOff' | 'busy'.
 */
export function rejectionReason(section, prefs, excluded = new Set()) {
  if (excluded.has(section.crn)) return 'removed';
  const online = isOnline(section);
  if (online && !prefs.includeOnline) return 'online';
  if (!online && prefs.campus !== 'any' && section.campus !== prefs.campus && section.campus !== NO_CAMPUS) {
    return 'campus';
  }
  if (section.honors && !prefs.includeHonors) return 'honors';
  if (prefs.openOnly && section.seats <= 0) return 'full';
  for (const meeting of section.meetings) {
    if (prefs.earliest != null && meeting.start < prefs.earliest) return 'early';
    if (prefs.latest != null && meeting.end > prefs.latest) return 'late';
    if (meeting.days.some((day) => prefs.daysOff.includes(day))) return 'dayOff';
    if (hitsBusy(meeting, prefs.busy)) return 'busy';
  }
  return null;
}

const TIME_REASONS = ['early', 'late', 'dayOff', 'busy'];

function timeKey(section) {
  return section.meetings
    .map((m) => `${m.days.join('')}@${m.start}-${m.end}@${m.startDate}-${m.endDate}`)
    .sort()
    .join('|');
}

/** Best section to show for an option: open seats first, then the most seats. */
function bySeats(a, b) {
  return Number(b.seats > 0) - Number(a.seats > 0) || b.seats - a.seats || a.section.localeCompare(b.section);
}

/**
 * Work out which sections of a course are usable and group them into options.
 * `course` is { key, sections }; `choice` is { excluded: Set<crn>, locked: crn|null }.
 * A locked section overrides the choices about which sections to consider
 * (campus, full, honors...), but not the student's time limits: if it lands
 * in busy time the course has no options and `lockedOut` is set.
 */
export function buildOptions(course, prefs, choice = {}) {
  const excluded = choice.excluded ?? new Set();
  const rejected = {};
  let usable;
  let lockedOut = false;
  const locked = choice.locked && course.sections.find((section) => section.crn === choice.locked);
  if (locked) {
    const reason = rejectionReason(locked, prefs, excluded);
    lockedOut = TIME_REASONS.includes(reason);
    if (lockedOut) rejected[reason] = 1;
    usable = lockedOut ? [] : [locked];
  } else {
    usable = [];
    for (const section of course.sections) {
      const reason = rejectionReason(section, prefs, excluded);
      if (reason) rejected[reason] = (rejected[reason] ?? 0) + 1;
      else usable.push(section);
    }
  }
  const groups = new Map();
  for (const section of usable) {
    const key = timeKey(section);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(section);
  }
  const options = [...groups.entries()].map(([key, sections]) => ({
    courseKey: course.key,
    key,
    sections: sections.sort(bySeats),
    meetings: sections[0].meetings,
  }));
  return { courseKey: course.key, options, rejected, total: course.sections.length, lockedOut };
}

/**
 * Every way of picking one option per course with no two overlapping.
 * `courseOptions` is an array of option arrays. Returns { schedules, truncated }
 * where each schedule lists its options in the same order as the input.
 */
export function generateSchedules(courseOptions, limit = MAX_SCHEDULES) {
  if (courseOptions.length === 0) return { schedules: [], truncated: false };
  if (courseOptions.some((options) => options.length === 0)) return { schedules: [], truncated: false };

  // Tightest courses first, so dead ends are found early.
  const order = courseOptions.map((_, index) => index).sort((a, b) => courseOptions[a].length - courseOptions[b].length);

  const conflictCache = new Map();
  const conflicts = (a, b) => {
    let row = conflictCache.get(a);
    if (!row) conflictCache.set(a, (row = new Map()));
    if (!row.has(b)) row.set(b, sectionsConflict(a, b));
    return row.get(b);
  };

  const schedules = [];
  const chosen = new Array(courseOptions.length);
  let truncated = false;

  const place = (depth) => {
    if (depth === order.length) {
      if (schedules.length >= limit) {
        truncated = true;
        return false;
      }
      schedules.push([...chosen]);
      return true;
    }
    const courseIndex = order[depth];
    for (const option of courseOptions[courseIndex]) {
      let fits = true;
      for (let earlier = 0; earlier < depth; earlier++) {
        if (conflicts(chosen[order[earlier]], option)) {
          fits = false;
          break;
        }
      }
      if (!fits) continue;
      chosen[courseIndex] = option;
      if (!place(depth + 1)) return false;
    }
    return true;
  };
  place(0);
  return { schedules, truncated };
}

/** Facts about a schedule's shape, used for ranking and for the summary line. */
export function measure(schedule) {
  const byDay = new Map();
  for (const option of schedule) {
    for (const meeting of option.meetings) {
      for (const day of meeting.days) {
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(meeting);
      }
    }
  }
  let earliest = null;
  let latest = null;
  let gaps = 0;
  let startSum = 0;
  let endSum = 0;
  let earlyMinutes = 0;
  let lateMinutes = 0;
  for (const meetings of byDay.values()) {
    meetings.sort((a, b) => a.start - b.start);
    const first = meetings[0].start;
    const last = Math.max(...meetings.map((m) => m.end));
    earliest = earliest === null ? first : Math.min(earliest, first);
    latest = latest === null ? last : Math.max(latest, last);
    startSum += first;
    endSum += last;
    earlyMinutes += Math.max(0, 9 * 60 - first);
    lateMinutes += Math.max(0, last - 17 * 60);
    let cursor = meetings[0].end;
    for (const meeting of meetings.slice(1)) {
      if (meeting.start > cursor) gaps += meeting.start - cursor;
      cursor = Math.max(cursor, meeting.end);
    }
  }
  const days = byDay.size;
  return {
    days,
    earliest,
    latest,
    gaps,
    averageStart: days ? startSum / days : 0,
    averageEnd: days ? endSum / days : 0,
    earlyMinutes,
    lateMinutes,
    fullOptions: schedule.filter((option) => option.sections[0].seats <= 0).length,
  };
}

export const SORTS = {
  balanced: { label: 'Best overall', rank: (m) => m.gaps + m.days * 45 + (m.earlyMinutes + m.lateMinutes) / 2 },
  lateStart: { label: 'Latest mornings', rank: (m) => -m.averageStart },
  earlyFinish: { label: 'Earliest finish', rank: (m) => m.averageEnd },
  fewestDays: { label: 'Fewest days on campus', rank: (m) => m.days * 10000 + m.gaps },
  compact: { label: 'Least time between classes', rank: (m) => m.gaps },
};

/** Sort schedules best-first. Schedules needing a full section sink below ones that don't. */
export function rankSchedules(schedules, sortKey = 'balanced') {
  const sort = SORTS[sortKey] ?? SORTS.balanced;
  const fallback = SORTS.balanced;
  return schedules
    .map((schedule) => {
      const metrics = measure(schedule);
      return { schedule, metrics, rank: sort.rank(metrics), tiebreak: fallback.rank(metrics) };
    })
    .sort((a, b) => a.metrics.fullOptions - b.metrics.fullOptions || a.rank - b.rank || a.tiebreak - b.tiebreak);
}

/**
 * Explain why no schedule exists. `built` is the buildOptions result for each
 * course. Returns a list of problems:
 *   { kind: 'noSections', courseKey, rejected, total, lockedOut }
 *   { kind: 'pair', courseKeys: [a, b] }       the two never fit together
 *   { kind: 'dropOne', courseKeys: [...] }     dropping any one of these works
 *   { kind: 'unknown' }
 */
export function diagnose(built) {
  const empty = built.filter((course) => course.options.length === 0);
  if (empty.length) {
    return empty.map((course) => ({
      kind: 'noSections',
      courseKey: course.courseKey,
      rejected: course.rejected,
      total: course.total,
      lockedOut: course.lockedOut,
    }));
  }
  const problems = [];
  for (let i = 0; i < built.length; i++) {
    for (let j = i + 1; j < built.length; j++) {
      const clash = built[i].options.every((a) => built[j].options.every((b) => sectionsConflict(a, b)));
      if (clash) problems.push({ kind: 'pair', courseKeys: [built[i].courseKey, built[j].courseKey] });
    }
  }
  if (problems.length) return problems;

  const droppable = built
    .filter((_, skip) => {
      const rest = built.filter((_, index) => index !== skip).map((course) => course.options);
      return rest.length > 0 && generateSchedules(rest, 1).schedules.length > 0;
    })
    .map((course) => course.courseKey);
  return droppable.length ? [{ kind: 'dropOne', courseKeys: droppable }] : [{ kind: 'unknown' }];
}

// ---- Catalog search ---------------------------------------------------------

/** Northeastern's NUPath requirements, by the code Banner uses after "NC". */
export const NUPATHS = [
  { code: 'ND', name: 'Natural and Designed World' },
  { code: 'EI', name: 'Creative Expression/Innovation' },
  { code: 'IC', name: 'Interpreting Culture' },
  { code: 'FQ', name: 'Formal and Quantitative Reasoning' },
  { code: 'SI', name: 'Societies and Institutions' },
  { code: 'AD', name: 'Analyzing and Using Data' },
  { code: 'DD', name: 'Difference and Diversity' },
  { code: 'ER', name: 'Ethical Reasoning' },
  { code: 'WF', name: 'First-Year Writing' },
  { code: 'WI', name: 'Writing-Intensive' },
  { code: 'WD', name: 'Advanced Writing in the Disciplines' },
  { code: 'EX', name: 'Integration Experience' },
  { code: 'CE', name: 'Capstone Experience' },
];

/** Collapse sections into one entry per course, with the most common title. */
export function buildCourseIndex(sections, subjects = {}) {
  const courses = new Map();
  for (const section of sections) {
    const key = `${section.subject} ${section.number}`;
    let course = courses.get(key);
    if (!course) {
      course = { key, subject: section.subject, number: section.number, sections: [], titles: new Map() };
      courses.set(key, course);
    }
    course.sections.push(section);
    course.titles.set(section.title, (course.titles.get(section.title) ?? 0) + 1);
  }
  for (const course of courses.values()) {
    course.title = [...course.titles.entries()].sort((a, b) => b[1] - a[1])[0][0];
    course.subjectName = subjects[course.subject] ?? '';
    course.credits = Math.max(...course.sections.map((section) => section.credits || 0));
    // Sections of one course can differ (an honors section may add one), so keep them all.
    const nupath = new Set(course.sections.flatMap((section) => section.nupath ?? []));
    course.nupath = NUPATHS.map((path) => path.code).filter((code) => nupath.has(code));
    course.words = `${course.subject} ${course.number} ${course.subject}${course.number} ${course.title} ${course.subjectName}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    delete course.titles;
  }
  return courses;
}

/**
 * Find courses matching what the student typed: "cs 3000", "CS3000",
 * "algorithms", "organic chem", "math 13". Best matches first. `nupath`
 * keeps only courses that fulfill that NUPath code; with it, an empty query
 * lists every such course.
 */
export function searchCourses(courses, query, { nupath = null, limit = 12 } = {}) {
  const text = query.trim().toLowerCase();
  if (!text && !nupath) return [];
  const code = /^([a-z]{2,6})\s*(\d{1,4}[a-z]?)$/.exec(text);
  const tokens = text.split(/[^a-z0-9]+/).filter(Boolean);
  // Each typed word must begin some word of the course ("chem" finds "Chemistry").
  const begins = (words, token) => words.some((word) => word.startsWith(token));
  const matches = [];
  for (const course of courses.values()) {
    if (nupath && !course.nupath.includes(nupath)) continue;
    const subject = course.subject.toLowerCase();
    const number = course.number.toLowerCase();
    const title = course.title.toLowerCase();
    let score = -1;
    if (!text) score = 0;
    else if (code && subject === code[1] && number === code[2]) score = 0;
    else if (code && subject === code[1] && number.startsWith(code[2])) score = 1;
    else if (subject === text) score = 2;
    else if (title.startsWith(text)) score = 3;
    else if (tokens.length && tokens.every((token) => begins(course.words, token))) {
      const titleWords = title.split(/[^a-z0-9]+/);
      score = tokens.every((token) => begins(titleWords, token)) ? 4 : 5;
    }
    if (score >= 0) matches.push({ course, score });
  }
  return matches
    .sort((a, b) => a.score - b.score || a.course.subject.localeCompare(b.course.subject) || a.course.number.localeCompare(b.course.number))
    .slice(0, limit)
    .map((match) => match.course);
}

// ---- Formatting -------------------------------------------------------------

export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_LETTERS = ['M', 'Tu', 'W', 'Th', 'F', 'Sa', 'Su'];

export function formatTime(minutes) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const suffix = hour >= 12 ? 'pm' : 'am';
  const shown = hour % 12 === 0 ? 12 : hour % 12;
  return minute === 0 ? `${shown}${suffix}` : `${shown}:${String(minute).padStart(2, '0')}${suffix}`;
}

/** Banner writes "Lovelace, Ada"; show "Ada Lovelace". */
export function formatInstructor(name) {
  const [last, ...rest] = name.split(',').map((part) => part.trim());
  return rest.length ? `${rest.join(' ')} ${last}` : last;
}

/**
 * Who teaches a section, in words. `short` keeps it to one name for tight
 * spaces. Returns '' while the instructor hasn't been looked up yet.
 */
export function describeInstructors(section, { short = false } = {}) {
  if (!section.instructors.length) return section.instructorsKnown ? 'Instructor TBA' : '';
  const names = section.instructors.map(formatInstructor);
  if (!short) return names.join(', ');
  return names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0];
}

export function formatDays(days) {
  return days.map((day) => DAY_LETTERS[day]).join('');
}

export function formatMeetings(section) {
  if (section.meetings.length === 0) return 'No set time';
  // Merge meetings that share a time, e.g. Tue 11:45 + Thu 11:45 -> "TuTh 11:45am–1:25pm".
  const byTime = new Map();
  for (const meeting of section.meetings) {
    const key = `${meeting.start}-${meeting.end}`;
    if (!byTime.has(key)) byTime.set(key, { ...meeting, days: [] });
    byTime.get(key).days.push(...meeting.days);
  }
  return [...byTime.values()]
    .map((m) => `${formatDays([...new Set(m.days)].sort())} ${formatTime(m.start)}–${formatTime(m.end)}`)
    .join(', ');
}
