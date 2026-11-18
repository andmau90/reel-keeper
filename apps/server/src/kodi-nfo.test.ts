import { XMLParser } from 'fast-xml-parser';
import {
  applyKodiNfoEdits,
  mergeKodiNfo,
  readKodiNfo,
  type KodiNfoMetadata,
} from './kodi-nfo.js';

const metadata: KodiNfoMetadata = {
  tmdbId: 123,
  title: 'The New Title',
  originalTitle: 'A New Title',
  year: 2020,
  releaseDate: '2020-03-04',
  plot: 'A new plot.',
  tagline: 'A tagline',
  runtime: 115,
  genres: ['Drama', 'Mystery'],
  studios: ['Example Studio'],
  directors: ['A Director'],
  actors: [{ name: 'An Actor', character: 'The Lead' }],
  voteAverage: 7.8,
  voteCount: 840,
};

const parser = new XMLParser({
  attributeNamePrefix: '@_',
  ignoreAttributes: false,
  isArray: (tagName) =>
    ['actor', 'director', 'genre', 'studio', 'uniqueid'].includes(tagName),
  parseTagValue: false,
});

describe('mergeKodiNfo', () => {
  it('updates TMDB fields and preserves unknown XML fields and attributes', () => {
    const result = mergeKodiNfo(
      `<movie custom="keep">
        <title>Old title</title>
        <sorttitle>My custom sort</sorttitle>
        <uniqueid type="imdb">tt123</uniqueid>
        <customnode flag="yes"><value>Keep this</value></customnode>
      </movie>`,
      metadata,
    );
    const movie = (parser.parse(result) as { movie: Record<string, unknown> })
      .movie;

    expect(movie).toMatchObject({
      '@_custom': 'keep',
      title: 'The New Title',
      sorttitle: 'My custom sort',
      genre: ['Drama', 'Mystery'],
      studio: ['Example Studio'],
      director: ['A Director'],
      actor: [{ name: 'An Actor', role: 'The Lead' }],
    });
    expect(result).toContain('<customnode flag="yes">');
    expect(result).toContain('<value>Keep this</value>');
    expect(result).toContain('<uniqueid type="imdb">tt123</uniqueid>');
    expect(result).toContain(
      '<uniqueid type="tmdb" default="true">123</uniqueid>',
    );
  });

  it('leaves locked values unchanged while updating unlocked fields', () => {
    const result = mergeKodiNfo(
      '<movie><title>My title</title><plot>My plot</plot><genre>Local genre</genre></movie>',
      metadata,
      ['title', 'genres'],
    );
    const movie = (parser.parse(result) as { movie: Record<string, unknown> })
      .movie;

    expect(movie['title']).toBe('My title');
    expect(movie['plot']).toBe('A new plot.');
    expect(movie['genre']).toEqual(['Local genre']);
  });

  it('creates valid NFO XML and rejects malformed existing XML', () => {
    const result = mergeKodiNfo(null, {
      ...metadata,
      title: 'Tom & Jerry',
    });

    expect(result).toContain('<title>Tom &amp; Jerry</title>');
    expect(() =>
      mergeKodiNfo('<movie><title>broken</movie>', metadata),
    ).toThrow('invalid XML');
    expect(() => mergeKodiNfo('<notmovie />', metadata)).toThrow(
      '<movie> root element',
    );
  });
});

describe('manual Kodi NFO metadata', () => {
  it('reads supported fields and the TMDB identifier from an NFO', () => {
    expect(
      readKodiNfo(
        `<movie>
          <title>My title</title>
          <originaltitle>Original</originaltitle>
          <year>2004</year>
          <plot>Story</plot>
          <genre>Drama</genre>
          <genre>Mystery</genre>
          <actor><name>Actor One</name><role>Lead</role></actor>
          <uniqueid type="tmdb" default="true">33</uniqueid>
        </movie>`,
      ),
    ).toEqual({
      tmdbId: 33,
      metadata: {
        title: 'My title',
        originalTitle: 'Original',
        year: 2004,
        releaseDate: null,
        plot: 'Story',
        tagline: '',
        runtime: null,
        genres: ['Drama', 'Mystery'],
        studios: [],
        directors: [],
        actors: [{ name: 'Actor One', character: 'Lead' }],
      },
    });
    expect(readKodiNfo(null).metadata.title).toBe('');
  });

  it('applies explicit field edits and keeps unrelated XML intact', () => {
    const merged = mergeKodiNfo(
      '<movie><title>Old title</title><plot>Old plot</plot><genre>Drama</genre><sorttitle>Custom</sorttitle></movie>',
      metadata,
    );
    const edited = applyKodiNfoEdits(merged, {
      title: 'Manual title',
      plot: '',
      genres: [],
    });
    const movie = (parser.parse(edited) as { movie: Record<string, unknown> })
      .movie;

    expect(movie['title']).toBe('Manual title');
    expect(movie['plot']).toBeUndefined();
    expect(movie['genre']).toBeUndefined();
    expect(movie['sorttitle']).toBe('Custom');
  });
});
