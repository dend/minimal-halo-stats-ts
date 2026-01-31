/**
 * Halo Infinite Film File Parser
 *
 * Based on reverse engineering findings:
 * - Films are Bond-encoded binary files compressed with zlib (RFC 1950)
 * - 34 chunks: chunk 0 (initial state), chunks 1-32 (delta frames), chunk 33 (summary)
 * - Entity-Component System (ECS) architecture with 263 component types
 */

import { inflateSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// ============================================================================
// Types
// ============================================================================

export interface FilmChunkInfo {
  index: number;
  type: number;
  compressedSize: number;
  decompressedSize: number;
}

export interface ComponentDefinition {
  index: number;
  name: string;
  offset: number;
}

export interface PlayerInfo {
  xuid: string;
  gamertag: string;
  filmTeamId: number;
  offset: number;
}

export interface FilmEvent {
  timestamp: number; // milliseconds from match start
  eventType: number;
  eventTypeName: string;
  playerXuid?: string;
  playerGamertag?: string;
  rawData: Buffer;
}

export interface PositionData {
  x: number;
  y: number;
  z: number;
  offset: number;
}

export interface FilmSummary {
  players: PlayerInfo[];
  events: FilmEvent[];
  positions: PositionData[];
  components: ComponentDefinition[];
}

// Event type mapping based on reverse engineering findings
const EVENT_TYPES: Record<number, string> = {
  0x000: 'spawn/join',
  0x100: 'kill',
  0x200: 'death',
  0x300: 'assist',
  0x400: 'medal_tier1',
  0x500: 'medal_tier2/ctf_action',
  0x600: 'flag_event',
  0x700: 'multi_kill',
  0x800: 'special_event',
  0x900: 'end_of_match',
};

// ============================================================================
// Buffer Reading Utilities
// ============================================================================

class BufferReader {
  private offset: number = 0;
  constructor(private buffer: Buffer) {}

  get position(): number {
    return this.offset;
  }

  get remaining(): number {
    return this.buffer.length - this.offset;
  }

  get length(): number {
    return this.buffer.length;
  }

  seek(offset: number): void {
    this.offset = offset;
  }

  skip(bytes: number): void {
    this.offset += bytes;
  }

  readUInt8(): number {
    const val = this.buffer.readUInt8(this.offset);
    this.offset += 1;
    return val;
  }

  readUInt16LE(): number {
    const val = this.buffer.readUInt16LE(this.offset);
    this.offset += 2;
    return val;
  }

  readUInt32LE(): number {
    const val = this.buffer.readUInt32LE(this.offset);
    this.offset += 4;
    return val;
  }

  readInt32LE(): number {
    const val = this.buffer.readInt32LE(this.offset);
    this.offset += 4;
    return val;
  }

  readBigUInt64LE(): bigint {
    const val = this.buffer.readBigUInt64LE(this.offset);
    this.offset += 8;
    return val;
  }

  readFloatLE(): number {
    const val = this.buffer.readFloatLE(this.offset);
    this.offset += 4;
    return val;
  }

  readBytes(count: number): Buffer {
    const val = this.buffer.subarray(this.offset, this.offset + count);
    this.offset += count;
    return val;
  }

  readNullTerminatedString(maxLength: number = 256): string {
    let end = this.offset;
    while (end < this.offset + maxLength && end < this.buffer.length && this.buffer[end] !== 0) {
      end++;
    }
    const str = this.buffer.subarray(this.offset, end).toString('ascii');
    this.offset = Math.min(this.offset + maxLength, this.buffer.length);
    return str;
  }

  readUTF16LEString(byteLength: number): string {
    const bytes = this.buffer.subarray(this.offset, this.offset + byteLength);
    this.offset += byteLength;
    // Find null terminator (two zero bytes)
    let end = 0;
    while (end < bytes.length - 1) {
      if (bytes[end] === 0 && bytes[end + 1] === 0) break;
      end += 2;
    }
    return bytes.subarray(0, end).toString('utf16le');
  }

  peekUInt16LE(relativeOffset: number = 0): number {
    return this.buffer.readUInt16LE(this.offset + relativeOffset);
  }

  peekUInt32LE(relativeOffset: number = 0): number {
    return this.buffer.readUInt32LE(this.offset + relativeOffset);
  }

  peekBytes(count: number, relativeOffset: number = 0): Buffer {
    return this.buffer.subarray(this.offset + relativeOffset, this.offset + relativeOffset + count);
  }

  indexOf(pattern: Buffer, fromOffset?: number): number {
    return this.buffer.indexOf(pattern, fromOffset ?? this.offset);
  }

  slice(start: number, end: number): Buffer {
    return this.buffer.subarray(start, end);
  }
}

// ============================================================================
// Decompression
// ============================================================================

/**
 * Decompress a zlib-compressed film chunk
 * Film chunks use zlib fast compression (header bytes: 78 5E)
 */
export function decompressChunk(compressedData: Buffer): Buffer {
  // Check for zlib header (78 5E = fast compression, 78 9C = default, 78 DA = best)
  if (compressedData.length < 2) {
    throw new Error('Data too short to be zlib compressed');
  }

  const header = compressedData[0];
  if (header !== 0x78) {
    throw new Error(`Invalid zlib header: expected 0x78, got 0x${header.toString(16)}`);
  }

  try {
    return inflateSync(compressedData);
  } catch (error) {
    throw new Error(`Failed to decompress chunk: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Check if data is zlib compressed by examining header bytes
 */
export function isZlibCompressed(data: Buffer): boolean {
  if (data.length < 2) return false;
  // zlib header: first byte is 0x78, second byte varies by compression level
  return data[0] === 0x78 && (data[1] === 0x5E || data[1] === 0x9C || data[1] === 0xDA || data[1] === 0x01);
}

// ============================================================================
// Component Definition Parser (Chunk 0)
// ============================================================================

/**
 * Parse component definitions from chunk 0
 * Component names are 256-byte null-padded ASCII strings
 */
export function parseComponentDefinitions(data: Buffer): ComponentDefinition[] {
  const components: ComponentDefinition[] = [];
  const reader = new BufferReader(data);

  // Known component name pattern: lowercase with hyphens, ending in "-component"
  const componentPattern = /-component\x00/g;

  let match;
  const dataStr = data.toString('binary');
  while ((match = componentPattern.exec(dataStr)) !== null) {
    const endOffset = match.index + match[0].length - 1; // Position of null terminator

    // Scan backwards to find start of component name
    let startOffset = endOffset;
    while (startOffset > 0 && data[startOffset - 1] !== 0 && data[startOffset - 1] >= 0x20 && data[startOffset - 1] < 0x7F) {
      startOffset--;
    }

    const name = data.subarray(startOffset, endOffset).toString('ascii');
    if (name.length > 3 && name.includes('-')) {
      components.push({
        index: components.length,
        name,
        offset: startOffset,
      });
    }
  }

  // Deduplicate by name
  const seen = new Set<string>();
  return components.filter(c => {
    if (seen.has(c.name)) return false;
    seen.add(c.name);
    return true;
  });
}

// ============================================================================
// Player Data Parser (Chunk 33)
// ============================================================================

/**
 * Search for gamertags in the summary chunk
 * Gamertags are stored as UTF-16LE strings, often 32 bytes (16 chars max)
 */
export function findGamertags(data: Buffer, knownGamertags: string[]): PlayerInfo[] {
  const players: PlayerInfo[] = [];
  const reader = new BufferReader(data);

  for (const gamertag of knownGamertags) {
    // Convert gamertag to UTF-16LE for searching
    const gamertagBuffer = Buffer.from(gamertag, 'utf16le');

    let searchOffset = 0;
    while (true) {
      const foundOffset = data.indexOf(gamertagBuffer, searchOffset);
      if (foundOffset === -1) break;

      // Try to extract player info from surrounding context
      const player: PlayerInfo = {
        xuid: '',
        gamertag,
        filmTeamId: -1,
        offset: foundOffset,
      };

      // Check bytes after gamertag for team ID (typically within 40 bytes)
      // The structure appears to be: gamertag (32 bytes) + flags (4 bytes) + team ID (4 bytes)
      if (foundOffset + 40 < data.length) {
        const possibleTeamId = data.readUInt32LE(foundOffset + 36);
        if (possibleTeamId >= 0 && possibleTeamId <= 7) {
          player.filmTeamId = possibleTeamId;
        }
      }

      // Avoid duplicates at same offset
      if (!players.some(p => p.offset === foundOffset)) {
        players.push(player);
      }

      searchOffset = foundOffset + gamertagBuffer.length;
    }
  }

  return players;
}

/**
 * Search for XUIDs in the data
 * XUIDs are 64-bit integers, typically stored as decimal strings or binary
 */
export function findXuids(data: Buffer, knownXuids: string[]): Map<string, number[]> {
  const xuidLocations = new Map<string, number[]>();

  for (const xuidStr of knownXuids) {
    const xuid = BigInt(xuidStr);
    const locations: number[] = [];

    // Search for XUID as little-endian 64-bit integer
    const xuidBuffer = Buffer.alloc(8);
    xuidBuffer.writeBigUInt64LE(xuid);

    let searchOffset = 0;
    while (true) {
      const foundOffset = data.indexOf(xuidBuffer, searchOffset);
      if (foundOffset === -1) break;
      locations.push(foundOffset);
      searchOffset = foundOffset + 8;
    }

    // Also search for XUID as ASCII decimal string
    const xuidAscii = Buffer.from(xuidStr, 'ascii');
    searchOffset = 0;
    while (true) {
      const foundOffset = data.indexOf(xuidAscii, searchOffset);
      if (foundOffset === -1) break;
      // Verify it's actually a standalone number (check boundary chars)
      const prevChar = foundOffset > 0 ? data[foundOffset - 1] : 0;
      const nextChar = foundOffset + xuidAscii.length < data.length ? data[foundOffset + xuidAscii.length] : 0;
      const isPrevBoundary = prevChar < 0x30 || prevChar > 0x39;
      const isNextBoundary = nextChar < 0x30 || nextChar > 0x39;
      if (isPrevBoundary && isNextBoundary) {
        locations.push(foundOffset);
      }
      searchOffset = foundOffset + xuidAscii.length;
    }

    if (locations.length > 0) {
      xuidLocations.set(xuidStr, locations);
    }
  }

  return xuidLocations;
}

// ============================================================================
// Event Parser (Chunk 33)
// ============================================================================

/**
 * Parse events from the summary chunk
 * Events follow player data structures with event type codes (multiples of 0x100)
 */
export function parseEvents(data: Buffer, knownGamertags: string[]): FilmEvent[] {
  const events: FilmEvent[] = [];
  const reader = new BufferReader(data);

  // Search for known gamertags and then look for event data
  for (const gamertag of knownGamertags) {
    const gamertagBuffer = Buffer.from(gamertag, 'utf16le');

    let searchOffset = 0;
    while (true) {
      const foundOffset = data.indexOf(gamertagBuffer, searchOffset);
      if (foundOffset === -1) break;

      // Look for event data at expected offset (gamertag + 48 bytes)
      const eventDataOffset = foundOffset + 48;
      if (eventDataOffset + 8 < data.length) {
        const eventType = data.readUInt16LE(eventDataOffset);
        const timestamp = data.readUInt32LE(eventDataOffset + 2);

        // Check if this looks like a valid event (event type is multiple of 0x100)
        if (eventType % 0x100 === 0 && eventType <= 0x900 && timestamp < 3600000) {
          events.push({
            timestamp,
            eventType,
            eventTypeName: EVENT_TYPES[eventType] ?? `unknown_${eventType.toString(16)}`,
            playerGamertag: gamertag,
            rawData: data.subarray(eventDataOffset, eventDataOffset + 16),
          });
        }
      }

      searchOffset = foundOffset + gamertagBuffer.length;
    }
  }

  // Sort by timestamp
  events.sort((a, b) => a.timestamp - b.timestamp);

  // Remove duplicates (same timestamp + event type + player)
  return events.filter((event, index, arr) => {
    if (index === 0) return true;
    const prev = arr[index - 1];
    return !(event.timestamp === prev.timestamp &&
             event.eventType === prev.eventType &&
             event.playerGamertag === prev.playerGamertag);
  });
}

// ============================================================================
// Position Data Parser (Chunk 33)
// ============================================================================

/**
 * Extract position vectors from the data
 * Positions are stored as IEEE 754 single-precision floats (3x4 = 12 bytes per XYZ triplet)
 */
export function extractPositions(data: Buffer, sampleRate: number = 100): PositionData[] {
  const positions: PositionData[] = [];

  // Halo Infinite maps typically have coordinates in range -500 to +500
  const MIN_COORD = -600;
  const MAX_COORD = 600;

  // Scan for potential position triplets
  for (let offset = 0; offset < data.length - 12; offset += sampleRate) {
    try {
      const x = data.readFloatLE(offset);
      const y = data.readFloatLE(offset + 4);
      const z = data.readFloatLE(offset + 8);

      // Validate that these look like reasonable coordinates
      if (isFinite(x) && isFinite(y) && isFinite(z) &&
          x >= MIN_COORD && x <= MAX_COORD &&
          y >= MIN_COORD && y <= MAX_COORD &&
          z >= MIN_COORD && z <= MAX_COORD &&
          // Avoid very small values that might be noise
          (Math.abs(x) > 0.1 || Math.abs(y) > 0.1 || Math.abs(z) > 0.1)) {
        positions.push({ x, y, z, offset });
      }
    } catch {
      // Skip invalid reads
    }
  }

  return positions;
}

/**
 * Extract map-relevant positions (likely player positions during gameplay)
 * These are positions with significant X/Y values and reasonable Z (elevation)
 */
export function extractMapPositions(data: Buffer): PositionData[] {
  const positions: PositionData[] = [];

  // Scan every 4 bytes for potential position triplets
  for (let offset = 0; offset < data.length - 12; offset += 4) {
    try {
      const x = data.readFloatLE(offset);
      const y = data.readFloatLE(offset + 4);
      const z = data.readFloatLE(offset + 8);

      // Filter for map-like coordinates:
      // - X/Y in range -300 to 300 (horizontal position on map)
      // - Z in range -20 to 80 (elevation - ground level to high areas)
      // - At least one of X or Y should be significant (> 30)
      if (isFinite(x) && isFinite(y) && isFinite(z) &&
          x > -300 && x < 300 &&
          y > -300 && y < 300 &&
          z > -20 && z < 80 &&
          (Math.abs(x) > 30 || Math.abs(y) > 30)) {
        positions.push({ x, y, z, offset });
      }
    } catch {
      // Skip invalid reads
    }
  }

  return positions;
}

export interface PlayerEventWithPosition extends FilmEvent {
  position?: PositionData;
}

/**
 * Parse events with associated position data
 * Searches near each gamertag occurrence for both event data and position floats
 */
export function parseEventsWithPositions(data: Buffer, knownGamertags: string[]): PlayerEventWithPosition[] {
  const events: PlayerEventWithPosition[] = [];

  for (const gamertag of knownGamertags) {
    const gamertagBuffer = Buffer.from(gamertag, 'utf16le');

    let searchOffset = 0;
    while (true) {
      const foundOffset = data.indexOf(gamertagBuffer, searchOffset);
      if (foundOffset === -1) break;

      // Look for event data at expected offset (gamertag + 48 bytes)
      const eventDataOffset = foundOffset + 48;
      if (eventDataOffset + 8 < data.length) {
        const eventType = data.readUInt16LE(eventDataOffset);
        const timestamp = data.readUInt32LE(eventDataOffset + 2);

        // Check if this looks like a valid event
        if (eventType % 0x100 === 0 && eventType <= 0x900 && timestamp < 700000) {
          const event: PlayerEventWithPosition = {
            timestamp,
            eventType,
            eventTypeName: EVENT_TYPES[eventType] ?? `unknown_${eventType.toString(16)}`,
            playerGamertag: gamertag,
            rawData: data.subarray(eventDataOffset, eventDataOffset + 16),
          };

          // Search for position data in a window around the event
          // Check 200 bytes before and after the gamertag
          const searchStart = Math.max(0, foundOffset - 200);
          const searchEnd = Math.min(data.length - 12, foundOffset + 300);

          for (let i = searchStart; i < searchEnd; i += 4) {
            const x = data.readFloatLE(i);
            const y = data.readFloatLE(i + 4);
            const z = data.readFloatLE(i + 8);

            // Look for valid map coordinates
            if (isFinite(x) && isFinite(y) && isFinite(z) &&
                Math.abs(x) > 30 && Math.abs(x) < 300 &&
                Math.abs(y) > 30 && Math.abs(y) < 300 &&
                z > -20 && z < 80) {
              event.position = { x, y, z, offset: i };
              break;
            }
          }

          events.push(event);
        }
      }

      searchOffset = foundOffset + gamertagBuffer.length;
    }
  }

  // Sort by timestamp
  events.sort((a, b) => a.timestamp - b.timestamp);

  // Remove duplicates
  return events.filter((event, index, arr) => {
    if (index === 0) return true;
    const prev = arr[index - 1];
    return !(event.timestamp === prev.timestamp &&
             event.eventType === prev.eventType &&
             event.playerGamertag === prev.playerGamertag);
  });
}

// ============================================================================
// Player Event Marker Parser
// ============================================================================

/**
 * Find player event markers (0x2DC0) in the data
 * These mark player-related data structures in chunk 0
 */
export function findPlayerEventMarkers(data: Buffer): number[] {
  const marker = Buffer.from([0x2D, 0xC0]);
  const locations: number[] = [];

  let searchOffset = 0;
  while (true) {
    const foundOffset = data.indexOf(marker, searchOffset);
    if (foundOffset === -1) break;
    locations.push(foundOffset);
    searchOffset = foundOffset + 2;
  }

  return locations;
}

// ============================================================================
// Main Film Parser
// ============================================================================

export interface FilmParserOptions {
  filmDir: string;
  knownGamertags?: string[];
  knownXuids?: string[];
}

export class FilmParser {
  private filmDir: string;
  private knownGamertags: string[];
  private knownXuids: string[];

  constructor(options: FilmParserOptions) {
    this.filmDir = options.filmDir;
    this.knownGamertags = options.knownGamertags ?? [];
    this.knownXuids = options.knownXuids ?? [];
  }

  /**
   * Load a chunk from disk (supports both compressed and decompressed files)
   */
  async loadChunk(chunkIndex: number): Promise<Buffer> {
    // Try decompressed first
    const decompressedPath = join(this.filmDir, `filmChunk${chunkIndex}_dec`);
    if (existsSync(decompressedPath)) {
      return readFile(decompressedPath);
    }

    // Fall back to compressed
    const compressedPath = join(this.filmDir, `filmChunk${chunkIndex}`);
    if (!existsSync(compressedPath)) {
      throw new Error(`Chunk ${chunkIndex} not found at ${compressedPath}`);
    }

    const compressed = await readFile(compressedPath);
    if (isZlibCompressed(compressed)) {
      return decompressChunk(compressed);
    }

    return compressed;
  }

  /**
   * Parse the initial state chunk (chunk 0) for component definitions
   */
  async parseInitialState(): Promise<ComponentDefinition[]> {
    const data = await this.loadChunk(0);
    return parseComponentDefinitions(data);
  }

  /**
   * Parse the summary chunk (chunk 33) for players, events, and positions
   */
  async parseSummary(): Promise<Omit<FilmSummary, 'components'>> {
    const data = await this.loadChunk(33);

    const players = findGamertags(data, this.knownGamertags);
    const events = parseEvents(data, this.knownGamertags);
    const positions = extractPositions(data, 50); // Sample every 50 bytes for positions

    // Try to correlate XUIDs with gamertag locations
    const xuidLocations = findXuids(data, this.knownXuids);

    // Attempt to match XUIDs to players based on proximity
    for (const player of players) {
      for (const [xuid, locations] of xuidLocations) {
        for (const loc of locations) {
          // XUIDs are often stored near gamertags (within ~100 bytes)
          if (Math.abs(loc - player.offset) < 100) {
            player.xuid = xuid;
            break;
          }
        }
        if (player.xuid) break;
      }
    }

    return { players, events, positions };
  }

  /**
   * Parse the complete film
   */
  async parse(): Promise<FilmSummary> {
    const components = await this.parseInitialState();
    const summary = await this.parseSummary();

    return {
      components,
      ...summary,
    };
  }

  /**
   * Get chunk information (type, sizes) for all available chunks
   */
  async getChunkInfo(): Promise<FilmChunkInfo[]> {
    const chunks: FilmChunkInfo[] = [];

    for (let i = 0; i <= 33; i++) {
      try {
        const compressedPath = join(this.filmDir, `filmChunk${i}`);
        const decompressedPath = join(this.filmDir, `filmChunk${i}_dec`);

        let compressedSize = 0;
        let decompressedSize = 0;
        let chunkType = 0;

        if (existsSync(compressedPath)) {
          const compressed = await readFile(compressedPath);
          compressedSize = compressed.length;
        }

        if (existsSync(decompressedPath)) {
          const decompressed = await readFile(decompressedPath);
          decompressedSize = decompressed.length;

          // Read chunk type from first 4 bytes
          if (decompressed.length >= 4) {
            chunkType = decompressed.readUInt32LE(0);
          }
        }

        if (compressedSize > 0 || decompressedSize > 0) {
          chunks.push({
            index: i,
            type: chunkType,
            compressedSize,
            decompressedSize,
          });
        }
      } catch {
        // Chunk doesn't exist, skip
      }
    }

    return chunks;
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Format timestamp (milliseconds) as MM:SS.mmm
 */
export function formatTimestamp(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${millis.toString().padStart(3, '0')}`;
}

/**
 * Format position as "(x, y, z)"
 */
export function formatPosition(pos: PositionData): string {
  return `(${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)})`;
}
