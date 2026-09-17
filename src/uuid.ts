/**
 * UUID version 7 (RFC 9562): 48 bits of Unix milliseconds, then randomness.
 *
 * Used for ids created on the device — time entries, notes, ops — because an
 * entry created offline must keep its identity when it finally syncs, and v7
 * ids also sort by creation time.
 *
 * Ids made within the same millisecond still sort in the order they were made:
 * each one counts up from the last by a random step (RFC 9562 §6.2, method 2).
 * Things made together — a rollup's entries, two entries in a test — are
 * ordered by id, so without this their order would be a coin toss.
 *
 * Dependency-free and runs in both the browser and Bun.
 */

/** The random part: 12 bits of rand_a and 62 of rand_b. */
const RANDOM_BITS = 74n;
const RAND_B_BITS = 62n;

let lastMs = -1;
let lastRandom = 0n;

function randomBits(bytes: number): bigint {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return n;
}

export function uuidv7(now: number = Date.now()): string {
  let random: bigint;
  if (now === lastMs) {
    // A step of up to 2^32 from a start below 2^73 leaves room for 2^41 ids
    // in one millisecond — more than can be made in one.
    random = lastRandom + 1n + randomBits(4);
  } else {
    // Top bit clear, so counting up within this millisecond can't overflow.
    random = randomBits(10) & ((1n << (RANDOM_BITS - 1n)) - 1n);
  }
  lastMs = now;
  lastRandom = random;

  const bytes = new Uint8Array(16);
  // 48-bit big-endian timestamp. Split to stay within 32-bit bitwise ops.
  const high = Math.floor(now / 2 ** 16);
  const low = now % 2 ** 16;
  bytes[0] = (high >>> 24) & 0xff;
  bytes[1] = (high >>> 16) & 0xff;
  bytes[2] = (high >>> 8) & 0xff;
  bytes[3] = high & 0xff;
  bytes[4] = (low >>> 8) & 0xff;
  bytes[5] = low & 0xff;

  // The random bits go around the version and variant, in order, so the
  // id's text sorts the same way the number does.
  const randA = Number(random >> RAND_B_BITS);
  bytes[6] = 0x70 | (randA >> 8); // version 7
  bytes[7] = randA & 0xff;
  let randB = random & ((1n << RAND_B_BITS) - 1n);
  for (let i = 15; i >= 9; i--) {
    bytes[i] = Number(randB & 0xffn);
    randB >>= 8n;
  }
  bytes[8] = 0x80 | Number(randB); // RFC 4122 variant, then rand_b's top 6 bits

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The millisecond timestamp embedded in a v7 id. */
export function uuidv7Time(id: string): number {
  return Number.parseInt(id.replace(/-/g, "").slice(0, 12), 16);
}
