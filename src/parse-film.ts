#!/usr/bin/env node
/**
 * Halo Infinite Film Parser CLI
 *
 * Usage: npx ts-node src/parse-film.ts [film-directory]
 *
 * If no directory is specified, it will look for a match-metadata.json
 * and players.json in the current directory to auto-detect the film location.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import {
  FilmParser,
  formatTimestamp,
  formatPosition,
  extractMapPositions,
  parseEventsWithPositions,
  type FilmSummary,
  type ComponentDefinition,
  type PlayerInfo,
  type FilmEvent,
  type PositionData,
  type PlayerEventWithPosition,
} from './film-parser.js';
import { readFile as readFileAsync } from 'node:fs/promises';

// ANSI color codes
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

interface MatchMetadata {
  MatchId: string;
  MatchInfo: {
    StartTime: string;
    EndTime: string;
    Duration: string;
    GameVariantCategory: number;
  };
  Players: Array<{
    PlayerId: string;
    LastTeamId: number;
    Outcome: number;
    PlayerTeamStats: Array<{
      Stats: {
        CoreStats: {
          Kills: number;
          Deaths: number;
          Assists: number;
        };
      };
    }>;
  }>;
  Teams: Array<{
    TeamId: number;
    Outcome: number;
    Stats: {
      CoreStats: {
        Score: number;
      };
    };
  }>;
}

interface PlayersJson {
  profileUsers: Array<{
    id: string;
    settings: Array<{
      id: string;
      value: string;
    }>;
  }>;
}

async function loadMatchMetadata(filmDir: string): Promise<MatchMetadata | null> {
  const metadataPath = join(filmDir, 'match-metadata.json');
  if (!existsSync(metadataPath)) return null;

  const data = await readFile(metadataPath, 'utf-8');
  return JSON.parse(data);
}

async function loadPlayersJson(filmDir: string): Promise<PlayersJson | null> {
  const playersPath = join(filmDir, 'players.json');
  if (!existsSync(playersPath)) return null;

  const data = await readFile(playersPath, 'utf-8');
  return JSON.parse(data);
}

function extractGamertags(players: PlayersJson): string[] {
  return players.profileUsers.map(p => {
    const gamertagSetting = p.settings.find(s => s.id === 'Gamertag');
    return gamertagSetting?.value ?? '';
  }).filter(g => g.length > 0);
}

function extractXuids(players: PlayersJson): string[] {
  return players.profileUsers.map(p => p.id);
}

function printHeader(title: string): void {
  console.log('');
  console.log(bold(title));
  console.log(dim('─'.repeat(70)));
}

function printChunkInfo(parser: FilmParser): Promise<void> {
  return parser.getChunkInfo().then(chunks => {
    printHeader('Chunk Information');

    console.log(dim('Index  Type       Compressed    Decompressed  Ratio'));
    for (const chunk of chunks) {
      const typeHex = `0x${chunk.type.toString(16).padStart(5, '0')}`;
      const compressed = chunk.compressedSize > 0 ? `${(chunk.compressedSize / 1024).toFixed(1)} KB` : '-';
      const decompressed = chunk.decompressedSize > 0 ? `${(chunk.decompressedSize / 1024).toFixed(1)} KB` : '-';
      const ratio = chunk.compressedSize > 0 && chunk.decompressedSize > 0
        ? `${((chunk.decompressedSize / chunk.compressedSize) * 100).toFixed(0)}%`
        : '-';

      console.log(
        `${chunk.index.toString().padStart(5)}  ${typeHex}  ${compressed.padStart(10)}  ${decompressed.padStart(12)}  ${ratio.padStart(5)}`
      );
    }
  });
}

function printComponents(components: ComponentDefinition[], showAll: boolean = false): void {
  printHeader(`Component Definitions (${components.length} unique)`);

  // Group by category
  const categories: Record<string, ComponentDefinition[]> = {};
  for (const comp of components) {
    const parts = comp.name.split('-');
    const category = parts[0] || 'other';
    if (!categories[category]) categories[category] = [];
    categories[category].push(comp);
  }

  // Sort categories by count
  const sortedCategories = Object.entries(categories)
    .sort((a, b) => b[1].length - a[1].length);

  if (showAll) {
    // Show all components grouped by category
    for (const [category, comps] of sortedCategories) {
      console.log(`${cyan(category)} (${comps.length})`);
      for (const comp of comps.sort((a, b) => a.name.localeCompare(b.name))) {
        console.log(`  ${dim('·')} ${comp.name}`);
      }
    }
  } else {
    // Show truncated view (top 10 categories, 3 components each)
    for (const [category, comps] of sortedCategories.slice(0, 10)) {
      console.log(`${cyan(category)} (${comps.length})`);
      for (const comp of comps.slice(0, 3)) {
        console.log(`  ${dim('·')} ${comp.name}`);
      }
      if (comps.length > 3) {
        console.log(`  ${dim(`... and ${comps.length - 3} more`)}`);
      }
    }
    console.log('');
    console.log(dim('Use --all-components to show all components'));
  }
}

function printPlayers(players: PlayerInfo[], metadata: MatchMetadata | null): void {
  printHeader('Players Found in Film');

  if (players.length === 0) {
    console.log(yellow('No players found. Make sure players.json contains gamertags.'));
    return;
  }

  console.log(dim('Gamertag            Film Team  XUID             Offset'));
  for (const player of players) {
    const gamertag = player.gamertag.padEnd(18);
    const team = player.filmTeamId >= 0 ? player.filmTeamId.toString() : '-';
    const xuid = player.xuid || '-';
    console.log(`${gamertag}  ${team.padStart(9)}  ${xuid.padEnd(16)}  0x${player.offset.toString(16)}`);
  }

  // Cross-reference with match metadata
  if (metadata) {
    console.log('');
    console.log(dim('API Team Mapping:'));
    for (const apiPlayer of metadata.Players) {
      const xuid = apiPlayer.PlayerId.replace('xuid(', '').replace(')', '');
      if (xuid.startsWith('bid(')) continue; // Skip bots
      const filmPlayer = players.find(p => p.xuid === xuid || p.gamertag === xuid);
      const team = apiPlayer.LastTeamId;
      const outcome = apiPlayer.Outcome === 2 ? green('Won') : apiPlayer.Outcome === 3 ? red('Lost') : yellow('Left');
      console.log(`  ${xuid.padEnd(20)} API Team ${team}  ${outcome}`);
    }
  }
}

function printEvents(events: FilmEvent[]): void {
  printHeader(`Events Timeline (${events.length} events)`);

  if (events.length === 0) {
    console.log(yellow('No events extracted. Event parsing may need refinement.'));
    return;
  }

  // Group by event type
  const byType: Record<string, number> = {};
  for (const event of events) {
    byType[event.eventTypeName] = (byType[event.eventTypeName] || 0) + 1;
  }

  console.log(dim('Event Type Distribution:'));
  for (const [type, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type.padEnd(25)} ${count}`);
  }

  console.log('');
  console.log(dim('First 20 Events:'));
  console.log(dim('Time       Type                  Player'));

  for (const event of events.slice(0, 20)) {
    const time = formatTimestamp(event.timestamp);
    const type = event.eventTypeName.padEnd(20);
    const player = event.playerGamertag || '-';
    console.log(`${time}  ${type}  ${player}`);
  }

  if (events.length > 20) {
    console.log(dim(`... and ${events.length - 20} more events`));
  }
}

function printPositions(positions: PositionData[]): void {
  printHeader(`Position Data (${positions.length} positions sampled)`);

  if (positions.length === 0) {
    console.log(yellow('No position data extracted.'));
    return;
  }

  // Calculate bounding box
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  for (const pos of positions) {
    if (pos.x < minX) minX = pos.x;
    if (pos.x > maxX) maxX = pos.x;
    if (pos.y < minY) minY = pos.y;
    if (pos.y > maxY) maxY = pos.y;
    if (pos.z < minZ) minZ = pos.z;
    if (pos.z > maxZ) maxZ = pos.z;
  }

  console.log(dim('Bounding Box:'));
  console.log(`  X: ${minX.toFixed(2)} to ${maxX.toFixed(2)}`);
  console.log(`  Y: ${minY.toFixed(2)} to ${maxY.toFixed(2)}`);
  console.log(`  Z: ${minZ.toFixed(2)} to ${maxZ.toFixed(2)}`);

  console.log('');
  console.log(dim('Sample Positions:'));
  for (const pos of positions.slice(0, 10)) {
    console.log(`  ${formatPosition(pos)} @ 0x${pos.offset.toString(16)}`);
  }

  if (positions.length > 10) {
    console.log(dim(`... and ${positions.length - 10} more positions`));
  }
}

function printMapPositions(positions: PositionData[]): void {
  printHeader(`Map Positions (${positions.length} gameplay coordinates)`);

  if (positions.length === 0) {
    console.log(yellow('No map position data found.'));
    return;
  }

  // Calculate bounding box
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  for (const pos of positions) {
    if (pos.x < minX) minX = pos.x;
    if (pos.x > maxX) maxX = pos.x;
    if (pos.y < minY) minY = pos.y;
    if (pos.y > maxY) maxY = pos.y;
    if (pos.z < minZ) minZ = pos.z;
    if (pos.z > maxZ) maxZ = pos.z;
  }

  console.log(dim('Play Area Bounding Box:'));
  console.log(`  X: ${minX.toFixed(1)} to ${maxX.toFixed(1)} (width: ${(maxX - minX).toFixed(1)})`);
  console.log(`  Y: ${minY.toFixed(1)} to ${maxY.toFixed(1)} (depth: ${(maxY - minY).toFixed(1)})`);
  console.log(`  Z: ${minZ.toFixed(1)} to ${maxZ.toFixed(1)} (height: ${(maxZ - minZ).toFixed(1)})`);

  // Group positions into regions (quadrants)
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  const quadrants = {
    'NE (+X, +Y)': positions.filter(p => p.x > centerX && p.y > centerY),
    'NW (-X, +Y)': positions.filter(p => p.x <= centerX && p.y > centerY),
    'SE (+X, -Y)': positions.filter(p => p.x > centerX && p.y <= centerY),
    'SW (-X, -Y)': positions.filter(p => p.x <= centerX && p.y <= centerY),
  };

  console.log('');
  console.log(dim('Position Distribution by Quadrant:'));
  for (const [name, pts] of Object.entries(quadrants)) {
    const pct = ((pts.length / positions.length) * 100).toFixed(1);
    const bar = '█'.repeat(Math.round(pts.length / positions.length * 20));
    console.log(`  ${name.padEnd(12)} ${pts.length.toString().padStart(4)} (${pct.padStart(5)}%) ${bar}`);
  }

  console.log('');
  console.log(dim('Sample Gameplay Positions:'));
  // Show positions sorted by offset (roughly chronological)
  const sorted = [...positions].sort((a, b) => a.offset - b.offset);
  for (const pos of sorted.slice(0, 15)) {
    console.log(`  (${pos.x.toFixed(1).padStart(7)}, ${pos.y.toFixed(1).padStart(7)}, ${pos.z.toFixed(1).padStart(5)})`);
  }

  if (positions.length > 15) {
    console.log(dim(`  ... and ${positions.length - 15} more positions`));
  }
}

function printEventsWithPositions(events: PlayerEventWithPosition[]): void {
  printHeader(`Events with Positions`);

  const eventsWithPos = events.filter(e => e.position);
  console.log(`${eventsWithPos.length} of ${events.length} events have associated positions`);

  if (eventsWithPos.length === 0) {
    console.log(yellow('No events with position data found.'));
    console.log(dim('Position data may be stored in delta chunks (1-32) rather than summary chunk.'));
    return;
  }

  console.log('');
  console.log(dim('Time       Type                  Player            Position'));

  for (const event of eventsWithPos.slice(0, 25)) {
    const time = formatTimestamp(event.timestamp);
    const type = event.eventTypeName.padEnd(20);
    const player = (event.playerGamertag || '-').padEnd(16);
    const pos = event.position
      ? `(${event.position.x.toFixed(1)}, ${event.position.y.toFixed(1)}, ${event.position.z.toFixed(1)})`
      : '-';
    console.log(`${time}  ${type}  ${player}  ${pos}`);
  }

  if (eventsWithPos.length > 25) {
    console.log(dim(`... and ${eventsWithPos.length - 25} more events with positions`));
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Parse flags
  const showAllComponents = args.includes('--all-components');
  const showPositions = args.includes('--positions');
  const filteredArgs = args.filter(a => !a.startsWith('--'));

  let filmDir = filteredArgs[0] || process.cwd();

  // Resolve to absolute path
  filmDir = resolve(filmDir);

  console.log(bold('Halo Infinite Film Parser'));
  console.log('');
  console.log(`Film directory: ${dim(filmDir)}`);

  // Check if film chunks exist
  const chunk0Path = join(filmDir, 'filmChunk0');
  const chunk0DecPath = join(filmDir, 'filmChunk0_dec');

  if (!existsSync(chunk0Path) && !existsSync(chunk0DecPath)) {
    console.error(red(`Error: No film chunks found in ${filmDir}`));
    console.error(dim('Expected files like filmChunk0, filmChunk1, etc.'));
    process.exit(1);
  }

  // Load metadata files if available
  const metadata = await loadMatchMetadata(filmDir);
  const playersJson = await loadPlayersJson(filmDir);

  if (metadata) {
    console.log(`Match ID: ${cyan(metadata.MatchId)}`);
    console.log(`Duration: ${metadata.MatchInfo.Duration}`);
    console.log(`Start: ${metadata.MatchInfo.StartTime}`);
  }

  // Extract known gamertags and XUIDs
  const knownGamertags = playersJson ? extractGamertags(playersJson) : [];
  const knownXuids = playersJson ? extractXuids(playersJson) : [];

  if (knownGamertags.length > 0) {
    console.log(`Known gamertags: ${knownGamertags.join(', ')}`);
  }

  // Create parser
  const parser = new FilmParser({
    filmDir,
    knownGamertags,
    knownXuids,
  });

  // Print chunk info
  await printChunkInfo(parser);

  // Parse the film
  console.log('');
  console.log(dim('Parsing film data...'));

  try {
    const summary = await parser.parse();

    printComponents(summary.components, showAllComponents);
    printPlayers(summary.players, metadata);
    printEvents(summary.events);
    printPositions(summary.positions);

    // Enhanced position analysis when --positions flag is used
    if (showPositions) {
      // Load chunk 33 directly for detailed position analysis
      const chunk33Path = join(filmDir, 'filmChunk33_dec');
      if (existsSync(chunk33Path)) {
        const chunk33Data = await readFile(chunk33Path);

        // Extract map-relevant positions
        const mapPositions = extractMapPositions(chunk33Data);
        printMapPositions(mapPositions);

        // Parse events with positions
        const eventsWithPos = parseEventsWithPositions(chunk33Data, knownGamertags);
        printEventsWithPositions(eventsWithPos);
      } else {
        console.log(yellow('\nChunk 33 decompressed file not found for position analysis.'));
      }
    }

    // Summary
    printHeader('Summary');
    console.log(`Components: ${summary.components.length}`);
    console.log(`Players found: ${summary.players.length}`);
    console.log(`Events: ${summary.events.length}`);
    console.log(`Position samples: ${summary.positions.length}`);

    if (!showPositions) {
      console.log('');
      console.log(dim('Use --positions for detailed position/heatmap analysis'));
    }

  } catch (error) {
    console.error(red(`Error parsing film: ${error instanceof Error ? error.message : 'Unknown error'}`));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(red('Error:'), error.message);
  process.exit(1);
});
