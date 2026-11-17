import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, instructorNames, parseCorequisites, parseDate, parseTime, slimSection } from '../lib/banner.js';

test('parses Banner times and dates', () => {
  assert.equal(parseTime('0950'), 590);
  assert.equal(parseTime(null), null);
  assert.equal(parseDate('01/13/2027'), 20270113);
  assert.equal(parseDate(null), null);
});

test('decodes HTML entities in titles', () => {
  assert.equal(decodeEntities('Fin Acctng &amp; Reporting'), 'Fin Acctng & Reporting');
  assert.equal(decodeEntities('Women&#39;s Studies'), "Women's Studies");
});

test('slims a Banner section down to scheduler fields', () => {
  const day = (on) => ({
    monday: false, tuesday: on, wednesday: false, thursday: false, friday: on, saturday: false, sunday: false,
  });
  const raw = {
    courseReferenceNumber: '31308',
    subject: 'CS',
    courseNumber: '3000',
    courseTitle: 'Algorithms &amp; Data',
    sequenceNumber: '02',
    campusDescription: 'Boston',
    scheduleTypeDescription: 'Lecture',
    instructionalMethodDescription: 'Traditional',
    creditHours: null,
    creditHourLow: 4,
    seatsAvailable: 74,
    maximumEnrollment: 75,
    waitAvailable: 0,
    waitCapacity: 0,
    faculty: [{ displayName: 'Lovelace, Ada' }],
    sectionAttributes: [
      { code: 'GNHN', description: 'Honors' },
      { code: 'NCFQ', description: ' NUpath Formal/Quant Reasoning' },
      { code: 'NCM2', description: ' NU Core Math/Anly Think Lvl 2' }, // old NU Core, not NUPath
      { code: 'NCAD', description: ' NUpath Analyzing/Using Data' },
      { code: 'NCW1', description: ' NU Core/NUpath 1st Yr Writing' },
    ],
    meetingsFaculty: [
      {
        meetingTime: {
          ...day(true), beginTime: '0950', endTime: '1130', buildingDescription: 'Shillman Hall', room: '420',
          startDate: '01/13/2027', endDate: '05/02/2027',
        },
      },
      // Online/TBA rows carry no time and should be dropped.
      { meetingTime: { ...day(false), beginTime: null, endTime: null, startDate: '01/13/2027', endDate: '05/02/2027' } },
    ],
  };
  assert.deepEqual(slimSection(raw), {
    crn: '31308',
    subject: 'CS',
    number: '3000',
    title: 'Algorithms & Data',
    section: '02',
    campus: 'Boston',
    type: 'Lecture',
    method: 'Traditional',
    credits: 4,
    seats: 74,
    capacity: 75,
    waitSeats: 0,
    waitCapacity: 0,
    honors: true,
    nupath: ['FQ', 'AD', 'WF'],
    instructors: ['Lovelace, Ada'],
    meetings: [{ days: [1, 4], start: 590, end: 690, where: 'Shillman Hall 420', startDate: 20270113, endDate: 20270502 }],
  });
});

test('lists instructors once each, primary first', () => {
  const result = {
    fmt: [
      { faculty: [{ displayName: 'Hopper, Grace', primaryIndicator: false }, { displayName: 'Lovelace, Ada', primaryIndicator: true }] },
      { faculty: [{ displayName: 'Lovelace, Ada', primaryIndicator: true }] },
    ],
  };
  assert.deepEqual(instructorNames(result), ['Lovelace, Ada', 'Hopper, Grace']);
  assert.deepEqual(instructorNames({ fmt: [{ faculty: [] }] }), []);
});

test('reads corequisites out of the HTML table', () => {
  const html = `
    <section aria-labelledby="coReqs"><h3>Corequisites</h3>
      <table class="basePreqTable"><thead><tr><th>Subject</th><th>Course Number</th><th>Title</th></tr></thead>
      <tbody><tr><td>Computer Science</td><td>3001</td><td>Recitation for CS 3000</td></tr></tbody></table>
    </section>
    <section aria-labelledby="linked">No linked course information available.</section>`;
  assert.deepEqual(parseCorequisites(html), [
    { subjectDescription: 'Computer Science', number: '3001', title: 'Recitation for CS 3000' },
  ]);
  assert.deepEqual(parseCorequisites('<section aria-labelledby="coReqs">No corequisite information available.</section>'), []);
});
