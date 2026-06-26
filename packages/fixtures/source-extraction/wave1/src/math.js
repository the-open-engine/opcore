export function add(left, right) {
  return left + right;
}

export function double(value) {
  return add(value, value);
}

export const exportedOffset = 1;

const internalFactor = 2;

export function scaledDouble(value) {
  return double(value) * internalFactor + exportedOffset;
}
