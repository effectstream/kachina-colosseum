import * as cryptoBrowserify from "crypto-browserify";

function toUint8Array(value: ArrayLike<number>): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }

  return Uint8Array.from(value);
}

export function timingSafeEqual(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
): boolean {
  const left = toUint8Array(a);
  const right = toUint8Array(b);

  if (left.byteLength !== right.byteLength) {
    throw new RangeError("Input buffers must have the same byte length");
  }

  let diff = 0;
  for (let i = 0; i < left.byteLength; i++) {
    diff |= left[i] ^ right[i];
  }

  return diff === 0;
}

export * from "crypto-browserify";

export default {
  ...cryptoBrowserify,
  timingSafeEqual,
};
