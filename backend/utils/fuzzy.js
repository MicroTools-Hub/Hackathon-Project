function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s\u0900-\u097F]/g, "")
    .replace(/\b(store|traders|trading|merchant|merchants|textiles|general|hardware|bros|brothers|electricals|pvt|ltd)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  const matrix = Array.from({ length: b.length + 1 }, (_, index) => [index]);
  for (let index = 0; index <= a.length; index += 1) matrix[0][index] = index;
  for (let row = 1; row <= b.length; row += 1) {
    for (let col = 1; col <= a.length; col += 1) {
      if (b[row - 1] === a[col - 1]) {
        matrix[row][col] = matrix[row - 1][col - 1];
      } else {
        matrix[row][col] = Math.min(
          matrix[row - 1][col - 1] + 1,
          matrix[row][col - 1] + 1,
          matrix[row - 1][col] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

export function scoreNames(input, candidate) {
  const a = normalizeName(input);
  const b = normalizeName(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.92;
  const distance = levenshtein(a, b);
  const characterScore = 1 - distance / Math.max(a.length, b.length);
  const tokensA = new Set(a.split(" ").filter(Boolean));
  const tokensB = new Set(b.split(" ").filter(Boolean));
  const overlap = [...tokensA].filter((token) => tokensB.has(token)).length / Math.max(tokensA.size, tokensB.size, 1);
  return Math.max(0, Math.min(1, characterScore * 0.72 + overlap * 0.28));
}

export function bestClientMatch(clientName, clients) {
  return clients
    .map((client) => ({ client, score: scoreNames(clientName, client.name) }))
    .sort((a, b) => b.score - a.score)[0] || { client: null, score: 0 };
}
