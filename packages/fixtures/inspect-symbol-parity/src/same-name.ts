export function duplicate(value: string): string {
  return value.toUpperCase();
}

export const duplicateBox = {
  duplicate(value: number): number {
    return value + 1;
  }
};

export const duplicateText = duplicate("alpha");
export const duplicateNumber = duplicateBox.duplicate(1);
