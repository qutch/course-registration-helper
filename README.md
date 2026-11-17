# Course Scheduler

Pick the classes you want at Northeastern and see every way they fit together, best first.

## Run it

```sh
npm start
```

Then open <http://localhost:4747>. Needs Node 20 or newer; there is nothing to install.

The first time you open a term, the app downloads that term's full class list (about a minute). After that it loads instantly from `.cache/`. Press **Update** to download it again; seat counts and instructors for the classes you've picked are re-checked every time the page loads.

## Use it

- **Add classes** by code (`CS 3000`) or by words in the title (`organic chem`). If a class has a corequisite, a "Goes with" button adds it.
- **Find classes by NUPath** with the menu under the search box. Pick one and leave the box empty to see every class that fulfills it, or type to narrow the list. Results show each class's NUPath codes.
- **Flip through schedules** with the arrows or the left/right keys. "Show first" changes what counts as best.
- **Drag on the calendar** to block off time you're busy. Click a busy block to remove it.
- **Click a class** on the calendar to lock that section in; the other classes rearrange around it.
- **Open a class** in the sidebar to see who teaches each section and uncheck the ones you don't want.
- **Save plan** keeps the schedule on screen under a name (Plan A, Plan B…), so you can line up backups in case a class fills up. Saved plans in the sidebar show if any section has filled or disappeared since; **Open** puts one back on the calendar.
- **Copy CRNs** gives you the list to paste into registration.

Your classes and preferences are saved in the browser, separately for each term.

## How it works

- `server.js` serves the page and relays requests to Banner, which browsers can't call directly.
- `lib/banner.js` talks to Banner's class search ([unofficial API notes](https://jennydaman.gitlab.io/nubanned/)).
- `public/scheduler.js` filters sections, finds every non-overlapping combination and ranks them.
- `public/app.js` is the page itself.

Run the tests with `npm test`.

## Limits

- Sections that meet at the same time are shown as one schedule, with a menu to choose between them.
- At most 20,000 schedules are generated; past that the count shows a `+`.
- The app can't tell whether you meet a class's prerequisites or restrictions. Registration will.
