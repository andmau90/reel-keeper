import { TmdbClient } from './tmdb-client.js';
import { recognizeMovieFilename } from './recognizer.js';

const argumentsList = process.argv
  .slice(2)
  .filter((argument) => argument !== '--');
if (argumentsList.length !== 1) {
  throw new Error('Usage: reelkeeper recognize <movie-filename>');
}

const accessToken = process.env.TMDB_ACCESS_TOKEN;
if (!accessToken) {
  throw new Error('Set TMDB_ACCESS_TOKEN in the server process environment.');
}

const result = await recognizeMovieFilename(
  argumentsList[0],
  new TmdbClient({ accessToken }),
);

console.log(JSON.stringify(result, null, 2));
