export type ChalkLike = {
  (...text: unknown[]): string;
  red: ChalkLike;
  green: ChalkLike;
  yellow: ChalkLike;
  dim: ChalkLike;
  bold: ChalkLike;
  white: ChalkLike;
  hex(color: string): ChalkLike;
  bgHex(color: string): ChalkLike;
};
