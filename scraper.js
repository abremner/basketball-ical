import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { CookieJar } from 'tough-cookie';
import fetchCookie from 'fetch-cookie';
import ical from 'ical-generator';
import { writeFileSync, mkdirSync, writeFile } from 'fs';
import path from 'path';

const fetchWithCookies = fetchCookie(fetch, new CookieJar());

const BASE_URL = 'https://www.waverleybasketball.com/fixtures.aspx';

function sanitizeFilename(str) {
  return str.replace(/[<>:"/\\|?*]+/g, '').replace(/\s+/g, '_');
}

async function getInitialFormData() {
  const res = await fetchWithCookies(BASE_URL);
  const html = await res.text();
  const $ = cheerio.load(html);

  const viewState = $('#__VIEWSTATE').val();
  const viewStateGen = $('#__VIEWSTATEGENERATOR').val();
  const eventValidation = $('#__EVENTVALIDATION').val();

  const seasons = [];
  $('#season option').each((_, el) => {
    const id = $(el).attr('value');
    const name = $(el).text().trim();
    if (id && id !== '0') seasons.push({ id, name });
  });

  return { viewState, viewStateGen, eventValidation, seasons };
}

async function getDivisions(seasonId, formData) {
  const body = new URLSearchParams({
    __VIEWSTATE: formData.viewState,
    __VIEWSTATEGENERATOR: formData.viewStateGen,
    __EVENTVALIDATION: formData.eventValidation,
    __EVENTTARGET: 'season',
    season: seasonId,
  });

  const res = await fetchWithCookies(BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  const html = await res.text();
  const $ = cheerio.load(html);

  const divisions = [];
  $('#grades option').each((_, el) => {
    const id = $(el).attr('value');
    const name = $(el).text().trim();
    if (id && id !== '0') divisions.push({ id, name });
  });

  return divisions;
}

async function getTeams(divisionId) {
  const res = await fetchWithCookies(`${BASE_URL}?sgid2=${divisionId}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const teams = [];
  $('#teams option').each((_, el) => {
    const id = $(el).attr('value');
    const name = $(el).text().trim();
    if (id && id !== '0' && name !== 'Select...') teams.push({ id, name });
  });

  return teams;
}

async function getFixtures(seasonDir, division, team, divisionId, teamId) {
  const res = await fetchWithCookies(`${BASE_URL}?sgid2=${divisionId}&tid=${teamId}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const rows = $('table tr').toArray();
  const calendar = ical({ name: `${team} Fixtures` });

  for (let i = 1; i < rows.length; i++) {
    const tds = $(rows[i]).find('td');
    if (tds.length < 2) continue;

    const dateVenueHtml = tds.eq(0).html();
    if (!dateVenueHtml || !dateVenueHtml.includes('<br>')) continue;

    const [dateStr, venueTime] = dateVenueHtml.split('<br>');
    if (!venueTime || !dateStr) continue;

    const [venue, time] = venueTime.split(',').map(s => s.trim());
    const opponent = tds.eq(1).text().trim();

    const startTime = new Date(`${dateStr.trim()} ${time}`);
    if (isNaN(startTime.getTime())) {
      console.warn(`Skipping invalid date: ${dateStr} ${time} for ${team} vs ${opponent}`);
      continue;
    }

    calendar.createEvent({
      start: startTime,
      end: new Date(startTime.getTime() + 60 * 60 * 1000),
      summary: `${team} vs ${opponent}`,
      location: venue,
    });
  }

  const outputPath = path.join('public', sanitizeFilename(seasonDir), sanitizeFilename(division));
  mkdirSync(outputPath, { recursive: true });
  writeFileSync(path.join(outputPath, `${sanitizeFilename(team)}.ics`), calendar.toString());
}

(async () => {
  const { viewState, viewStateGen, eventValidation, seasons } = await getInitialFormData();

  // Collect fixture metadata for index
  const fixtures = [];

  // Only process seasons that start with "U08", "U10", "U12", etc.
  const ageGroupPattern = /^U\d{2}/;

  for (const season of seasons) {
    if (!ageGroupPattern.test(season.name)) {
      console.log(`Skipping season "${season.name}" (does not start with age group)`);
      continue;
    }

    const seasonDir = season.name;

    const divisions = await getDivisions(season.id, { viewState, viewStateGen, eventValidation });

    for (const division of divisions) {
      const teams = await getTeams(division.id);
      for (const team of teams) {
        console.log(`Fetching: ${seasonDir} / ${division.name} / ${team.name}`);
        await getFixtures(seasonDir, division.name, team.name, division.id, team.id);

        // Collect for index
        fixtures.push({
          seasonDir,
          division: division.name,
          team: team.name,
        });
      }
    }
  }

  // Build and write index after all fixtures are processed
  const nested = buildNestedFixtureIndex(fixtures);
  await writeIndexFile(nested);
})();

function buildNestedFixtureIndex(fixtures) {
  const nested = {};
  for (const { seasonDir, division, team } of fixtures) {
    if (!nested[seasonDir]) nested[seasonDir] = {};
    if (!nested[seasonDir][division]) nested[seasonDir][division] = [];
    nested[seasonDir][division].push(team);
  }
  return nested;
}

async function writeIndexFile(nestedData) {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Waverley Basketball Fixtures</title>
  <style>
    body { font-family: sans-serif; padding: 2rem; background: #f9f9f9; }
    h1 { color: #333; }
    label, select { display: block; margin-top: 1rem; }
    #calendar-link { margin-top: 2rem; display: none; }
  </style>
</head>
<body>
  <h1>Waverley Basketball Fixture Calendars</h1>
  <p>Select your team to view or subscribe to their calendar:</p>

  <label for="season">Season:</label>
  <select id="season"><option value="">Select Season</option></select>

  <label for="ageGroup">Age Group:</label>
  <select id="ageGroup"><option value="">Select Age Group</option></select>

  <label for="division">Division:</label>
  <select id="division"><option value="">Select Division</option></select>

  <label for="team">Team:</label>
  <select id="team"><option value="">Select Team</option></select>

  <div id="calendar-link">
    <p><a id="icsLink" href="#" target="_blank">📅 View or Subscribe to Calendar</a></p>
  </div>

  <script>
    const data = ${JSON.stringify(nestedData, null, 2)};
    const seasonSelect = document.getElementById('season');
    const ageGroupSelect = document.getElementById('ageGroup');
    const divisionSelect = document.getElementById('division');
    const teamSelect = document.getElementById('team');
    const linkContainer = document.getElementById('calendar-link');
    const icsLink = document.getElementById('icsLink');

    function clearSelect(select) {
      select.innerHTML = '<option value="">Select</option>';
    }

    function populateSelect(select, options) {
      clearSelect(select);
      options.forEach(opt => {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        select.appendChild(o);
      });
    }

    seasonSelect.addEventListener('change', () => {
      clearSelect(ageGroupSelect);
      clearSelect(divisionSelect);
      clearSelect(teamSelect);
      linkContainer.style.display = 'none';
      const ageGroups = Object.keys(data[seasonSelect.value] || {});
      populateSelect(ageGroupSelect, ageGroups);
    });

    ageGroupSelect.addEventListener('change', () => {
      clearSelect(divisionSelect);
      clearSelect(teamSelect);
      linkContainer.style.display = 'none';
      const divisions = Object.keys(data[seasonSelect.value]?.[ageGroupSelect.value] || {});
      populateSelect(divisionSelect, divisions);
    });

    divisionSelect.addEventListener('change', () => {
      clearSelect(teamSelect);
      linkContainer.style.display = 'none';
      const teams = Object.keys(data[seasonSelect.value]?.[ageGroupSelect.value]?.[divisionSelect.value] || {});
      populateSelect(teamSelect, teams);
    });

    teamSelect.addEventListener('change', () => {
      const season = seasonSelect.value;
      const age = ageGroupSelect.value;
      const div = divisionSelect.value;
      const team = teamSelect.value;
      const link = data[season]?.[age]?.[div]?.[team];
      if (link) {
        icsLink.href = link;
        icsLink.textContent = \`📅 \${team} Calendar\`;
        linkContainer.style.display = 'block';
      } else {
        linkContainer.style.display = 'none';
      }
    });

    window.onload = () => {
      const seasons = Object.keys(data);
      populateSelect(seasonSelect, seasons);
    };
  </script>
</body>
</html>
`;
  writeFile('public/index.html', html);
}
