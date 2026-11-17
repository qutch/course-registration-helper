import {
  DAY_NAMES,
  NO_CAMPUS,
  NUPATHS,
  SORTS,
  buildCourseIndex,
  buildOptions,
  describeInstructors,
  diagnose,
  formatMeetings,
  formatTime,
  generateSchedules,
  isOnline,
  rankSchedules,
  rejectionReason,
  searchCourses,
} from './scheduler.js';

const STORE_KEY = 'course-scheduler:v1';
const HUES = [215, 150, 28, 280, 345, 185, 95, 320, 50, 245];
const SNAP = 15; // minutes; busy blocks snap to this
const DEFAULT_PREFS = {
  campus: 'Boston',
  includeOnline: false,
  includeHonors: false,
  openOnly: false,
  earliest: null,
  latest: null,
  daysOff: [],
  sort: 'balanced',
};
const REASON_LABELS = {
  removed: 'Unchecked',
  online: 'Online',
  honors: 'Honors',
  full: 'Full',
  early: 'Too early',
  late: 'Too late',
  dayOff: 'On a free day',
  busy: 'During busy time',
};

const $ = (id) => document.getElementById(id);

/** Small DOM builder: el('div', { class: 'x', onclick: fn }, child, 'text'). */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else if (name === 'style') node.style.cssText = value;
    else if (value === true) node.setAttribute(name, '');
    else node.setAttribute(name, value);
  }
  node.append(...children.flat().filter((child) => child != null && child !== false));
  return node;
}

// ---- State ------------------------------------------------------------------

const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) ?? {};
  } catch {
    return {};
  }
})();

const state = {
  terms: [],
  term: saved.term ?? null,
  prefs: { ...DEFAULT_PREFS, ...saved.prefs },
  plans: saved.plans ?? {}, // per term, the classes being worked on: { courses, excluded, locked, picks, busy }
  savedPlans: saved.savedPlans ?? {}, // per term: [{ id, name, savedAt, sections: [{ courseKey, crn }] }]
  renaming: null, // id of the saved plan whose name is being edited
  byCrn: new Map(),
  catalog: null,
  index: new Map(),
  coreqs: new Map(), // "term:course key" -> [{ subject, number, title }]
  expanded: new Set(),
  built: [],
  ranked: [],
  truncated: false,
  position: 0,
};

function plan() {
  const existing = state.plans[state.term];
  if (existing) return existing;
  return (state.plans[state.term] = { courses: [], excluded: [], locked: {}, picks: {}, busy: [] });
}

function save() {
  localStorage.setItem(
    STORE_KEY,
    JSON.stringify({ term: state.term, prefs: state.prefs, plans: state.plans, savedPlans: state.savedPlans }),
  );
}

const hueFor = (courseKey) => HUES[Math.max(0, plan().courses.indexOf(courseKey)) % HUES.length];

/** The section to show for an option: the student's pick, else the one with the most seats. */
function shownSection(option) {
  const picked = plan().picks[`${option.courseKey}|${option.key}`];
  return option.sections.find((section) => section.crn === picked) ?? option.sections[0];
}

// ---- Talking to the server --------------------------------------------------

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'Something went wrong.');
  return body;
}

let loadToken = 0;

async function loadCatalog({ refresh = false } = {}) {
  const token = ++loadToken;
  const term = state.term;
  const termName = state.terms.find((t) => t.code === term)?.description ?? 'this term';
  state.catalog = null;
  $('workspace').hidden = true;
  $('loading').hidden = false;
  $('retry').hidden = true;
  $('loadingTitle').textContent = `Getting the ${termName.replace(/\s*\(.*\)$/, '')} class list…`;
  $('loadingDetail').textContent = 'This takes about a minute the first time. After that it’s instant.';
  $('progressBar').style.width = '2%';
  renderSidebar();

  try {
    let first = refresh;
    for (;;) {
      const result = await api(`/api/catalog?term=${term}${first ? '&refresh=1' : ''}`);
      first = false;
      if (token !== loadToken) return;
      if (result.status === 'ready') {
        state.catalog = result;
        break;
      }
      if (result.status === 'error') throw new Error(result.message);
      if (result.total) {
        $('progressBar').style.width = `${Math.max(2, (100 * result.loaded) / result.total)}%`;
        $('loadingDetail').textContent = `${result.loaded.toLocaleString()} of ${result.total.toLocaleString()} sections`;
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
  } catch (error) {
    if (token !== loadToken) return;
    $('loadingTitle').textContent = 'Couldn’t get the class list';
    $('loadingDetail').textContent = 'Northeastern’s class search didn’t respond. Check your connection and try again.';
    $('retry').hidden = false;
    console.error(error);
    return;
  }

  $('loading').hidden = true;
  $('workspace').hidden = false;
  rebuildIndex();
  normalisePrefs();
  recompute();
  // The saved list can be hours old, so re-check seats for the chosen classes
  // and for everything in a saved plan.
  if (!refresh) {
    const tracked = new Set([...plan().courses, ...savedPlans().flatMap((p) => p.sections.map((s) => s.courseKey))]);
    refreshSeats([...tracked]);
  }
  for (const key of plan().courses) loadCoreqs(key);
}

function rebuildIndex() {
  state.index = buildCourseIndex(state.catalog.sections, state.catalog.subjects);
  state.byCrn = new Map(state.catalog.sections.map((section) => [section.crn, section]));
}

async function refreshSeats(courseKeys) {
  const term = state.term;
  const courses = courseKeys.filter((key) => state.index.has(key)).map((key) => {
    const { subject, number } = state.index.get(key);
    return { subject, number };
  });
  // The server takes at most 15 classes per request.
  for (let start = 0; start < courses.length; start += 15) {
    if (term !== state.term) return;
    await refreshBatch(term, courses.slice(start, start + 15));
  }
}

async function refreshBatch(term, courses) {
  try {
    const result = await api('/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term, courses }),
    });
    if (term !== state.term || !state.catalog) return;
    for (const course of result.courses) {
      if (course.sections.length === 0) continue; // keep what we have rather than blanking a course
      state.catalog.sections = state.catalog.sections
        .filter((section) => !(section.subject === course.subject && section.number === course.number))
        .concat(course.sections);
    }
    rebuildIndex();
    recompute();
  } catch (error) {
    console.warn('Could not refresh seat counts:', error.message);
  }
}

async function loadCoreqs(courseKey) {
  const cacheKey = `${state.term}:${courseKey}`;
  const course = state.index.get(courseKey);
  if (!course || state.coreqs.has(cacheKey)) return;
  state.coreqs.set(cacheKey, []);
  const sample = course.sections.find((section) => section.campus === state.prefs.campus) ?? course.sections[0];
  try {
    const { coreqs } = await api(`/api/coreqs?term=${state.term}&crn=${sample.crn}`);
    state.coreqs.set(cacheKey, coreqs);
    renderSidebar();
  } catch (error) {
    state.coreqs.delete(cacheKey);
    console.warn('Could not look up corequisites:', error.message);
  }
}

// ---- Working out the schedules ----------------------------------------------

function schedulerPrefs() {
  return { ...state.prefs, busy: plan().busy };
}

/**
 * Rebuild the list of schedules. With `stay`, keep showing the same schedule
 * if it still fits (used when locking a section or when seat counts refresh);
 * otherwise go back to the best one.
 */
function recompute(stay = true) {
  if (!state.catalog) return;
  const current = stay ? state.ranked[state.position] : null;
  const signature = (schedule) => schedule.map((option) => `${option.courseKey}|${option.key}`).join('#');
  const before = current ? signature(current.schedule) : null;

  const prefs = schedulerPrefs();
  const excluded = new Set(plan().excluded);
  state.built = plan()
    .courses.filter((key) => state.index.has(key))
    .map((key) => buildOptions(state.index.get(key), prefs, { excluded, locked: plan().locked[key] }));

  const { schedules, truncated } = generateSchedules(state.built.map((course) => course.options));
  state.ranked = rankSchedules(schedules, state.prefs.sort);
  state.truncated = truncated;
  const same = before ? state.ranked.findIndex((entry) => signature(entry.schedule) === before) : -1;
  state.position = same >= 0 ? same : 0;
  render();
}

function update(change, stay = false) {
  change();
  save();
  recompute(stay);
}

// ---- Actions ----------------------------------------------------------------

function addCourse(key) {
  if (plan().courses.includes(key)) return;
  update(() => plan().courses.push(key));
  refreshSeats([key]);
  loadCoreqs(key);
}

function removeCourse(key) {
  update(() => {
    const p = plan();
    p.courses = p.courses.filter((other) => other !== key);
    delete p.locked[key];
    state.expanded.delete(key);
  });
}

function toggleLock(courseKey, crn) {
  update(() => {
    const p = plan();
    if (p.locked[courseKey] === crn) delete p.locked[courseKey];
    else p.locked[courseKey] = crn;
  }, true);
}

function toggleSection(crn, include) {
  update(() => {
    const p = plan();
    p.excluded = p.excluded.filter((other) => other !== crn);
    if (!include) p.excluded.push(crn);
  });
}

function addBusy(day, start, end) {
  update(() => {
    // Merge with anything it touches so blocks never stack.
    const p = plan();
    const merged = { day, start, end };
    p.busy = p.busy.filter((block) => {
      const touches = block.day === day && block.start <= merged.end && merged.start <= block.end;
      if (touches) {
        merged.start = Math.min(merged.start, block.start);
        merged.end = Math.max(merged.end, block.end);
      }
      return !touches;
    });
    p.busy.push(merged);
  });
}

function removeBusy(block) {
  update(() => {
    plan().busy = plan().busy.filter((other) => other !== block);
  });
}

function go(delta) {
  if (state.ranked.length === 0) return;
  state.position = (state.position + delta + state.ranked.length) % state.ranked.length;
  renderMain();
}

/** Show a short message. `action` ({ label, run }) adds a button such as Undo. */
function toast(message, action) {
  const node = $('toast');
  const hide = () => (node.hidden = true);
  node.replaceChildren(el('span', {}, message));
  if (action) {
    node.append(el('button', {
      class: 'toast-action', type: 'button',
      onclick: () => {
        hide();
        action.run();
      },
    }, action.label));
  }
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(hide, action ? 6000 : 2200);
}

async function copyText(crns) {
  try {
    await navigator.clipboard.writeText(crns);
    toast(`Copied ${crns}`);
  } catch {
    toast(`CRNs: ${crns}`);
  }
}

// ---- Saved plans ------------------------------------------------------------
// A saved plan is one exact schedule: a CRN for each class. Opening it locks
// every class to its saved section, so it shows up on the calendar as-is.

function savedPlans() {
  return (state.savedPlans[state.term] ??= []);
}

/** The schedule on screen, as { courseKey, crn } pairs, or null if there isn't one. */
function currentSelection() {
  const entry = state.ranked[state.position];
  return entry ? entry.schedule.map((option) => ({ courseKey: option.courseKey, crn: shownSection(option).crn })) : null;
}

const selectionKey = (sections) => sections.map((s) => s.crn).sort().join(',');

function savedMatchingScreen() {
  const current = currentSelection();
  if (!current) return null;
  const key = selectionKey(current);
  return savedPlans().find((saved) => selectionKey(saved.sections) === key) ?? null;
}

function nextPlanName() {
  const taken = new Set(savedPlans().map((saved) => saved.name.toLowerCase()));
  for (let i = 0; i < 26; i++) {
    const name = `Plan ${String.fromCharCode(65 + i)}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
  return `Plan ${savedPlans().length + 1}`;
}

function savePlan(name) {
  const sections = currentSelection();
  if (!sections) return;
  const finalName = name.trim().slice(0, 40) || nextPlanName();
  savedPlans().push({
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    name: finalName,
    savedAt: Date.now(),
    sections,
  });
  save();
  closeSaveForm();
  render();
  toast(`Saved ${finalName}`);
}

function openPlan(saved) {
  const before = structuredClone(plan());
  update(() => {
    const p = plan();
    p.courses = saved.sections.map((s) => s.courseKey);
    p.locked = Object.fromEntries(saved.sections.map((s) => [s.courseKey, s.crn]));
    p.excluded = p.excluded.filter((crn) => !saved.sections.some((s) => s.crn === crn));
    state.expanded.clear();
  });
  for (const s of saved.sections) loadCoreqs(s.courseKey);
  toast(`Opened ${saved.name}`, {
    label: 'Undo',
    run: () => update(() => (state.plans[state.term] = before)),
  });
}

function deletePlan(saved) {
  const list = savedPlans();
  const index = list.indexOf(saved);
  if (index < 0) return;
  list.splice(index, 1);
  save();
  render();
  toast(`Deleted ${saved.name}`, {
    label: 'Undo',
    run: () => {
      savedPlans().splice(Math.min(index, savedPlans().length), 0, saved);
      save();
      render();
    },
  });
}

function renamePlan(saved, name) {
  state.renaming = null;
  const trimmed = name.trim().slice(0, 40);
  if (trimmed) saved.name = trimmed;
  save();
  renderSaved();
}

/** Credits, and anything that has gone wrong since the plan was saved. */
function planStatus(saved) {
  let credits = 0;
  const issues = [];
  for (const { courseKey, crn } of saved.sections) {
    const section = state.byCrn.get(crn);
    if (!section) {
      issues.push(`${courseKey} section ${crn} is no longer listed`);
      continue;
    }
    credits += section.credits || 0;
    if (section.seats <= 0) {
      issues.push(section.waitSeats > 0 ? `${courseKey} is full (waitlist open)` : `${courseKey} is full`);
    }
  }
  return { credits, issues };
}

function openSaveForm() {
  $('savePlan').hidden = true;
  $('saveForm').hidden = false;
  $('planName').value = nextPlanName();
  $('planName').focus();
  $('planName').select();
}

function closeSaveForm() {
  $('saveForm').hidden = true;
  $('savePlan').hidden = false;
}

function renderSavedPlan(saved, onScreen) {
  const { credits, issues } = planStatus(saved);
  const renaming = state.renaming === saved.id;
  const date = new Date(saved.savedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const crns = saved.sections.map((s) => s.crn).join(', ');

  const name = renaming
    ? el('input', {
      class: 'rename', type: 'text', value: saved.name, maxlength: 40, 'aria-label': 'Plan name',
      onkeydown: (event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          state.renaming = null;
          renderSaved();
        }
      },
      onblur: (event) => {
        if (state.renaming === saved.id) renamePlan(saved, event.currentTarget.value);
      },
    })
    : el('strong', { class: 'saved-name' }, saved.name);

  return el('div', { class: `saved${onScreen ? ' on-screen' : ''}` },
    el('div', { class: 'saved-head' },
      name,
      onScreen && el('span', { class: 'tag' }, 'On screen'),
    ),
    el('div', { class: 'muted small' },
      [credits && `${credits} credits`, `${saved.sections.length} ${saved.sections.length === 1 ? 'class' : 'classes'}`, `saved ${date}`]
        .filter(Boolean).join(' · ')),
    el('div', { class: 'small saved-courses' }, saved.sections.map((s) => s.courseKey).join(', ')),
    issues.length
      ? el('ul', { class: 'saved-issues small' }, issues.map((issue) => el('li', {}, issue)))
      : el('div', { class: 'saved-ok small' }, 'Every section has open seats'),
    el('div', { class: 'saved-actions' },
      !onScreen && el('button', { class: 'link', type: 'button', onclick: () => openPlan(saved) }, 'Open'),
      el('button', { class: 'link', type: 'button', onclick: () => copyText(crns) }, 'Copy CRNs'),
      el('button', {
        class: 'link', type: 'button',
        onclick: () => {
          state.renaming = saved.id;
          renderSaved();
        },
      }, 'Rename'),
      el('button', { class: 'link danger', type: 'button', onclick: () => deletePlan(saved) }, 'Delete'),
    ),
  );
}

function renderSaved() {
  const list = savedPlans();
  const match = savedMatchingScreen();
  $('savedPanel').hidden = false;
  $('savedCount').textContent = list.length ? String(list.length) : '';
  $('saved').replaceChildren(
    ...(list.length
      ? list.map((saved) => renderSavedPlan(saved, saved === match))
      : [el('p', { class: 'muted small' }, 'Save a schedule you like to come back to it later, or to keep backups in case a class fills up.')]),
  );

  // The toolbar button says when the schedule on screen is already saved.
  $('savePlan').textContent = match ? `Saved as ${match.name}` : 'Save plan';
  $('savePlan').disabled = Boolean(match);
  if (match && !$('saveForm').hidden) closeSaveForm();

  const input = $('saved').querySelector('.rename');
  if (input && document.activeElement !== input) {
    input.focus();
    input.select();
  }
}

// ---- Rendering: sidebar -----------------------------------------------------

function normalisePrefs() {
  const counts = new Map();
  for (const section of state.catalog.sections) {
    if (section.campus === 'Online' || section.campus === NO_CAMPUS || !section.campus) continue;
    counts.set(section.campus, (counts.get(section.campus) ?? 0) + 1);
  }
  const campuses = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  if (state.prefs.campus !== 'any' && !counts.has(state.prefs.campus)) state.prefs.campus = campuses[0] ?? 'any';
  $('campus').replaceChildren(
    ...campuses.map((name) => el('option', { value: name }, name)),
    el('option', { value: 'any' }, 'Any campus'),
  );
  $('campus').value = state.prefs.campus;
}

function setUpControls() {
  const hourOptions = (from, to) => [
    el('option', { value: '' }, 'Any time'),
    ...Array.from({ length: to - from + 1 }, (_, i) => el('option', { value: (from + i) * 60 }, formatTime((from + i) * 60))),
  ];
  $('earliest').replaceChildren(...hourOptions(8, 14));
  $('latest').replaceChildren(...hourOptions(12, 21));
  $('earliest').value = state.prefs.earliest ?? '';
  $('latest').value = state.prefs.latest ?? '';
  $('sort').replaceChildren(...Object.entries(SORTS).map(([key, sort]) => el('option', { value: key }, sort.label)));
  $('sort').value = state.prefs.sort;

  for (const id of ['openOnly', 'includeOnline', 'includeHonors']) {
    $(id).checked = state.prefs[id];
    $(id).addEventListener('change', () => update(() => (state.prefs[id] = $(id).checked)));
  }
  $('campus').addEventListener('change', () => update(() => (state.prefs.campus = $('campus').value)));
  $('sort').addEventListener('change', () => update(() => (state.prefs.sort = $('sort').value)));
  for (const id of ['earliest', 'latest']) {
    $(id).addEventListener('change', () => update(() => (state.prefs[id] = $(id).value === '' ? null : Number($(id).value))));
  }

  $('daysOff').replaceChildren(
    ...DAY_NAMES.slice(0, 5).map((name, day) =>
      el('button', {
        type: 'button',
        class: 'chip',
        'data-day': day,
        'aria-pressed': String(state.prefs.daysOff.includes(day)),
        onclick: (event) => {
          update(() => {
            const off = state.prefs.daysOff;
            state.prefs.daysOff = off.includes(day) ? off.filter((d) => d !== day) : [...off, day];
          });
          event.currentTarget.setAttribute('aria-pressed', String(state.prefs.daysOff.includes(day)));
        },
      }, name),
    ),
  );

  $('prev').addEventListener('click', () => go(-1));
  $('next').addEventListener('click', () => go(1));
  $('copy').addEventListener('click', copyCrns);
  $('savePlan').addEventListener('click', openSaveForm);
  $('cancelSave').addEventListener('click', closeSaveForm);
  $('saveForm').addEventListener('submit', (event) => {
    event.preventDefault();
    savePlan($('planName').value);
  });
  $('planName').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSaveForm();
  });
  $('retry').addEventListener('click', () => loadCatalog());
  $('refresh').addEventListener('click', () => loadCatalog({ refresh: true }));
  $('clearBusy').addEventListener('click', () => update(() => (plan().busy = [])));
  $('term').addEventListener('change', () => {
    state.term = $('term').value;
    state.ranked = [];
    state.expanded.clear();
    state.renaming = null;
    closeSaveForm();
    save();
    loadCatalog();
  });
  document.addEventListener('keydown', (event) => {
    if (event.target.closest('input, select, textarea')) return;
    if (event.key === 'ArrowLeft') go(-1);
    if (event.key === 'ArrowRight') go(1);
  });
}

function seatText(section) {
  if (section.seats > 0) return `${section.seats} ${section.seats === 1 ? 'seat' : 'seats'}`;
  return section.waitSeats > 0 ? `Full, ${section.waitSeats} on waitlist open` : 'Full';
}

function sectionLine(section) {
  const parts = [formatMeetings(section)];
  if (isOnline(section) && section.meetings.length) parts.push('online');
  return parts.join(' · ');
}

function renderCourse(key) {
  const course = state.index.get(key);
  const hue = `--h: ${hueFor(key)}`;
  const remove = el('button', {
    class: 'remove', type: 'button', 'aria-label': `Remove ${key}`, title: 'Remove', onclick: () => removeCourse(key),
  }, '×');

  if (!course) {
    return el('div', { class: 'course', style: hue },
      el('div', { class: 'course-head' }, el('span', { class: 'dot' }), el('div', { class: 'course-name' }, el('strong', {}, key)), remove),
      el('div', { class: 'course-meta warn-text' }, 'Not offered this term'),
    );
  }

  const built = state.built.find((entry) => entry.courseKey === key);
  const fitting = built ? built.options.reduce((sum, option) => sum + option.sections.length, 0) : 0;
  const prefs = schedulerPrefs();
  const excluded = new Set(plan().excluded);
  const lockedCrn = plan().locked[key];
  const lockedSection = lockedCrn && course.sections.find((section) => section.crn === lockedCrn);
  const open = state.expanded.has(key);

  // Sections at other campuses aren't worth listing; just count them.
  const listed = [];
  let elsewhere = 0;
  for (const section of course.sections) {
    const reason = rejectionReason(section, prefs, excluded);
    if (reason === 'campus') elsewhere++;
    else listed.push({ section, reason });
  }
  listed.sort((a, b) => a.section.section.localeCompare(b.section.section));

  const meta = [];
  if (course.credits) meta.push(`${course.credits} credits`);
  if (lockedSection) meta.push(`Locked to section ${lockedSection.section}`);
  else if (listed.length === 0) meta.push(`Not offered at ${state.prefs.campus}`);
  else meta.push(`${fitting} of ${listed.length} ${listed.length === 1 ? 'section fits' : 'sections fit'}`);

  const coreqs = (state.coreqs.get(`${state.term}:${key}`) ?? [])
    .map((coreq) => `${coreq.subject} ${coreq.number}`)
    .filter((coreqKey) => state.index.has(coreqKey) && !plan().courses.includes(coreqKey));

  return el('div', { class: `course${fitting === 0 ? ' stuck' : ''}`, style: hue },
    el('div', { class: 'course-head' },
      el('span', { class: 'dot' }),
      el('button', {
        class: 'course-name', type: 'button', 'aria-expanded': String(open),
        title: open ? 'Hide sections' : 'Show sections',
        onclick: () => {
          if (open) state.expanded.delete(key);
          else state.expanded.add(key);
          renderSidebar();
        },
      }, el('strong', {}, key), el('span', {}, course.title)),
      remove,
    ),
    el('div', { class: `course-meta${fitting === 0 ? ' warn-text' : ''}` },
      meta.join(' · '),
      lockedSection && el('button', { class: 'link', type: 'button', onclick: () => toggleLock(key, lockedCrn) }, 'Unlock'),
    ),
    coreqs.length > 0 && el('div', { class: 'coreqs' },
      el('span', { class: 'muted' }, 'Goes with'),
      coreqs.map((coreqKey) =>
        el('button', { class: 'chip add', type: 'button', title: state.index.get(coreqKey).title, onclick: () => addCourse(coreqKey) }, `+ ${coreqKey}`),
      ),
    ),
    open && el('ul', { class: 'sections' },
      listed.map(({ section, reason }) => {
        const blocked = reason && reason !== 'removed';
        return el('li', { class: blocked ? 'blocked' : '' },
          el('label', {},
            el('input', {
              type: 'checkbox',
              checked: !excluded.has(section.crn),
              onchange: (event) => toggleSection(section.crn, event.currentTarget.checked),
            }),
            el('span', { class: 'sec-num' }, section.section),
            el('span', { class: 'sec-info' },
              sectionLine(section),
              describeInstructors(section) && el('span', { class: 'sec-prof' }, describeInstructors(section)),
              el('span', { class: 'sec-seats' }, blocked ? REASON_LABELS[reason] : seatText(section)),
            ),
          ),
        );
      }),
      elsewhere > 0 && el('li', { class: 'muted note' }, `${elsewhere} more at other campuses`),
    ),
  );
}

function renderSidebar() {
  const ready = Boolean(state.catalog);
  $('search').disabled = !ready;
  $('nupath').disabled = !ready;
  const courses = plan().courses;
  if (!ready) {
    $('savedPanel').hidden = true;
    $('courses').replaceChildren(el('p', { class: 'muted small' }, 'Loading…'));
    $('credits').textContent = '';
    return;
  }
  $('courses').replaceChildren(
    ...(courses.length ? courses.map(renderCourse) : [el('p', { class: 'muted small' }, 'Nothing yet. Search above to add one.')]),
  );
  const credits = courses.reduce((sum, key) => sum + (state.index.get(key)?.credits ?? 0), 0);
  $('credits').textContent = credits ? `${credits} credits` : '';

  const minutes = Math.round((Date.now() - state.catalog.fetchedAt) / 60000);
  const age = minutes < 2 ? 'just now' : minutes < 90 ? `${minutes} min ago` : minutes < 2880 ? `${Math.round(minutes / 60)} hours ago` : `${Math.round(minutes / 1440)} days ago`;
  $('freshness').textContent = `Class list updated ${age}`;
}

// ---- Rendering: main area ---------------------------------------------------

function formatDuration(minutes) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return [hours && `${hours}h`, (rest || !hours) && `${rest}m`].filter(Boolean).join(' ');
}

function formatDate(yyyymmdd) {
  const text = String(yyyymmdd);
  return new Date(Number(text.slice(0, 4)), Number(text.slice(4, 6)) - 1, Number(text.slice(6))).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

function describeProblem(problem) {
  const bold = (text) => el('strong', {}, text);
  if (problem.kind === 'noSections') {
    const { rejected, total } = problem;
    const phrases = {
      campus: (n) => `${n} at another campus`,
      online: (n) => `${n} online`,
      honors: (n) => `${n} honors only`,
      full: (n) => `${n} full`,
      early: (n) => `${n} too early`,
      late: (n) => `${n} too late`,
      dayOff: (n) => `${n} on a day you’re keeping free`,
      busy: (n) => `${n} during your busy time`,
      removed: (n) => `${n} you unchecked`,
    };
    if (problem.lockedOut) {
      const clash = { early: 'starts too early', late: 'ends too late', dayOff: 'is on a day you’re keeping free', busy: 'is during your busy time' };
      return el('li', {}, 'The section of ', bold(problem.courseKey), ` you locked in ${clash[Object.keys(rejected)[0]]}.`,
        el('button', { class: 'link', type: 'button', onclick: () => toggleLock(problem.courseKey, plan().locked[problem.courseKey]) }, 'Unlock it'));
    }
    const why = Object.entries(rejected).map(([reason, count]) => phrases[reason](count));
    if (rejected.campus === total) return el('li', {}, bold(problem.courseKey), ` isn’t offered at ${state.prefs.campus} this term.`);
    return el('li', {}, 'No section of ', bold(problem.courseKey), ' works with your preferences', why.length ? ` (${why.join(', ')}).` : '.');
  }
  if (problem.kind === 'pair') {
    return el('li', {}, bold(problem.courseKeys[0]), ' and ', bold(problem.courseKeys[1]), ' always overlap. Every section of one clashes with every section of the other.');
  }
  if (problem.kind === 'dropOne') {
    return el('li', {}, 'They can’t all fit at once. It works if you drop any one of: ', problem.courseKeys.join(', '), '.');
  }
  return el('li', {}, 'There’s no way to fit all of these at once. Try removing a class or loosening a preference.');
}

function calendarBounds() {
  let first = 8 * 60;
  let last = 18 * 60;
  let weekend = false;
  const consider = (start, end, days) => {
    first = Math.min(first, start);
    last = Math.max(last, end);
    if (days.some((day) => day > 4)) weekend = true;
  };
  for (const course of state.built) {
    for (const option of course.options) for (const m of option.meetings) consider(m.start, m.end, m.days);
  }
  for (const block of plan().busy) consider(block.start, block.end, [block.day]);
  return { startHour: Math.floor(first / 60), endHour: Math.ceil(last / 60), dayCount: weekend ? 7 : 5 };
}

let bounds = { startHour: 8, endHour: 18, dayCount: 5 };

function renderCalendar(entry) {
  bounds = calendarBounds();
  const { startHour, endHour, dayCount } = bounds;
  const base = startHour * 60;
  const place = (start, end) => `top: calc(${(start - base) / 60} * var(--hour)); height: calc(${(end - start) / 60} * var(--hour));`;

  const columns = Array.from({ length: dayCount }, () => []);
  for (const option of entry?.schedule ?? []) {
    const section = shownSection(option);
    const locked = plan().locked[option.courseKey] === section.crn;
    for (const meeting of option.meetings) {
      for (const day of meeting.days) columns[day]?.push({ option, section, meeting, locked });
    }
  }

  const head = el('div', { class: 'cal-head' }, el('div', {}), DAY_NAMES.slice(0, dayCount).map((name, day) =>
    el('div', { class: `cal-day${state.prefs.daysOff.includes(day) ? ' off' : ''}` }, name),
  ));
  const times = el('div', { class: 'cal-times' },
    Array.from({ length: endHour - startHour }, (_, i) =>
      el('div', { class: 'cal-time', style: `top: calc(${i} * var(--hour))` }, formatTime((startHour + i) * 60)),
    ),
  );

  const body = el('div', { class: 'cal-body', style: `--hours: ${endHour - startHour}` }, times,
    columns.map((items, day) => {
      // Classes in one schedule only overlap when they run in different parts
      // of the term; show those side by side.
      items.sort((a, b) => a.meeting.start - b.meeting.start);
      const lanes = [];
      for (const item of items) {
        let lane = lanes.findIndex((end) => end <= item.meeting.start);
        if (lane < 0) lane = lanes.length;
        lanes[lane] = item.meeting.end;
        item.lane = lane;
      }
      const width = 100 / Math.max(1, lanes.length);

      return el('div', { class: `cal-col${state.prefs.daysOff.includes(day) ? ' off' : ''}`, 'data-day': day },
        plan().busy.filter((block) => block.day === day).map((block) =>
          el('button', {
            class: 'busy', type: 'button', style: place(block.start, block.end),
            title: 'Click to remove', 'aria-label': `Busy ${DAY_NAMES[day]} ${formatTime(block.start)} to ${formatTime(block.end)}. Click to remove.`,
            onclick: () => removeBusy(block),
          }, el('span', {}, 'Busy'), el('span', { class: 'busy-x' }, '×')),
        ),
        items.map(({ option, section, meeting, locked, lane }) => {
          const partial = meeting.startDate !== meeting.endDate && meeting.endDate - meeting.startDate < 300; // under ~3 months
          const once = meeting.startDate === meeting.endDate;
          const dates = once ? formatDate(meeting.startDate) : partial ? `${formatDate(meeting.startDate)} – ${formatDate(meeting.endDate)}` : '';
          return el('button', {
            class: `block${locked ? ' locked' : ''}${once ? ' once' : ''}${section.seats <= 0 ? ' full' : ''}`,
            type: 'button',
            style: `--h: ${hueFor(option.courseKey)}; ${place(meeting.start, meeting.end)} left: ${lane * width}%; width: ${width}%;`,
            title: locked ? 'Locked in. Click to unlock.' : 'Click to lock this section in',
            'aria-pressed': String(locked),
            onclick: () => toggleLock(option.courseKey, section.crn),
          },
            el('span', { class: 'block-title' }, option.courseKey, locked && el('span', { class: 'lock' }, 'Locked')),
            section.instructors.length > 0 && el('span', { class: 'block-prof' }, describeInstructors(section, { short: true })),
            el('span', { class: 'block-time' }, `${formatTime(meeting.start)}–${formatTime(meeting.end)}`),
            el('span', { class: 'block-where' }, [dates, meeting.where].filter(Boolean).join(' · ')),
          );
        }),
      );
    }),
  );
  $('calendar').style.setProperty('--days', dayCount);
  $('calendar').replaceChildren(head, body);
}

function renderDetails(entry) {
  if (!entry) return $('details').replaceChildren();
  $('details').replaceChildren(
    ...entry.schedule.map((option) => {
      const section = shownSection(option);
      const course = state.index.get(option.courseKey);
      const locked = plan().locked[option.courseKey] === section.crn;
      const where = [...new Set(section.meetings.map((m) => m.where).filter(Boolean))].join(', ');
      const facts = [formatMeetings(section), where || (isOnline(section) ? 'Online' : '')].filter(Boolean);
      const professor = describeInstructors(section);

      const chooser = option.sections.length > 1
        ? el('select', {
          'aria-label': `Section of ${option.courseKey}`,
          title: `${option.sections.length} sections meet at this time`,
          onchange: (event) => update(() => {
            const crn = event.currentTarget.value;
            plan().picks[`${option.courseKey}|${option.key}`] = crn;
            if (plan().locked[option.courseKey]) plan().locked[option.courseKey] = crn;
          }, true),
        }, option.sections.map((other) =>
          el('option', { value: other.crn, selected: other.crn === section.crn },
            [`Section ${other.section}`, describeInstructors(other, { short: true }), seatText(other)].filter(Boolean).join(' · ')),
        ))
        : el('span', {}, `Section ${section.section}`);

      return el('div', { class: 'row', style: `--h: ${hueFor(option.courseKey)}` },
        el('span', { class: 'dot' }),
        el('div', { class: 'row-main' },
          el('div', {}, el('strong', {}, option.courseKey), ' ', course?.title ?? section.title),
          el('div', { class: 'small' },
            professor && el('span', { class: `row-prof${section.instructors.length ? '' : ' tba'}` }, professor),
            el('span', { class: 'muted' }, `${professor ? ' · ' : ''}${facts.join(' · ')}`),
          ),
        ),
        el('div', { class: 'row-section' }, chooser),
        el('div', { class: 'row-crn' }, el('span', { class: 'muted small' }, 'CRN'), ' ', el('code', {}, section.crn)),
        el('div', { class: `seats${section.seats <= 0 ? ' none' : section.seats <= 5 ? ' few' : ''}` },
          section.seats > 0 ? `${section.seats} of ${section.capacity} open` : seatText(section)),
        el('button', {
          class: `button quiet lock-button${locked ? ' on' : ''}`, type: 'button', 'aria-pressed': String(locked),
          onclick: () => toggleLock(option.courseKey, section.crn),
        }, locked ? 'Locked' : 'Lock'),
      );
    }),
  );
}

function renderMain() {
  if (!state.catalog) return;
  const courses = plan().courses.filter((key) => state.index.has(key));
  const entry = state.ranked[state.position];
  const stuck = courses.length > 0 && !entry;

  $('empty').hidden = courses.length > 0;
  $('problem').hidden = !stuck;
  $('toolbar').hidden = !entry;
  $('summary').hidden = !entry;

  if (stuck) {
    $('problemList').replaceChildren(...diagnose(state.built).map(describeProblem));
    $('clearBusy').hidden = plan().busy.length === 0;
  }

  if (entry) {
    const count = state.ranked.length;
    $('position').textContent = count === 1
      ? 'The only schedule that fits'
      : `Schedule ${(state.position + 1).toLocaleString()} of ${count.toLocaleString()}${state.truncated ? '+' : ''}`;
    $('prev').disabled = $('next').disabled = count === 1;

    const m = entry.metrics;
    const credits = entry.schedule.reduce((sum, option) => sum + (shownSection(option).credits || 0), 0);
    const parts = [`${credits} credits`];
    if (m.days) {
      parts.push(`${m.days} ${m.days === 1 ? 'day' : 'days'} a week`, `${formatTime(m.earliest)} to ${formatTime(m.latest)}`);
      parts.push(m.gaps ? `${formatDuration(m.gaps)} between classes each week` : 'no gaps between classes');
    }
    const untimed = entry.schedule.filter((option) => option.meetings.length === 0).map((option) => option.courseKey);
    const full = entry.schedule.filter((option) => shownSection(option).seats <= 0).map((option) => option.courseKey);
    $('summary').replaceChildren(
      ...[
        parts.join(' · '),
        untimed.length > 0 && el('span', { class: 'tag' }, `No set time: ${untimed.join(', ')}`),
        full.length > 0 && el('span', { class: 'tag warn' }, `Full: ${full.join(', ')}`),
      ].filter(Boolean),
    );
  }
  renderCalendar(entry);
  renderDetails(entry);
  renderSaved();
}

function render() {
  renderSidebar();
  renderMain();
}

function copyCrns() {
  const current = currentSelection();
  if (current) copyText(current.map((s) => s.crn).join(', '));
}

// ---- Search box -------------------------------------------------------------

function setUpSearch() {
  const input = $('search');
  const list = $('results');
  const filter = $('nupath');
  let matches = [];
  let active = 0;

  filter.replaceChildren(
    el('option', { value: '' }, 'Any'),
    ...NUPATHS.map((path) => el('option', { value: path.code }, `${path.name} (${path.code})`)),
  );

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
  };
  const choose = (course) => {
    if (!course) return;
    addCourse(course.key);
    input.value = '';
    close();
  };
  const show = () => {
    const nupath = filter.value || null;
    // With a NUPath chosen there may be dozens of matches worth scrolling through.
    matches = searchCourses(state.index, input.value, { nupath, limit: nupath ? 200 : 12 });
    active = 0;
    if (!input.value.trim() && !nupath) return close();
    const chosen = new Set(plan().courses);
    list.replaceChildren(
      ...(matches.length
        ? matches.map((course, index) => {
          const here = course.sections.filter((s) => !rejectionReason(s, { ...DEFAULT_PREFS, campus: state.prefs.campus, includeHonors: true, busy: [] })).length;
          const status = chosen.has(course.key) ? 'Added' : here ? `${here} ${here === 1 ? 'section' : 'sections'}` : `Not at ${state.prefs.campus}`;
          const note = course.nupath.length ? `${course.nupath.join(' ')} · ${status}` : status;
          return el('li', {
            role: 'option', class: `${index === active ? 'active' : ''}${here ? '' : ' dim'}`, 'aria-selected': String(index === active),
            onmousedown: (event) => {
              event.preventDefault();
              choose(course);
            },
          }, el('strong', {}, course.key), el('span', { class: 'result-title' }, course.title), el('span', { class: 'muted small' }, note));
        })
        : [el('li', { class: 'none muted' }, nupath
          ? `No ${NUPATHS.find((path) => path.code === nupath).name} classes match. Try fewer words, or pick “Any” NUPath.`
          : 'No classes match. Try a code like “CS 3000” or a word from the title.')]),
    );
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };
  const highlight = () => {
    [...list.children].forEach((item, index) => {
      item.classList.toggle('active', index === active);
      item.setAttribute('aria-selected', String(index === active));
      if (index === active) item.scrollIntoView({ block: 'nearest' });
    });
  };

  filter.addEventListener('change', () => {
    input.focus();
    show();
  });
  input.addEventListener('input', show);
  input.addEventListener('focus', show);
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!matches.length) return;
      event.preventDefault();
      active = (active + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
      highlight();
    } else if (event.key === 'Enter') {
      choose(matches[active]);
    } else if (event.key === 'Escape') {
      close();
    }
  });
}

// ---- Dragging on the calendar to mark busy time ------------------------------

function setUpBusyDrag() {
  const calendar = $('calendar');
  let drag = null;

  const minuteAt = (column, clientY) => {
    const box = column.getBoundingClientRect();
    const span = (bounds.endHour - bounds.startHour) * 60;
    const raw = bounds.startHour * 60 + ((clientY - box.top) / box.height) * span;
    const snapped = Math.round(raw / SNAP) * SNAP;
    return Math.min(bounds.endHour * 60, Math.max(bounds.startHour * 60, snapped));
  };
  const drawGhost = () => {
    const start = Math.min(drag.from, drag.to);
    const end = Math.max(drag.from, drag.to);
    const base = bounds.startHour * 60;
    drag.ghost.style.top = `calc(${(start - base) / 60} * var(--hour))`;
    drag.ghost.style.height = `calc(${(end - start) / 60} * var(--hour))`;
    drag.ghost.textContent = end > start ? `${formatTime(start)}–${formatTime(end)}` : '';
  };

  calendar.addEventListener('pointerdown', (event) => {
    const column = event.target;
    if (!column.classList?.contains('cal-col') || event.button !== 0) return;
    event.preventDefault();
    const minute = minuteAt(column, event.clientY);
    drag = { column, from: minute, to: minute, ghost: el('div', { class: 'busy ghost' }) };
    column.append(drag.ghost);
    column.setPointerCapture(event.pointerId);
    drawGhost();
  });
  calendar.addEventListener('pointermove', (event) => {
    if (!drag) return;
    drag.to = minuteAt(drag.column, event.clientY);
    drawGhost();
  });
  const finish = (event) => {
    if (!drag) return;
    const { column, from, to, ghost } = drag;
    drag = null;
    ghost.remove();
    if (event.type === 'pointercancel') return;
    const start = Math.min(from, to);
    const end = Math.max(from, to);
    if (end - start >= SNAP) addBusy(Number(column.dataset.day), start, end);
  };
  calendar.addEventListener('pointerup', finish);
  calendar.addEventListener('pointercancel', finish);
}

// ---- Start ------------------------------------------------------------------

async function start() {
  setUpControls();
  setUpSearch();
  setUpBusyDrag();
  $('loading').hidden = false;
  $('loadingTitle').textContent = 'Starting up…';
  try {
    const { terms } = await api('/api/terms');
    state.terms = terms.slice(0, 12);
  } catch (error) {
    $('loadingTitle').textContent = 'Couldn’t reach Northeastern’s class search';
    $('loadingDetail').textContent = 'Check your connection, then reload this page.';
    console.error(error);
    return;
  }
  if (!state.terms.some((term) => term.code === state.term)) {
    state.term = (state.terms.find((term) => !/view only/i.test(term.description)) ?? state.terms[0]).code;
  }
  $('term').replaceChildren(...state.terms.map((term) => el('option', { value: term.code }, term.description)));
  $('term').value = state.term;
  loadCatalog();
}

start();
