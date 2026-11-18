// Minimal, zero-dependency ISO/IEC 18004 QR Code encoder (Byte mode, EC Level M, Versions 1-15).
// Used to render share-link QR codes 100% locally without leaking URL fragments to third-party services.

const EC_LEVEL_M_BITS = 0b00; // Format info EC indicator for M

// [version]: [ecPerBlock, group1Blocks, group1Data, group2Blocks, group2Data]
const VERSION_M_SPECS = [
  null,
  [10, 1, 16, 0, 0], // V1 (21x21)
  [16, 1, 28, 0, 0], // V2 (25x25)
  [26, 1, 44, 0, 0], // V3 (29x29)
  [18, 2, 32, 0, 0], // V4 (33x33)
  [24, 2, 43, 0, 0], // V5 (37x37)
  [16, 4, 27, 0, 0], // V6 (41x41)
  [18, 4, 31, 0, 0], // V7 (45x45)
  [22, 2, 38, 2, 39], // V8 (49x49)
  [22, 3, 36, 2, 37], // V9 (53x53)
  [26, 4, 43, 1, 44], // V10 (57x57)
  [30, 1, 50, 4, 51], // V11 (61x61)
  [22, 6, 36, 2, 37], // V12 (65x65)
  [22, 8, 37, 1, 38], // V13 (69x69)
  [24, 4, 40, 5, 41], // V14 (73x73)
  [24, 5, 41, 5, 42] // V15 (77x77)
];

const ALIGNMENT_POSITIONS = [
  null,
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70]
];

// GF(256) with primitive polynomial 0x11d
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) {
      x ^= 0x11d;
    }
  }
  for (let i = 255; i < 512; i += 1) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
}

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    const factor = GF_EXP[i];
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function rsComputeEc(data, ecLength) {
  const gen = rsGeneratorPoly(ecLength);
  const remainder = new Uint8Array(ecLength);
  for (let i = 0; i < data.length; i += 1) {
    const factor = data[i] ^ remainder[0];
    remainder.copyWithin(0, 1);
    remainder[ecLength - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecLength; j += 1) {
        remainder[j] ^= gfMul(gen[j + 1], factor);
      }
    }
  }
  return remainder;
}

function selectVersion(byteLength) {
  for (let v = 1; v < VERSION_M_SPECS.length; v += 1) {
    const [, g1b, g1d, g2b, g2d] = VERSION_M_SPECS[v];
    const totalDataCodewords = g1b * g1d + g2b * g2d;
    const countBits = v <= 9 ? 8 : 16;
    const overheadBits = 4 + countBits;
    const capacityBytes = Math.floor((totalDataCodewords * 8 - overheadBits) / 8);
    if (byteLength <= capacityBytes) {
      return v;
    }
  }
  throw new Error("Input too long for QR code (max 412 bytes at EC level M).");
}

function encodeDataCodewords(bytes, version) {
  const [, g1b, g1d, g2b, g2d] = VERSION_M_SPECS[version];
  const totalDataCodewords = g1b * g1d + g2b * g2d;
  const bits = [];

  function pushBits(value, length) {
    for (let i = length - 1; i >= 0; i -= 1) {
      bits.push((value >>> i) & 1);
    }
  }

  // Mode indicator: Byte (0100)
  pushBits(0b0100, 4);
  // Character count
  pushBits(bytes.length, version <= 9 ? 8 : 16);
  // Payload bytes
  for (const byte of bytes) {
    pushBits(byte, 8);
  }
  // Terminator (up to 4 zero bits)
  const maxBits = totalDataCodewords * 8;
  const terminatorLen = Math.min(4, maxBits - bits.length);
  pushBits(0, terminatorLen);
  // Pad to byte boundary
  while (bits.length % 8 !== 0) {
    bits.push(0);
  }

  const codewords = new Uint8Array(totalDataCodewords);
  let idx = 0;
  for (let i = 0; i < bits.length; i += 8) {
    let val = 0;
    for (let b = 0; b < 8; b += 1) {
      val = (val << 1) | bits[i + b];
    }
    codewords[idx++] = val;
  }

  // Pad codewords alternating 0xEC, 0x11
  let padToggle = true;
  while (idx < totalDataCodewords) {
    codewords[idx++] = padToggle ? 0xec : 0x11;
    padToggle = !padToggle;
  }

  return codewords;
}

function buildFinalCodewords(dataCodewords, version) {
  const [ecPerBlock, g1b, g1d, g2b, g2d] = VERSION_M_SPECS[version];
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;

  for (let i = 0; i < g1b; i += 1) {
    const block = dataCodewords.subarray(offset, offset + g1d);
    dataBlocks.push(block);
    ecBlocks.push(rsComputeEc(block, ecPerBlock));
    offset += g1d;
  }
  for (let i = 0; i < g2b; i += 1) {
    const block = dataCodewords.subarray(offset, offset + g2d);
    dataBlocks.push(block);
    ecBlocks.push(rsComputeEc(block, ecPerBlock));
    offset += g2d;
  }

  const result = [];
  const maxDataLen = Math.max(g1d, g2d);
  for (let col = 0; col < maxDataLen; col += 1) {
    for (const block of dataBlocks) {
      if (col < block.length) {
        result.push(block[col]);
      }
    }
  }
  for (let col = 0; col < ecPerBlock; col += 1) {
    for (const block of ecBlocks) {
      result.push(block[col]);
    }
  }
  return Uint8Array.from(result);
}

function createMatrix(version) {
  const size = 17 + 4 * version;
  const modules = Array.from({ length: size }, () => new Uint8Array(size));
  const isFunction = Array.from({ length: size }, () => new Uint8Array(size));

  function setFunction(row, col, dark) {
    if (row < 0 || row >= size || col < 0 || col >= size) return;
    modules[row][col] = dark ? 1 : 0;
    isFunction[row][col] = 1;
  }

  function drawFinder(topRow, leftCol) {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const rr = topRow + r;
        const cc = leftCol + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const inBorder = r === 0 || r === 6 || c === 0 || c === 6;
        const inCenter = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        const isSeparator = r === -1 || r === 7 || c === -1 || c === 7;
        setFunction(rr, cc, !isSeparator && (inBorder || inCenter));
      }
    }
  }

  function drawAlignment(centerRow, centerCol) {
    for (let r = -2; r <= 2; r += 1) {
      for (let c = -2; c <= 2; c += 1) {
        const dark = Math.max(Math.abs(r), Math.abs(c)) !== 1;
        setFunction(centerRow + r, centerCol + c, dark);
      }
    }
  }

  // Finder patterns
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i += 1) {
    const dark = i % 2 === 0;
    setFunction(6, i, dark);
    setFunction(i, 6, dark);
  }

  // Alignment patterns
  const positions = ALIGNMENT_POSITIONS[version];
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = 0; j < positions.length; j += 1) {
      const r = positions[i];
      const c = positions[j];
      const overlapsFinder =
        (i === 0 && j === 0) ||
        (i === 0 && j === positions.length - 1) ||
        (i === positions.length - 1 && j === 0);
      if (!overlapsFinder) {
        drawAlignment(r, c);
      }
    }
  }

  // Dark module
  setFunction(size - 8, 8, true);

  // Reserve format info areas
  for (let i = 0; i < 9; i += 1) {
    if (!isFunction[8][i]) setFunction(8, i, false);
    if (!isFunction[i][8]) setFunction(i, 8, false);
  }
  for (let i = 0; i < 8; i += 1) {
    if (!isFunction[8][size - 1 - i]) setFunction(8, size - 1 - i, false);
    if (!isFunction[size - 1 - i][8]) setFunction(size - 1 - i, 8, false);
  }

  // Version info areas (versions >= 7)
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i += 1) {
      rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    }
    const versionBits = (version << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const bit = ((versionBits >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = (i % 3) + size - 11;
      setFunction(a, b, bit);
      setFunction(b, a, bit);
    }
  }

  return { size, modules, isFunction };
}

function placeDataBits(matrix, finalCodewords) {
  const { size, modules, isFunction } = matrix;
  let bitIndex = 0;
  const totalBits = finalCodewords.length * 8;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (let dx = 0; dx < 2; dx += 1) {
        const col = right - dx;
        if (!isFunction[row][col]) {
          let dark = false;
          if (bitIndex < totalBits) {
            const byte = finalCodewords[bitIndex >>> 3];
            dark = ((byte >>> (7 - (bitIndex & 7))) & 1) === 1;
            bitIndex += 1;
          }
          modules[row][col] = dark ? 1 : 0;
        }
      }
    }
    upward = !upward;
  }
}

function applyMaskPattern(modules, isFunction, maskId) {
  const size = modules.length;
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (isFunction[r][c]) continue;
      let invert = false;
      switch (maskId) {
        case 0: invert = (r + c) % 2 === 0; break;
        case 1: invert = r % 2 === 0; break;
        case 2: invert = c % 3 === 0; break;
        case 3: invert = (r + c) % 3 === 0; break;
        case 4: invert = (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; break;
        case 5: invert = ((r * c) % 2) + ((r * c) % 3) === 0; break;
        case 6: invert = (((r * c) % 2) + ((r * c) % 3)) % 2 === 0; break;
        case 7: invert = (((r + c) % 2) + ((r * c) % 3)) % 2 === 0; break;
      }
      if (invert) {
        modules[r][c] ^= 1;
      }
    }
  }
}

function writeFormatInfo(modules, maskId) {
  const size = modules.length;
  const data = (EC_LEVEL_M_BITS << 3) | maskId;
  let rem = data;
  for (let i = 0; i < 10; i += 1) {
    rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  }
  const bits = ((data << 10) | rem) ^ 0x5412;

  for (let i = 0; i < 15; i += 1) {
    const dark = ((bits >>> i) & 1) === 1 ? 1 : 0;
    if (i < 6) {
      modules[i][8] = dark;
    } else if (i < 8) {
      modules[i + 1][8] = dark;
    } else {
      modules[size - 15 + i][8] = dark;
    }

    if (i < 8) {
      modules[8][size - 1 - i] = dark;
    } else if (i < 9) {
      modules[8][15 - i] = dark;
    } else {
      modules[8][14 - i] = dark;
    }
  }
}

function computePenalty(modules) {
  const size = modules.length;
  let penalty = 0;

  // Rule 1: 5+ same-colored modules in a row/col
  for (let r = 0; r < size; r += 1) {
    let runColor = modules[r][0];
    let runLen = 1;
    for (let c = 1; c < size; c += 1) {
      if (modules[r][c] === runColor) {
        runLen += 1;
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5);
        runColor = modules[r][c];
        runLen = 1;
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5);
  }

  for (let c = 0; c < size; c += 1) {
    let runColor = modules[0][c];
    let runLen = 1;
    for (let r = 1; r < size; r += 1) {
      if (modules[r][c] === runColor) {
        runLen += 1;
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5);
        runColor = modules[r][c];
        runLen = 1;
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5);
  }

  // Rule 2: 2x2 blocks
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) {
        penalty += 3;
      }
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 patterns
  const p1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const p2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c <= size - 11; c += 1) {
      let m1 = true;
      let m2 = true;
      for (let k = 0; k < 11; k += 1) {
        if (modules[r][c + k] !== p1[k]) m1 = false;
        if (modules[r][c + k] !== p2[k]) m2 = false;
      }
      if (m1) penalty += 40;
      if (m2) penalty += 40;
    }
  }
  for (let c = 0; c < size; c += 1) {
    for (let r = 0; r <= size - 11; r += 1) {
      let m1 = true;
      let m2 = true;
      for (let k = 0; k < 11; k += 1) {
        if (modules[r + k][c] !== p1[k]) m1 = false;
        if (modules[r + k][c] !== p2[k]) m2 = false;
      }
      if (m1) penalty += 40;
      if (m2) penalty += 40;
    }
  }

  // Rule 4: dark module balance
  let darkCount = 0;
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (modules[r][c]) darkCount += 1;
    }
  }
  const total = size * size;
  const k = Math.floor(Math.abs(darkCount * 20 - total * 10) / total);
  penalty += k * 10;

  return penalty;
}

/**
 * Encodes a UTF-8 string into a QR code matrix (EC level M).
 * @param {string} text
 * @returns {{ version: number, size: number, modules: Uint8Array[] }}
 */
export function encodeQrMatrix(text) {
  const bytes = new TextEncoder().encode(String(text || ""));
  const version = selectVersion(bytes.length);
  const dataCodewords = encodeDataCodewords(bytes, version);
  const finalCodewords = buildFinalCodewords(dataCodewords, version);

  const baseMatrix = createMatrix(version);
  placeDataBits(baseMatrix, finalCodewords);

  let bestMask = 0;
  let bestPenalty = Infinity;
  let bestModules = null;

  for (let maskId = 0; maskId < 8; maskId += 1) {
    const candidate = baseMatrix.modules.map((row) => new Uint8Array(row));
    applyMaskPattern(candidate, baseMatrix.isFunction, maskId);
    writeFormatInfo(candidate, maskId);
    const penalty = computePenalty(candidate);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = maskId;
      bestModules = candidate;
    }
  }

  return {
    version,
    size: baseMatrix.size,
    maskId: bestMask,
    modules: bestModules
  };
}

/**
 * Builds an SVG path string and viewBox size for a QR code.
 * @param {string} text
 * @param {number} [quietZone=2]
 * @returns {{ viewBoxSize: number, path: string, size: number }}
 */
export function buildQrSvgData(text, quietZone = 2) {
  const { size, modules } = encodeQrMatrix(text);
  const parts = [];
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (modules[r][c]) {
        parts.push(`M${c + quietZone},${r + quietZone}h1v1h-1z`);
      }
    }
  }
  return {
    size,
    viewBoxSize: size + quietZone * 2,
    path: parts.join("")
  };
}
