import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeInstructors,
  formatInstructor,
  buildCourseIndex,
  buildOptions,
  diagnose,
  formatMeetings,
  formatTime,
  generateSchedules,
  measure,
  meetingsOverlap,
  rankSchedules,
  rejectionReason,
  searchCourses,
} from '../public/scheduler.js';

const TERM = { startDate: 20270113, endDate: 20270502 };
const meeting = (days, start, end, dates = TERM) => ({ days, start, end, where: '', ...dates });

let nextCrn = 10000;
function section(subject, number, meetings, extra = {}) {
  return {
    crn: String(nextCrn++),
    subject,
    number,
    title: `${subject} ${number} title`,
    section: '01',
    campus: 'Boston',
    type: 'Lecture',
    method: 'Traditional',
    credits: 4,
    seats: 10,
    capacity: 30,
    waitSeats: 0,
    waitCapacity: 0,
    honors: false,
    instructors: [],
    meetings,
    ...extra,
  };
}

const PREFS = {
  campus: 'Boston',
  includeOnline: true,
  includeHonors: false,
  openOnly: false,
  earliest: null,
  latest: null,
  daysOff: [],
  busy: [],
};

const course = (key, sections) => ({ key, sections });
const optionsFor = (courses, prefs = PREFS) => courses.map((c) => buildOptions(c, prefs).options);

test('meetings overlap only when day, time and dates all intersect', () => {
  const a = meeting([0, 3], 570, 635);
  assert.equal(meetingsOverlap(a, meeting([3], 600, 700)), true);
  assert.equal(meetingsOverlap(a, meeting([1], 600, 700)), false, 'different day');
  assert.equal(meetingsOverlap(a, meeting([0], 635, 700)), false, 'back-to-back is fine');
  const firstHalf = meeting([0], 570, 635, { startDate: 20270113, endDate: 20270227 });
  const secondHalf = meeting([0], 570, 635, { startDate: 20270315, endDate: 20270502 });
  assert.equal(meetingsOverlap(firstHalf, secondHalf), false, 'different halves of the term');
});

test('finds every non-overlapping combination', () => {
  const a = course('A 1', [section('A', '1', [meeting([0], 540, 600)]), section('A', '1', [meeting([0], 660, 720)])]);
  const b = course('B 1', [section('B', '1', [meeting([0], 570, 630)]), section('B', '1', [meeting([1], 540, 600)])]);
  const { schedules, truncated } = generateSchedules(optionsFor([a, b]));
  assert.equal(truncated, false);
  // A@9 clashes with B@9:30, leaving 3 of the 4 combinations.
  assert.equal(schedules.length, 3);
  for (const schedule of schedules) {
    assert.equal(schedule[0].courseKey, 'A 1');
    assert.equal(schedule[1].courseKey, 'B 1');
  }
});

test('sections at the same time collapse into one option', () => {
  const same = [meeting([0, 2], 540, 600)];
  const a = course('A 1', [
    section('A', '1', same, { seats: 0, section: '01' }),
    section('A', '1', same, { seats: 5, section: '02' }),
    section('A', '1', [meeting([1], 540, 600)], { section: '03' }),
  ]);
  const { options } = buildOptions(a, PREFS);
  assert.equal(options.length, 2);
  const shared = options.find((option) => option.sections.length === 2);
  assert.equal(shared.sections[0].section, '02', 'the section with open seats is shown first');
});

test('sections with no meeting time never conflict', () => {
  const a = course('A 1', [section('A', '1', [], { campus: 'Online', method: 'Online' })]);
  const b = course('B 1', [section('B', '1', [meeting([0], 540, 600)])]);
  assert.equal(generateSchedules(optionsFor([a, b])).schedules.length, 1);
});

test('stops at the limit and says so', () => {
  const many = (key) =>
    course(key, Array.from({ length: 5 }, (_, i) => section(key, '1', [meeting([i], 540, 600)])));
  // Three courses on five distinct days each: 5 * 4 * 3 = 60 schedules.
  const all = generateSchedules(optionsFor([many('A'), many('B'), many('C')]));
  assert.equal(all.schedules.length, 60);
  const capped = generateSchedules(optionsFor([many('A'), many('B'), many('C')]), 10);
  assert.equal(capped.schedules.length, 10);
  assert.equal(capped.truncated, true);
});

test('preferences rule sections out, with a reason', () => {
  const morning = section('A', '1', [meeting([0], 480, 545)]);
  assert.equal(rejectionReason(morning, PREFS), null);
  assert.equal(rejectionReason(morning, { ...PREFS, earliest: 540 }), 'early');
  assert.equal(rejectionReason(morning, { ...PREFS, latest: 500 }), 'late');
  assert.equal(rejectionReason(morning, { ...PREFS, daysOff: [0] }), 'dayOff');
  assert.equal(rejectionReason(morning, { ...PREFS, busy: [{ day: 0, start: 500, end: 520 }] }), 'busy');
  assert.equal(rejectionReason(morning, { ...PREFS, busy: [{ day: 1, start: 500, end: 520 }] }), null);
  assert.equal(rejectionReason(morning, PREFS, new Set([morning.crn])), 'removed');
  assert.equal(rejectionReason(section('A', '1', [], { campus: 'Seattle, WA' }), PREFS), 'campus');
  assert.equal(rejectionReason(section('A', '1', [], { campus: 'Seattle, WA' }), { ...PREFS, campus: 'any' }), null);
  assert.equal(rejectionReason(section('A', '1', [], { campus: 'Online' }), PREFS), null);
  assert.equal(rejectionReason(section('A', '1', [], { campus: 'Online' }), { ...PREFS, includeOnline: false }), 'online');
  assert.equal(rejectionReason(section('A', '1', [], { campus: 'No campus, no room needed' }), PREFS), null);
  assert.equal(rejectionReason(section('A', '1', [], { honors: true }), PREFS), 'honors');
  assert.equal(rejectionReason(section('A', '1', [], { seats: 0 }), { ...PREFS, openOnly: true }), 'full');
});

test('a locked section is the only option, even one that is full or unchecked', () => {
  const full = section('A', '1', [meeting([0], 480, 545)], { seats: 0 });
  const other = section('A', '1', [meeting([0], 780, 845)]);
  const prefs = { ...PREFS, openOnly: true };
  const built = buildOptions(course('A 1', [full, other]), prefs, { locked: full.crn, excluded: new Set([full.crn]) });
  assert.equal(built.options.length, 1);
  assert.equal(built.options[0].sections[0].crn, full.crn);
  assert.equal(built.lockedOut, false);
});

test('a locked section still has to stay out of busy time', () => {
  const locked = section('A', '1', [meeting([0], 480, 545)]);
  const other = section('A', '1', [meeting([0], 780, 845)]);
  const prefs = { ...PREFS, busy: [{ day: 0, start: 480, end: 540 }] };
  const built = buildOptions(course('A 1', [locked, other]), prefs, { locked: locked.crn });
  assert.equal(built.options.length, 0);
  assert.equal(built.lockedOut, true);
  assert.deepEqual(built.rejected, { busy: 1 });
});

test('measure reports days, span and idle time', () => {
  const a = course('A 1', [section('A', '1', [meeting([0, 2], 540, 600)])]);
  const b = course('B 1', [section('B', '1', [meeting([0], 690, 750)])]);
  const [schedule] = generateSchedules(optionsFor([a, b])).schedules;
  const metrics = measure(schedule);
  assert.equal(metrics.days, 2);
  assert.equal(metrics.earliest, 540);
  assert.equal(metrics.latest, 750);
  assert.equal(metrics.gaps, 90);
});

test('ranking follows the chosen priority', () => {
  const a = course('A 1', [section('A', '1', [meeting([0], 480, 540)]), section('A', '1', [meeting([0], 720, 780)])]);
  const b = course('B 1', [section('B', '1', [meeting([0], 840, 900)])]);
  const { schedules } = generateSchedules(optionsFor([a, b]));
  assert.equal(rankSchedules(schedules, 'lateStart')[0].metrics.earliest, 720);
  assert.equal(rankSchedules(schedules, 'compact')[0].metrics.gaps, 60);
});

test('schedules that need a full section rank last', () => {
  const a = course('A 1', [
    section('A', '1', [meeting([0], 540, 600)], { seats: 0 }),
    section('A', '1', [meeting([0], 480, 540)], { seats: 3 }),
  ]);
  const b = course('B 1', [section('B', '1', [meeting([0], 600, 660)])]);
  const ranked = rankSchedules(generateSchedules(optionsFor([a, b])).schedules, 'lateStart');
  assert.equal(ranked[0].metrics.fullOptions, 0);
  assert.equal(ranked[1].metrics.fullOptions, 1);
});

test('diagnose names the course with no usable sections', () => {
  const a = course('A 1', [section('A', '1', [meeting([0], 480, 540)])]);
  const b = course('B 1', [section('B', '1', [meeting([1], 600, 660)])]);
  const built = [a, b].map((c) => buildOptions(c, { ...PREFS, earliest: 540 }));
  assert.deepEqual(diagnose(built), [
    { kind: 'noSections', courseKey: 'A 1', rejected: { early: 1 }, total: 1, lockedOut: false },
  ]);
});

test('diagnose names two courses that always overlap', () => {
  const a = course('A 1', [section('A', '1', [meeting([0], 540, 600)])]);
  const b = course('B 1', [section('B', '1', [meeting([0], 570, 630)])]);
  const c = course('C 1', [section('C', '1', [meeting([2], 570, 630)])]);
  const built = [a, b, c].map((x) => buildOptions(x, PREFS));
  assert.deepEqual(diagnose(built), [{ kind: 'pair', courseKeys: ['A 1', 'B 1'] }]);
});

test('diagnose suggests what to drop when no single pair is to blame', () => {
  // Each course has the same two slots; any two fit, all three cannot.
  const slots = () => [meeting([0], 540, 600), meeting([0], 660, 720)];
  const make = (key) => course(key, slots().map((m) => section(key, '1', [m])));
  const built = ['A', 'B', 'C'].map((key) => buildOptions(make(key), PREFS));
  assert.deepEqual(diagnose(built), [{ kind: 'dropOne', courseKeys: ['A', 'B', 'C'] }]);
});

test('course search understands codes and titles', () => {
  const sections = [
    section('CS', '3000', [], { title: 'Algorithms and Data' }),
    section('CS', '3001', [], { title: 'Recitation for CS 3000' }),
    section('CS', '5800', [], { title: 'Algorithms' }),
    section('CHEM', '2311', [], { title: 'Organic Chemistry 1' }),
  ];
  const index = buildCourseIndex(sections, { CS: 'Computer Science', CHEM: 'Chemistry' });
  const keys = (query) => searchCourses(index, query).map((c) => c.key);
  assert.equal(keys('cs 3000')[0], 'CS 3000');
  assert.equal(keys('CS3000')[0], 'CS 3000');
  assert.deepEqual(keys('cs 30'), ['CS 3000', 'CS 3001']);
  assert.deepEqual(keys('algorithms'), ['CS 3000', 'CS 5800']);
  assert.deepEqual(keys('data'), ['CS 3000'], 'matches a word anywhere in the title');
  assert.deepEqual(keys('organic chem'), ['CHEM 2311']);
  assert.deepEqual(keys('computer science'), ['CS 3000', 'CS 3001', 'CS 5800']);
  assert.deepEqual(keys('zzz'), []);
});

test('course search can be narrowed to a NUPath', () => {
  const sections = [
    section('PHIL', '1145', [], { title: 'Technology and Human Values', nupath: ['ER', 'SI'] }),
    section('PHIL', '1145', [], { title: 'Technology and Human Values', nupath: ['ER'] }),
    section('PHIL', '1101', [], { title: 'Introduction to Philosophy', nupath: ['IC'] }),
    section('MATH', '1341', [], { title: 'Calculus 1', nupath: ['FQ'] }),
    section('CS', '3000', [], { title: 'Algorithms and Data' }),
  ];
  const index = buildCourseIndex(sections);
  assert.deepEqual(index.get('PHIL 1145').nupath, ['SI', 'ER'], 'a course has every NUPath any of its sections has, in the official order');
  assert.deepEqual(index.get('CS 3000').nupath, []);
  const keys = (query, nupath) => searchCourses(index, query, { nupath }).map((c) => c.key);
  assert.deepEqual(keys('phil', 'ER'), ['PHIL 1145']);
  assert.deepEqual(keys('phil', null), ['PHIL 1101', 'PHIL 1145']);
  assert.deepEqual(keys('', 'SI'), ['PHIL 1145'], 'an empty search lists everything with that NUPath');
  assert.deepEqual(keys('', null), [], 'an empty search with no NUPath shows nothing');
  assert.deepEqual(keys('calc', 'ER'), []);
});

test('NUPath search can show more than the usual handful', () => {
  const sections = Array.from({ length: 30 }, (_, i) => section('PHIL', String(1000 + i), [], { nupath: ['ER'] }));
  const index = buildCourseIndex(sections);
  assert.equal(searchCourses(index, '', { nupath: 'ER', limit: 100 }).length, 30);
  assert.equal(searchCourses(index, 'phil').length, 12);
});

test('the course index picks the most common title', () => {
  const sections = [
    section('ACCT', '1201', [], { title: 'Fin Acctng & Reporting' }),
    section('ACCT', '1201', [], { title: 'Financial Accounting and Reporting' }),
    section('ACCT', '1201', [], { title: 'Financial Accounting and Reporting' }),
  ];
  assert.equal(buildCourseIndex(sections).get('ACCT 1201').title, 'Financial Accounting and Reporting');
});

test('instructor names are shown first name first', () => {
  assert.equal(formatInstructor('Lovelace, Ada'), 'Ada Lovelace');
  assert.equal(formatInstructor('Staff'), 'Staff');
  const two = section('A', '1', [], { instructors: ['Lovelace, Ada', 'Hopper, Grace'], instructorsKnown: true });
  assert.equal(describeInstructors(two), 'Ada Lovelace, Grace Hopper');
  assert.equal(describeInstructors(two, { short: true }), 'Ada Lovelace +1');
  assert.equal(describeInstructors(section('A', '1', [], { instructorsKnown: true })), 'Instructor TBA');
  assert.equal(describeInstructors(section('A', '1', [])), '', 'not looked up yet');
});

test('times and meeting summaries read naturally', () => {
  assert.equal(formatTime(590), '9:50am');
  assert.equal(formatTime(720), '12pm');
  assert.equal(formatTime(0), '12am');
  const split = section('A', '1', [meeting([1], 705, 805), meeting([3], 890, 990)]);
  assert.equal(formatMeetings(split), 'Tu 11:45am–1:25pm, Th 2:50pm–4:30pm');
  const together = section('A', '1', [meeting([1], 590, 690), meeting([4], 590, 690)]);
  assert.equal(formatMeetings(together), 'TuF 9:50am–11:30am');
  assert.equal(formatMeetings(section('A', '1', [])), 'No set time');
});
