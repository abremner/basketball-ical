import fetch from 'node-fetch';
import fetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';
import * as path from 'path';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { DateTime } from 'luxon';
import ical, { ICalCalendar } from 'ical-generator';

interface Season {
  id: string;
  name: string;
}

interface Division {
  id: string;
  name: string;
}

interface Team {
  id: string;
  name: string;
}

interface FixtureMeta {
  seasonDir: string;
  division: string;
  team: string;
}
type Venue = {
  name: string;
  address?: string;
  lat?: string;
  lon?: string;
}

type VenueInfo = Record<string, Venue>

const venueLookup: VenueInfo = {
  WAV: { name: 'Waverley Basketball Stadium', lat: '-37.8769973', lon: '145.0992765' },
  LGS: { name: 'Lauriston Girls School', address: '38 Huntingtower Rd, Armadale VIC 3143' },
  ORC: { name: 'Oakleigh Recreation Centre', address: '2A Park Rd, Oakleigh VIC 3166' },
  ORR: { name: 'Orrong-Romanis Recreation Centre', address: '2 Molesworth St, Prahran VIC 3181' },
  APS: { name: 'Ashburton Primary School', address: '10 Fakenham Rd, Ashburton VIC 3147' },
};

const fetchWithCookies = fetchCookie(fetch, new CookieJar());
const REPO_NAME = 'basketball-ical';
const timezone = 'Australia/Melbourne';

const BASE_URL = 'https://www.waverleybasketball.com/fixtures.aspx';

function sanitizeFilename(str: string): string {
  return str.replace(/[<>:"/\\|?*]+/g, '').replace(/\s+/g, '_');
}

async function getInitialFormData(): Promise<{
  viewState: string;
  viewStateGen: string;
  eventValidation: string;
  seasons: Season[];
}> {
  const res = await fetchWithCookies(BASE_URL);
  const html = await res.text();
  const $ = cheerio.load(html);

const viewState = String($('#__VIEWSTATE').val() ?? '');
const viewStateGen = String($('#__VIEWSTATEGENERATOR').val() ?? '');
const eventValidation = String($('#__EVENTVALIDATION').val() ?? '');

  const seasons: Season[] = [];
  $('#season option').each((_, el) => {
    const id = $(el).attr('value');
    const name = $(el).text().trim();
    if (id && id !== '0') seasons.push({ id, name });
  });

  return { viewState, viewStateGen, eventValidation, seasons };
}

async function getDivisions(
  seasonId: string,
  formData: { viewState: string; viewStateGen: string; eventValidation: string }
): Promise<Division[]> {
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

  const divisions: Division[] = [];
  $('#grades option').each((_, el) => {
    const id = $(el).attr('value');
    const name = $(el).text().trim();
    if (id && id !== '0') divisions.push({ id, name });
  });

  return divisions;
}

async function getTeams(divisionId: string): Promise<Team[]> {
  const res = await fetchWithCookies(`${BASE_URL}?sgid2=${divisionId}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const teams: Team[] = [];
  $('#teams option').each((_, el) => {
    const id = $(el).attr('value');
    const name = $(el).text().trim();
    if (id && id !== '0' && name !== 'Select...') teams.push({ id, name });
  });

  return teams;
}

async function getFixtures(
  seasonDir: string,
  division: string,
  team: string,
  divisionId: string,
  teamId: string
): Promise<void> {
  const res = await fetchWithCookies(`${BASE_URL}?sgid2=${divisionId}&tid=${teamId}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const rows = $('table tr').toArray();
  const calendar: ICalCalendar = ical({
    name: `${team} Fixtures`,
    timezone,
  });

  for (let i = 1; i < rows.length; i++) {
    const tds = $(rows[i]).find('td');
    if (tds.length < 2) continue;

    const dateVenueHtml = tds.eq(0).html();
    if (!dateVenueHtml || !dateVenueHtml.includes('<br>')) continue;

    const [dateStr, venueTime] = dateVenueHtml.split('<br>');
    if (!venueTime || !dateStr) continue;

    const [venue, time] = venueTime.split(',').map(s => s.trim());
    const opponent = tds.eq(1).text().trim();

    if (opponent.toLowerCase() === 'bye') {
      console.log(`Skipping bye for ${team}`);
      continue;
    }

    const dt = DateTime.fromFormat(
      `${dateStr.trim()} ${time}`,
      'd LLL yyyy HH:mm',
      { zone: timezone }
    );

    if (!dt.isValid) {
      console.warn(`Skipping invalid date: ${dateStr} ${time} for ${team}`);
      continue;
    }

    const ageAndGender = seasonDir.match(/^[^(]+/)?.[0].trim() || '';
    const venueCode = venue.slice(0, 3);
    const court = venue.slice(3);
    const venueInfo: Venue | undefined = venueLookup[venueCode];

    calendar.createEvent({
      start: dt,
      end: dt.plus({ minutes: 45 }),
      summary: `🏀 ${ageAndGender}: ${team} vs ${opponent}`,
      description: `Venue: ${venueInfo ? venueInfo.name : venue}\nCourt: ${court}\nOpponent: ${opponent}\nArrive 15 mins early for warm-up`,
      location: {
        title: venueInfo ? venueInfo.name : venue,
        address: venueInfo?.address,
        geo: venueInfo?.lat && venueInfo?.lon ? { lat: parseFloat(venueInfo.lat), lon: parseFloat(venueInfo.lon) } : undefined,
      }
    });
  }

  const outputPath = path.join('public', sanitizeFilename(seasonDir), sanitizeFilename(division));
  mkdirSync(outputPath, { recursive: true });
  writeFileSync(path.join(outputPath, `${sanitizeFilename(team)}.ics`), calendar.toString());
}

(async () => {
  const { viewState, viewStateGen, eventValidation, seasons } = await getInitialFormData();

  // Collect fixture metadata for index
  const fixtures: FixtureMeta[] = [];

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
  const template = readFileSync('public/index_template.html', 'utf-8');
  const filled = template.replace('DATA_PLACEHOLDER', JSON.stringify(nested, null, 2));
  writeFileSync('public/index.html', filled);
})();

function buildNestedFixtureIndex(
  fixtures: FixtureMeta[]
): Record<string, Record<string, Record<string, string>>> {
  const nested: Record<string, Record<string, Record<string, string>>> = {};

  for (const { seasonDir, division, team } of fixtures) {
    if (!nested[seasonDir]) nested[seasonDir] = {};
    if (!nested[seasonDir][division]) nested[seasonDir][division] = {};

    const filepath = `${REPO_NAME}/${sanitizeFilename(seasonDir)}/${sanitizeFilename(division)}/${sanitizeFilename(team)}.ics`;
    nested[seasonDir][division][team] = filepath;
  }

  return nested;
}
