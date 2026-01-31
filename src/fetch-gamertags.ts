import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

interface StoredTokens {
  refreshToken: string;
  spartanToken: string;
  spartanTokenExpiry: number;
  xuid: string;
  xblToken?: string;
}

interface ProfileSetting {
  id: string;
  value: string;
}

interface ProfileUser {
  id: string;
  settings: ProfileSetting[];
}

interface BatchProfileResponse {
  profileUsers: ProfileUser[];
}

interface PlayerInfo {
  xuid: string;
  gamertag?: string;
  modernGamertag?: string;
  modernGamertagSuffix?: string;
  uniqueModernGamertag?: string;
}

const TOKENS_PATH = './tokens.json';

async function loadTokens(): Promise<StoredTokens | null> {
  if (!existsSync(TOKENS_PATH)) {
    return null;
  }
  const data = await readFile(TOKENS_PATH, 'utf-8');
  return JSON.parse(data);
}

function extractXuidsFromMatch(matchData: Record<string, unknown>): string[] {
  const players = matchData.Players as Array<Record<string, unknown>> | undefined;
  if (!players) return [];

  const xuids: string[] = [];
  for (const player of players) {
    const playerId = player.PlayerId as string | undefined;
    if (playerId && playerId.startsWith('xuid(')) {
      const xuid = playerId.slice(5, -1); // Extract number from "xuid(123)"
      xuids.push(xuid);
    }
  }
  return xuids;
}

async function fetchGamertags(xblToken: string, xuids: string[]): Promise<PlayerInfo[]> {
  const response = await fetch('https://profile.xboxlive.com/users/batch/profile/settings', {
    method: 'POST',
    headers: {
      'Authorization': xblToken,
      'x-xbl-contract-version': '2',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      userIds: xuids,
      settings: ['Gamertag', 'ModernGamertag', 'ModernGamertagSuffix', 'UniqueModernGamertag'],
    }),
  });

  if (!response.ok) {
    throw new Error(`Xbox API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as BatchProfileResponse;

  return data.profileUsers.map(user => {
    const info: PlayerInfo = { xuid: user.id };
    for (const setting of user.settings) {
      switch (setting.id) {
        case 'Gamertag':
          info.gamertag = setting.value;
          break;
        case 'ModernGamertag':
          info.modernGamertag = setting.value;
          break;
        case 'ModernGamertagSuffix':
          info.modernGamertagSuffix = setting.value;
          break;
        case 'UniqueModernGamertag':
          info.uniqueModernGamertag = setting.value;
          break;
      }
    }
    return info;
  });
}

async function main(): Promise<void> {
  const matchPath = process.argv[2];

  if (!matchPath) {
    console.error('Usage: npx tsx src/fetch-gamertags.ts <path-to-match-metadata.json>');
    process.exit(1);
  }

  if (!existsSync(matchPath)) {
    console.error(`File not found: ${matchPath}`);
    process.exit(1);
  }

  const tokens = await loadTokens();
  if (!tokens?.xblToken) {
    console.error('No XBL token found. Run the main app first to authenticate.');
    process.exit(1);
  }

  console.log('Reading match metadata...');
  const matchData = JSON.parse(await readFile(matchPath, 'utf-8'));

  const xuids = extractXuidsFromMatch(matchData);
  console.log(`Found ${xuids.length} player XUIDs`);

  if (xuids.length === 0) {
    console.log('No XUIDs to look up.');
    return;
  }

  console.log('Fetching gamertags from Xbox Live...');
  const players = await fetchGamertags(tokens.xblToken, xuids);

  console.log('');
  console.log('Players:');
  console.log('─'.repeat(60));

  for (const player of players) {
    const displayName = player.uniqueModernGamertag || player.gamertag || player.xuid;
    console.log(`  ${player.xuid} → ${displayName}`);
  }

  // Save to players.json in same directory as match metadata
  const outputPath = matchPath.replace('match-metadata.json', 'players.json');
  await writeFile(outputPath, JSON.stringify(players, null, 2));
  console.log('');
  console.log(`Saved to: ${outputPath}`);
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
