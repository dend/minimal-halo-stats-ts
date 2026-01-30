# Halo Infinite TypeScript App Bootstrap

Use this skill to scaffold a new Halo Infinite console application with Xbox Live authentication already configured.

## Overview

This skill creates a TypeScript Node.js console app that:
- Authenticates with Xbox Live using OAuth (via `@dendotdev/conch`)
- Exchanges tokens for Halo Infinite API access (via `@dendotdev/grunt`)
- Caches and refreshes tokens automatically
- Provides a ready-to-use `HaloInfiniteClient` instance

## Prerequisites

The user needs a Microsoft Entra ID application:
1. Go to [Azure Portal](https://portal.azure.com/)
2. Navigate to **Microsoft Entra ID** > **App registrations** > **New registration**
3. Set **Supported account types** to **Personal Microsoft accounts only**
4. Set **Redirect URI** to **Web** with `https://localhost:3000/callback`
5. Copy the **Application (client) ID**

## Project Structure

Create the following files:

```
project-name/
├── src/
│   └── index.ts
├── package.json
├── tsconfig.json
├── config.example.json
└── .gitignore
```

## File Contents

### package.json

```json
{
  "name": "halo-infinite-app",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsc && node dist/index.js"
  },
  "dependencies": {
    "@dendotdev/conch": "1.0.1",
    "@dendotdev/grunt": "1.0.1"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.0.0"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### config.example.json

```json
{
  "clientId": "YOUR_ENTRA_CLIENT_ID_HERE",
  "redirectUri": "https://localhost:3000/callback"
}
```

### .gitignore

```
node_modules/
dist/
config.json
tokens.json
```

### src/index.ts

```typescript
import { createServer } from 'node:http';
import { URL } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { XboxAuthenticationClient } from '@dendotdev/conch';
import {
  HaloAuthenticationClient,
  HaloInfiniteClient,
  MatchType,
  isSuccess,
} from '@dendotdev/grunt';

// ============================================================================
// Configuration Types
// ============================================================================

interface Config {
  clientId: string;
  redirectUri: string;
}

interface StoredTokens {
  refreshToken: string;
  spartanToken: string;
  spartanTokenExpiry: number;
  xuid: string;
}

const CONFIG_PATH = './config.json';
const TOKENS_PATH = './tokens.json';

// ============================================================================
// Config & Token Management
// ============================================================================

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

// ============================================================================
// OAuth Callback Server
// ============================================================================

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

    server.listen(port);
    server.on('error', reject);
  });
}

// ============================================================================
// Xbox Live & Halo Authentication
// ============================================================================

async function authenticate(config: Config): Promise<{ spartanToken: string; xuid: string; refreshToken: string }> {
  const xboxClient = new XboxAuthenticationClient();

  // Generate and display auth URL
  const authUrl = xboxClient.generateAuthUrl(config.clientId, config.redirectUri);
  console.log('Open this URL to sign in:');
  console.log(authUrl);
  console.log('');

  // Wait for OAuth callback
  const code = await waitForAuthCode(config.redirectUri);
  console.log('Authenticating...');

  // Exchange code for OAuth token
  const oauthToken = await xboxClient.requestOAuthToken(config.clientId, code, config.redirectUri);
  if (!oauthToken?.access_token) {
    throw new Error('Failed to get OAuth access token');
  }

  // Get Xbox Live user token
  const userToken = await xboxClient.requestUserToken(oauthToken.access_token);
  if (!userToken?.Token) {
    throw new Error('Failed to get user token');
  }

  // Get Xbox Live XSTS token (for XUID)
  const xboxXstsToken = await xboxClient.requestXstsToken(userToken.Token);
  if (!xboxXstsToken?.Token) {
    throw new Error('Failed to get Xbox XSTS token');
  }

  const xuid = xboxXstsToken.DisplayClaims?.xui?.[0]?.xid;
  if (!xuid) {
    throw new Error('Failed to get XUID from Xbox XSTS token');
  }

  // Get Halo Waypoint XSTS token
  const relyingParty = HaloAuthenticationClient.getRelyingParty();
  const haloXstsToken = await xboxClient.requestXstsToken(userToken.Token, relyingParty as "http://xboxlive.com");
  if (!haloXstsToken?.Token) {
    throw new Error('Failed to get Halo XSTS token');
  }

  // Exchange for Spartan token
  const haloAuthClient = new HaloAuthenticationClient();
  const spartanTokenResponse = await haloAuthClient.getSpartanToken(haloXstsToken.Token);
  if (!spartanTokenResponse?.token) {
    throw new Error('Failed to get Spartan token');
  }

  return {
    spartanToken: spartanTokenResponse.token,
    xuid,
    refreshToken: oauthToken.refresh_token ?? '',
  };
}

async function refreshAuthentication(config: Config, refreshToken: string): Promise<{ spartanToken: string; xuid: string; refreshToken: string }> {
  const xboxClient = new XboxAuthenticationClient();

  const oauthToken = await xboxClient.refreshOAuthToken(config.clientId, refreshToken, config.redirectUri);
  if (!oauthToken?.access_token) {
    throw new Error('Failed to refresh OAuth token');
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
  if (!xuid) {
    throw new Error('Failed to get XUID from Xbox XSTS token');
  }

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
    refreshToken: oauthToken.refresh_token ?? refreshToken,
  };
}

// ============================================================================
// Client Initialization
// ============================================================================

async function getAuthenticatedClient(): Promise<{ client: HaloInfiniteClient; xuid: string }> {
  const config = await loadConfig();
  let tokens = await loadTokens();
  let needsAuth = true;

  if (tokens && tokens.spartanToken && tokens.refreshToken) {
    // Check if token is still valid (with 5 min buffer)
    if (tokens.spartanTokenExpiry && Date.now() < tokens.spartanTokenExpiry - 300000) {
      needsAuth = false;
    } else {
      // Try to refresh
      try {
        console.log('Refreshing authentication...');
        const refreshed = await refreshAuthentication(config, tokens.refreshToken);
        tokens = {
          refreshToken: refreshed.refreshToken,
          spartanToken: refreshed.spartanToken,
          spartanTokenExpiry: Date.now() + 3600000, // 1 hour
          xuid: refreshed.xuid,
        };
        await saveTokens(tokens);
        needsAuth = false;
      } catch {
        console.log('Session expired, re-authenticating...');
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
    };
    await saveTokens(tokens);
  }

  if (!tokens) {
    throw new Error('Authentication failed');
  }

  const client = new HaloInfiniteClient({
    spartanToken: tokens.spartanToken,
    xuid: tokens.xuid,
  });

  return { client, xuid: tokens.xuid };
}

// ============================================================================
// Main Application - Customize this section
// ============================================================================

async function main(): Promise<void> {
  console.log('Halo Infinite App');
  console.log('');

  const { client, xuid } = await getAuthenticatedClient();

  // -------------------------------------------------------------------------
  // Your code here! Use the authenticated client to call Halo Infinite APIs.
  // -------------------------------------------------------------------------

  // Example: Fetch match history
  const history = await client.stats.getMatchHistory(xuid, 0, 10, MatchType.All);

  if (isSuccess(history)) {
    const result = history.result as Record<string, unknown>;
    const matches = (result.Results ?? result.results) as unknown[] | undefined;
    console.log(`Found ${matches?.length ?? 0} matches`);
  }

  // Available client modules:
  // - client.stats        - Match history, service records, match stats
  // - client.skill        - CSR (Competitive Skill Rank) queries
  // - client.economy      - Inventory, store, customization
  // - client.gameCms      - Medals, challenges, career ranks, seasons
  // - client.ugc          - User-generated content
  // - client.ugcDiscovery - Browse/search UGC
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
```

## Authentication Flow

The authentication flow works as follows:

1. **OAuth Authorization**: User visits Microsoft login URL, grants permissions
2. **OAuth Token Exchange**: Authorization code exchanged for access/refresh tokens
3. **Xbox Live User Token**: OAuth token exchanged for Xbox Live user token
4. **Xbox Live XSTS Token**: User token exchanged for XSTS token (contains XUID)
5. **Halo XSTS Token**: Separate XSTS token with Halo Waypoint relying party
6. **Spartan Token**: XSTS token exchanged for Halo API authentication

```
OAuth Code → OAuth Token → User Token → Xbox XSTS Token (XUID)
                                      → Halo XSTS Token → Spartan Token
```

## Key Points

- Two XSTS tokens are needed: one for Xbox Live (to get XUID), one for Halo Waypoint (for Spartan token)
- The Halo relying party is: `https://prod.xsts.halowaypoint.com/`
- Tokens are cached in `tokens.json` and automatically refreshed
- API responses use PascalCase property names (e.g., `Results`, `MatchInfo`)

## Available API Modules

Once authenticated, the `HaloInfiniteClient` provides:

| Module | Description |
|--------|-------------|
| `stats` | Match history, service records, match details |
| `skill` | CSR (Competitive Skill Rank) data |
| `economy` | Player inventory, store, customization |
| `gameCms` | Game content: medals, challenges, career ranks |
| `ugc` | User-generated content authoring |
| `ugcDiscovery` | Search and browse UGC |

## Example API Calls

```typescript
// Match history
const history = await client.stats.getMatchHistory(xuid, 0, 25, MatchType.All);

// Service record (career stats)
const record = await client.stats.getPlayerServiceRecordByXuid(xuid, LifecycleMode.Matchmade);

// Match details
const match = await client.stats.getMatchStats(matchId);

// CSR (rank)
const csr = await client.skill.getPlaylistCsr(playlistId, [xuid]);
```
