import { parseMovieFilename } from './filename-parser.js';

const movies = [
  { title: 'Amber Coast', year: 2004 },
  { title: 'Quiet Planet', year: 1998 },
  { title: 'Paper Moonlight', year: 2011 },
  { title: 'Winter Signal', year: 2020 },
  { title: 'Velvet Circuit', year: 1986 },
  { title: 'Golden Orchard', year: 1977 },
  { title: 'Midnight Archive', year: 2007 },
  { title: 'River of Glass', year: 2015 },
  { title: 'Northbound', year: 1993 },
  { title: 'Solar Meridian', year: 2023 },
];

const filenameFormats = [
  ({ title, year }: (typeof movies)[number]) => `${title} (${year}).mkv`,
  ({ title, year }: (typeof movies)[number]) =>
    `${title.replaceAll(' ', '.')}.${year}.1080p.WEB-DL.x265-GROUP.mkv`,
  ({ title, year }: (typeof movies)[number]) =>
    `${title} ${year} [BluRay 1080p].mp4`,
  ({ title, year }: (typeof movies)[number]) =>
    `${title.replaceAll(' ', '_')}_${year}_720p_WEBRip_x264.avi`,
  ({ title, year }: (typeof movies)[number]) =>
    `${title} - ${year} - 2160p HEVC.mkv`,
];

const filenameCases = movies.flatMap((movie) =>
  filenameFormats.map((format) => ({
    filename: format(movie),
    ...movie,
  })),
);

describe('parseMovieFilename', () => {
  it.each(filenameCases)('parses $filename', ({ filename, title, year }) => {
    expect(parseMovieFilename(filename)).toEqual({
      title,
      year,
      extension: filename.match(/\.([^.]+)$/)?.[1]?.toLowerCase(),
      reviewReason: null,
    });
  });

  it('prefers a parenthesized release year over a year in the title', () => {
    expect(parseMovieFilename('Blade Runner 2049 (1982).mkv')).toEqual({
      title: 'Blade Runner 2049',
      year: 1982,
      extension: 'mkv',
      reviewReason: null,
    });
  });

  it('does not treat a future year-like title number as a release year', () => {
    expect(parseMovieFilename('Blade Runner 2049.mkv')).toEqual({
      title: 'Blade Runner 2049',
      year: null,
      extension: 'mkv',
      reviewReason: 'missing_year',
    });
  });

  it('marks conflicting years for review instead of guessing', () => {
    expect(parseMovieFilename('Amber Coast 1980 1981.mkv')).toEqual({
      title: 'Amber Coast',
      year: null,
      extension: 'mkv',
      reviewReason: 'ambiguous_year',
    });
  });

  it('extracts names from Windows paths and normalizes separators', () => {
    expect(
      parseMovieFilename('C:\\Movies\\Incoming\\Amber.Coast_2004.mkv'),
    ).toMatchObject({
      title: 'Amber Coast',
      year: 2004,
      extension: 'mkv',
    });
  });

  it('returns null when the filename contains no title', () => {
    expect(parseMovieFilename(' (2004).mkv')).toBeNull();
    expect(parseMovieFilename('   ')).toBeNull();
  });

  it('returns a reviewable title when the year is missing', () => {
    expect(parseMovieFilename('Amber Coast 1080p WEB-DL.mkv')).toEqual({
      title: 'Amber Coast',
      year: null,
      extension: 'mkv',
      reviewReason: 'missing_year',
    });
  });
});
