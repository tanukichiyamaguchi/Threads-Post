// 文字列ユーティリティ。
// JSの .slice() はUTF-16単位で切るため、絵文字（サロゲートペア）の途中で切ると
// 対になっていないサロゲートが残る。Anthropic APIはそれを含むリクエストを
// 400（invalid JSON）で拒否するので、プロンプトに入れる文字列は必ずここを通す。

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** 先頭 n 文字（コードポイント単位）を返す。絵文字の途中では切らない */
export function clip(text: string, n: number): string {
  const chars = Array.from(text);
  return chars.length <= n ? text : chars.slice(0, n).join("");
}

/** 対になっていないサロゲートを取り除く */
export function wellFormed(text: string): string {
  return text.replace(LONE_SURROGATE, "");
}

/** オブジェクト／配列内のすべての文字列に wellFormed を適用した複製を返す */
export function wellFormedDeep<T>(value: T): T {
  if (typeof value === "string") return wellFormed(value) as T;
  if (Array.isArray(value)) return value.map((v) => wellFormedDeep(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = wellFormedDeep(v);
    return out as T;
  }
  return value;
}
