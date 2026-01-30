# Minimal Halo Stats CLI

A simple command-line tool to display your last 10 Halo Infinite matches.

> [!NOTE]
> This project is a minimal demo showcasing the [Grunt](https://github.com/dend/grunt) (Halo Infinite API client) and [Conch](https://github.com/dend/conch) (Xbox Live authentication) libraries.

## Prerequisites

- Node.js 18.0.0 or higher
- A Microsoft Entra ID application with Xbox Live API access

## Entra ID App Setup

1. Go to [Azure Portal](https://portal.azure.com/)
2. Navigate to **Microsoft Entra ID** > **App registrations** > **New registration**
3. Set the name (e.g., "Halo Stats CLI")
4. Under **Supported account types**, select **Personal Microsoft accounts only**
5. Under **Redirect URI**, select **Web** and enter: `https://localhost:3000/callback`
6. Click **Register**
7. Copy the **Application (client) ID** - you'll need this for configuration

### Configure API Permissions

1. In your app registration, go to **API permissions**
2. Click **Add a permission** > **Xbox Live** (under "APIs my organization uses")
3. Add the following delegated permissions:
   - `XboxLive.signin`
   - `XboxLive.offline_access`
4. Click **Grant admin consent** (if available) or consent will be requested on first login

## Installation

1. Clone this repository:
   ```bash
   git clone <repo-url>
   cd minimal-halo-stats-ts
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create your configuration file:
   ```bash
   cp config.example.json config.json
   ```

4. Edit `config.json` and add your Entra ID client ID:
   ```json
   {
     "clientId": "your-client-id-here",
     "redirectUri": "https://localhost:3000/callback"
   }
   ```

5. Build the project:
   ```bash
   npm run build
   ```

## Usage

Run the CLI:

```bash
npm start
```

On first run, the CLI will:
1. Display an authentication URL
2. Start a local server to receive the OAuth callback
3. Wait for you to visit the URL and sign in with your Microsoft account
4. Once authenticated, display your last 10 Halo Infinite matches

### Example Output

```
Halo Infinite Stats

Fetching match history...

Recent Matches

┌─ Win · 10:26 · Jan 23, 11:34 PM · Rank #1
│  Match  267ff4ba-7c4a-4c89-bbeb-37ff6728c495
│  Map    2c9df7e9-89e7-430a-8615-32474d4617c1
│  Mode   0e198591-ac15-4f99-8ff2-dd390decad66
└──────────────────────────────────────────────────────────────────────

┌─ Loss · 5:00 · Jan 23, 11:27 PM · Rank #6
│  Match  8255d036-73a3-48ca-bfb1-76aa5847ad8a
│  Map    79042fc0-ba3d-4046-aa97-5a6902462531
│  Mode   0e198591-ac15-4f99-8ff2-dd390decad66
└──────────────────────────────────────────────────────────────────────

─── 10 matches ───
```

Times are displayed in Pacific Time. Match outcomes are color-coded (green for wins, red for losses).

## Token Storage

Authentication tokens are cached in `tokens.json` (gitignored). This allows you to run the CLI without re-authenticating each time. Tokens are automatically refreshed when they expire.

To force re-authentication, delete `tokens.json` and run the CLI again.

## Configuration

| Field | Description |
|-------|-------------|
| `clientId` | Your Entra ID Application (client) ID |
| `redirectUri` | OAuth redirect URI (must match your Entra ID app configuration) |

## Troubleshooting

### "Failed to refresh OAuth token"
Delete `tokens.json` and re-authenticate.

### "Failed to fetch match history"
- Ensure your Xbox account has Halo Infinite match history
- Check that your Entra ID app has the correct permissions

### Port 3000 already in use
Change the port in `config.json` by modifying the `redirectUri`:
```json
{
  "redirectUri": "https://localhost:8080/callback"
}
```
Make sure to update the redirect URI in your Entra ID app registration as well.

## Dependencies

- [@dendotdev/conch](../conch) - Xbox Live authentication
- [@dendotdev/grunt](../grunt) - Halo Infinite API client

## License

MIT
