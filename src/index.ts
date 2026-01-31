import { createServer } from 'node:http';
import { URL } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { XboxAuthenticationClient } from '@dendotdev/conch';
import {
  HaloAuthenticationClient,
  HaloInfiniteClient,
  MatchType,
  isSuccess,
} from '@dendotdev/grunt';

interface Config {
  clientId: string;
  redirectUri: string;
}

interface StoredTokens {
  refreshToken: string;
  spartanToken: string;
  spartanTokenExpiry: number;
  xuid: string;
  xblToken?: string; // XBL3.0 x={userHash};{xstsToken} for Xbox Live API calls
}

const CONFIG_PATH = './config.json';
const TOKENS_PATH = './tokens.json';

async function loadConfig(): Promise<Config> {
  if (!existsSync(CONFIG_PATH)) {
    console.error('Error: config.json not found.');
    console.error('Copy config.example.json to config.json and set your client ID.');
    process.exit(1);
  }
  const data = await readFile(CONFIG_PATH, 'utf-8');
  return JSON.parse(data);
}

async function loadTokens(): Promise<StoredTokens | null> {
  if (!existsSync(TOKENS_PATH)) {
    return null;
  }
  const data = await readFile(TOKENS_PATH, 'utf-8');
  return JSON.parse(data);
}

async function saveTokens(tokens: StoredTokens): Promise<void> {
  await writeFile(TOKENS_PATH, JSON.stringify(tokens, null, 2));
}

async function waitForAuthCode(redirectUri: string): Promise<string> {
  const url = new URL(redirectUri);
  const port = parseInt(url.port) || 3000;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const reqUrl = new URL(req.url ?? '/', `http://localhost:${port}`);
      const code = reqUrl.searchParams.get('code');

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Authentication successful!</h1><p>You can close this window.</p></body></html>');
        server.close();
        resolve(code);
      } else {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Error</h1><p>No authorization code received.</p></body></html>');
      }
    });

    server.listen(port, () => {
      // Silent - URL is already shown
    });

    server.on('error', reject);
  });
}

async function authenticate(config: Config): Promise<{ spartanToken: string; xuid: string; refreshToken: string; xblToken: string }> {
  const xboxClient = new XboxAuthenticationClient();

  const authUrl = xboxClient.generateAuthUrl(config.clientId, config.redirectUri);
  console.log(dim('Open this URL to sign in:'));
  console.log(authUrl);
  console.log('');

  const code = await waitForAuthCode(config.redirectUri);
  console.log(dim('Authenticating...'));

  const oauthToken = await xboxClient.requestOAuthToken(config.clientId, code, config.redirectUri);
  if (!oauthToken?.access_token) {
    throw new Error('Failed to get OAuth access token');
  }

  const userToken = await xboxClient.requestUserToken(oauthToken.access_token);
  if (!userToken?.Token) {
    throw new Error('Failed to get user token');
  }

  const xboxXstsToken = await xboxClient.requestXstsToken(userToken.Token);
  if (!xboxXstsToken?.Token) {
    throw new Error('Failed to get Xbox XSTS token');
  }

  const xuid = xboxXstsToken.DisplayClaims?.xui?.[0]?.xid;
  const userHash = xboxXstsToken.DisplayClaims?.xui?.[0]?.uhs;
  if (!xuid || !userHash) {
    throw new Error('Failed to get XUID/userHash from Xbox XSTS token');
  }

  // Build XBL3.0 authorization header for Xbox Live API calls
  const xblToken = `XBL3.0 x=${userHash};${xboxXstsToken.Token}`;

  const relyingParty = HaloAuthenticationClient.getRelyingParty();
  const haloXstsToken = await xboxClient.requestXstsToken(userToken.Token, relyingParty as "http://xboxlive.com");
  if (!haloXstsToken?.Token) {
    throw new Error('Failed to get Halo XSTS token');
  }

  const haloAuthClient = new HaloAuthenticationClient();
  const spartanTokenResponse = await haloAuthClient.getSpartanToken(haloXstsToken.Token);
  if (!spartanTokenResponse?.token) {
    throw new Error('Failed to get Spartan token');
  }

  return {
    spartanToken: spartanTokenResponse.token,
    xuid,
    refreshToken: oauthToken.refresh_token ?? '',
    xblToken,
  };
}

async function refreshAuthentication(config: Config, refreshToken: string): Promise<{ spartanToken: string; xuid: string; refreshToken: string; xblToken: string }> {
  const xboxClient = new XboxAuthenticationClient();

  console.log('Refreshing authentication...');
  const oauthToken = await xboxClient.refreshOAuthToken(config.clientId, refreshToken, config.redirectUri);

  if (!oauthToken?.access_token) {
    throw new Error('Failed to refresh OAuth token');
  }

  // Get user token
  const userToken = await xboxClient.requestUserToken(oauthToken.access_token);

  if (!userToken?.Token) {
    throw new Error('Failed to get user token');
  }

  // Get XSTS token with Xbox Live relying party (to get XUID)
  const xboxXstsToken = await xboxClient.requestXstsToken(userToken.Token);

  if (!xboxXstsToken?.Token) {
    throw new Error('Failed to get Xbox XSTS token');
  }

  const xuid = xboxXstsToken.DisplayClaims?.xui?.[0]?.xid;
  const userHash = xboxXstsToken.DisplayClaims?.xui?.[0]?.uhs;
  if (!xuid || !userHash) {
    throw new Error('Failed to get XUID/userHash from Xbox XSTS token');
  }

  // Build XBL3.0 authorization header for Xbox Live API calls
  const xblToken = `XBL3.0 x=${userHash};${xboxXstsToken.Token}`;

  // Get XSTS token with Halo Waypoint relying party (for Spartan token)
  const relyingParty = HaloAuthenticationClient.getRelyingParty();
  // Cast needed because conch types relyingParty too strictly
  const haloXstsToken = await xboxClient.requestXstsToken(userToken.Token, relyingParty as "http://xboxlive.com");

  if (!haloXstsToken?.Token) {
    throw new Error('Failed to get Halo XSTS token');
  }

  // Get Spartan token
  const haloAuthClient = new HaloAuthenticationClient();
  const spartanTokenResponse = await haloAuthClient.getSpartanToken(haloXstsToken.Token);

  if (!spartanTokenResponse?.token) {
    throw new Error('Failed to get Spartan token');
  }

  return {
    spartanToken: spartanTokenResponse.token,
    xuid,
    refreshToken: oauthToken.refresh_token ?? refreshToken,
    xblToken,
  };
}

// ANSI color codes for terminal styling
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

function formatDuration(iso8601Duration: string | undefined): string {
  if (!iso8601Duration) return '-';

  const match = iso8601Duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/);
  if (!match) return iso8601Duration;

  const hours = parseInt(match[1] ?? '0');
  const minutes = parseInt(match[2] ?? '0');
  const seconds = Math.floor(parseFloat(match[3] ?? '0'));

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function formatOutcome(outcome: number | undefined): { text: string; colored: string } {
  switch (outcome) {
    case 1: return { text: 'DNF', colored: yellow('DNF') };
    case 2: return { text: 'Win', colored: green('Win') };
    case 3: return { text: 'Loss', colored: red('Loss') };
    case 4: return { text: 'Tie', colored: yellow('Tie') };
    default: return { text: '-', colored: dim('-') };
  }
}

function formatPacificTime(isoString: string | undefined): string {
  if (!isoString) return '-';

  const date = new Date(isoString);
  return date.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

async function printMatchStats(client: HaloInfiniteClient, matchId: string): Promise<void> {
  console.log('');
  console.log(bold('Match Stats (JSON)'));
  console.log(dim('─'.repeat(70)));

  const stats = await client.stats.getMatchStats(matchId);

  if (!isSuccess(stats)) {
    console.error(red(`Failed to fetch match stats: ${stats.response.code}`));
    return;
  }

  console.log(JSON.stringify(stats.result, null, 2));
}

interface FilmChunk {
  Index: number;
  FileRelativePath: string;
  ChunkSize: number;
  ChunkType: number;
}

interface FilmCustomData {
  Chunks: FilmChunk[];
  MatchId: string;
  FilmLength: number;
  HasGameEnded: boolean;
}

interface FilmResponse {
  BlobStoragePathPrefix: string;
  CustomData: FilmCustomData;
  AssetId: string;
  FilmStatusBond: number;
}

async function downloadFilm(client: HaloInfiniteClient, matchId: string): Promise<void> {
  console.log('');
  console.log(bold('Downloading Film'));
  console.log(dim('─'.repeat(70)));

  console.log(dim(`Match ID: ${matchId}`));

  const filmResult = await client.ugcDiscovery.getFilmByMatchId(matchId);

  if (!isSuccess(filmResult)) {
    console.log(yellow('No film available for this match (films expire after ~2 weeks).'));
    return;
  }

  const film = filmResult.result as unknown as FilmResponse;
  const blobPrefix = film.BlobStoragePathPrefix;
  const chunks = film.CustomData?.Chunks;

  if (!blobPrefix || !chunks?.length) {
    console.log(yellow('Film has no downloadable chunks.'));
    return;
  }

  // Strip the origin from the blob prefix - getBlob expects just the path
  // e.g., "https://blobs-infiniteugc.svc.halowaypoint.com/ugcstorage/film/..." -> "/ugcstorage/film/..."
  const blobOrigin = 'https://blobs-infiniteugc.svc.halowaypoint.com';
  let blobPathPrefix = blobPrefix.startsWith(blobOrigin)
    ? blobPrefix.slice(blobOrigin.length)
    : blobPrefix;

  // Remove trailing slash to avoid double slashes when appending FileRelativePath
  if (blobPathPrefix.endsWith('/')) {
    blobPathPrefix = blobPathPrefix.slice(0, -1);
  }

  const filmsDir = join(process.cwd(), 'films', matchId);
  await mkdir(filmsDir, { recursive: true });

  console.log(`Downloading ${chunks.length} chunk(s) to ${filmsDir}`);

  for (const chunk of chunks) {
    const blobPath = blobPathPrefix + chunk.FileRelativePath;
    const filename = `filmChunk${chunk.Index}`;

    console.log(dim(`  [${chunk.Index + 1}/${chunks.length}] ${filename} (${(chunk.ChunkSize / 1024).toFixed(1)} KB)`));

    const blob = await client.ugc.getBlob(blobPath);

    if (!isSuccess(blob)) {
      console.log(red(`    Failed: ${blob.response.code}`));
      continue;
    }

    await writeFile(join(filmsDir, filename), blob.result);
    console.log(green(`    Saved`));
  }

  console.log('');
  console.log(green(`Film saved to: ${filmsDir}`));
}

async function fetchAndDisplayMatches(spartanToken: string, xuid: string): Promise<void> {
  const client = new HaloInfiniteClient({
    spartanToken,
    xuid,
  });

  console.log(dim('Fetching match history...'));

  const history = await client.stats.getMatchHistory(xuid, 0, 10, MatchType.All);

  if (!isSuccess(history)) {
    console.error(`Failed to fetch match history: ${history.response.code}`);
    return;
  }

  // API returns PascalCase
  const result = history.result as Record<string, unknown>;
  const resultsArray = (result.Results ?? result.results) as Record<string, unknown>[] | undefined;

  if (!resultsArray || resultsArray.length === 0) {
    console.log('No matches found.');
    return;
  }

  console.log('');
  console.log(bold('Recent Matches'));
  console.log('');

  for (let i = 0; i < resultsArray.length; i++) {
    const match = resultsArray[i];
    const info = (match.MatchInfo ?? match.matchInfo) as Record<string, unknown> | undefined;
    const mapVariant = (info?.MapVariant ?? info?.mapVariant) as Record<string, unknown> | undefined;
    const ugcGameVariant = (info?.UgcGameVariant ?? info?.ugcGameVariant) as Record<string, unknown> | undefined;
    const playlist = (info?.Playlist ?? info?.playlist) as Record<string, unknown> | undefined;

    const mapAssetId = (mapVariant?.AssetId ?? mapVariant?.assetId ?? '-') as string;
    const modeAssetId = (ugcGameVariant?.AssetId ?? ugcGameVariant?.assetId ??
                         playlist?.AssetId ?? playlist?.assetId ?? '-') as string;

    const outcome = formatOutcome((match.Outcome ?? match.outcome) as number | undefined);
    const duration = formatDuration((info?.Duration ?? info?.duration) as string | undefined);
    const startTimeStr = (info?.StartTime ?? info?.startTime) as string | undefined;
    const timeStr = formatPacificTime(startTimeStr);
    const rank = (match.Rank ?? match.rank) as number | undefined;
    const matchId = (match.MatchId ?? match.matchId ?? '-') as string;

    // Box drawing characters for visual richness
    console.log(`┌─ ${outcome.colored} ${dim('·')} ${duration} ${dim('·')} ${timeStr} ${rank ? dim(`· Rank #${rank}`) : ''}`);
    console.log(`│  ${dim('Match')}  ${matchId}`);
    console.log(`│  ${dim('Map')}    ${mapAssetId}`);
    console.log(`│  ${dim('Mode')}   ${modeAssetId}`);
    console.log(`└${'─'.repeat(70)}`);

    if (i < resultsArray.length - 1) {
      console.log('');
    }
  }

  console.log('');
  console.log(dim(`─── ${resultsArray.length} matches ───`));

  // Get most recent match ID and fetch details + film
  const mostRecentMatch = resultsArray[0];
  const mostRecentMatchId = (mostRecentMatch.MatchId ?? mostRecentMatch.matchId) as string;

  if (mostRecentMatchId && mostRecentMatchId !== '-') {
    await printMatchStats(client, mostRecentMatchId);
    await downloadFilm(client, mostRecentMatchId);
  }
}

async function main(): Promise<void> {
  console.log(bold('Halo Infinite Stats'));
  console.log('');

  const config = await loadConfig();
  let tokens = await loadTokens();
  let needsAuth = true;

  if (tokens && tokens.spartanToken && tokens.refreshToken) {
    if (tokens.spartanTokenExpiry && Date.now() < tokens.spartanTokenExpiry - 300000) {
      needsAuth = false;
    } else {
      try {
        console.log(dim('Refreshing authentication...'));
        const refreshed = await refreshAuthentication(config, tokens.refreshToken);
        tokens = {
          refreshToken: refreshed.refreshToken,
          spartanToken: refreshed.spartanToken,
          spartanTokenExpiry: Date.now() + 3600000,
          xuid: refreshed.xuid,
          xblToken: refreshed.xblToken,
        };
        await saveTokens(tokens);
        needsAuth = false;
      } catch {
        console.log(dim('Session expired, re-authenticating...'));
      }
    }
  }

  if (needsAuth) {
    const authResult = await authenticate(config);
    tokens = {
      refreshToken: authResult.refreshToken,
      spartanToken: authResult.spartanToken,
      spartanTokenExpiry: Date.now() + 3600000,
      xuid: authResult.xuid,
      xblToken: authResult.xblToken,
    };
    await saveTokens(tokens);
  }

  if (!tokens) {
    console.error('Authentication failed.');
    process.exit(1);
  }

  await fetchAndDisplayMatches(tokens.spartanToken, tokens.xuid);
}

main().catch((error) => {
  console.error(red('Error:'), error.message);
  process.exit(1);
});
