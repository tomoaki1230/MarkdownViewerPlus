// 記法の崩れの確認: 修正で新しく生じた崩れを見つける（コードブロックの閉じ忘れ・表の列数の不一致・リンクの括弧の閉じ忘れ）
// ・元からある崩れは知らせない（レビューの邪魔にしない）。行番号は入力でずれるので、行の中身で比べる
// ・誤検出を避けるため、確実に分かる形だけを調べる。引用の中のコードブロックなどは対象外

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
// 表の本文の終わりになる行（空行・見出し・引用・コードブロック）
const TABLE_END = /^\s*$|^ {0,3}(#{1,6}\s|>|`{3}|~{3})/;
const UNCLOSED_LINK = /!?\[[^\]]*\]\([^)]*$/;

/** 表の行のセルの数（行頭・行末の | は数えない。\| は区切りにならない） */
export function countCells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (/(^|[^\\])\|$/.test(s)) s = s.slice(0, -1);
  let count = 1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '|') count++;
  }
  return count;
}

/**
 * 記法の崩れを探す
 * @param {string} text
 * @returns {Array<{type: 'fence'|'table'|'link', line: number, message: string, key: string}>} line は 0 始まり、key は比べるための名前
 */
export function findSyntaxIssues(text) {
  const lines = text.split('\n');
  const issues = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = FENCE.exec(line);
    if (fence) {
      if (m && m[1][0] === fence.char && m[1].length >= fence.len && m[2].trim() === '') fence = null;
      continue;
    }
    // ` のコードブロックの 1 行目に ` は書けない（それはインラインのコード）
    if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
      fence = { char: m[1][0], len: m[1].length, line: i };
      continue;
    }
    // 4 文字以上の字下げはコードブロックの可能性があるので調べない
    if (/^( {4}|\t)/.test(line)) continue;

    // 表: 見出しの行と区切りの行
    const next = lines[i + 1];
    if (line.includes('|') && next !== undefined && next.includes('|') && TABLE_DELIMITER.test(next)) {
      const columns = countCells(line);
      if (countCells(next) !== columns) {
        issues.push({ type: 'table', line: i, message: `表の見出しと区切りの行の列数が違います（見出し ${columns} 列・区切り ${countCells(next)} 列）。表として表示されません`, key: `table-head\u0001${line}\u0001${next}` });
      }
      let j = i + 2;
      for (; j < lines.length && !TABLE_END.test(lines[j]) && lines[j].includes('|'); j++) {
        const cells = countCells(lines[j]);
        if (cells !== columns) issues.push({ type: 'table', line: j, message: `表の列数が違います（見出し ${columns} 列・この行 ${cells} 列）`, key: `table-row\u0001${columns}\u0001${lines[j]}` });
      }
      i = j - 1;
      continue;
    }

    // リンク: ](… の後に ) が無いまま行が終わる（インラインのコードの中は除く）
    if (UNCLOSED_LINK.test(line.replace(/`[^`]*`/g, ''))) {
      issues.push({ type: 'link', line: i, message: 'リンクの括弧 ) が閉じられていません', key: `link\u0001${line}` });
    }
  }
  if (fence) issues.push({ type: 'fence', line: fence.line, message: 'コードブロックが閉じられていません。この行より後がすべてコードとして表示されます', key: `fence\u0001${lines[fence.line]}` });
  return issues.sort((a, b) => a.line - b.line);
}

/**
 * 保存済みの内容には無かった崩れだけを返す（同じ中身の崩れは数で比べる）
 * @param {string} savedText
 * @param {string} text
 */
export function newSyntaxIssues(savedText, text) {
  const baseline = new Map();
  for (const issue of findSyntaxIssues(savedText)) baseline.set(issue.key, (baseline.get(issue.key) ?? 0) + 1);
  return findSyntaxIssues(text).filter((issue) => {
    const left = baseline.get(issue.key) ?? 0;
    if (left === 0) return true;
    baseline.set(issue.key, left - 1);
    return false;
  });
}
