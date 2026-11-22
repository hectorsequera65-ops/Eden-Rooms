// Preserve integer IDs that JSON.parse would round before Title ID matching.
// Quoted strings are consumed as tokens, so digits inside labels are untouched.
export function parseLobbyJSON(text) {
  const exact = text.replace(/"(?:\\.|[^"\\])*"|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, (token, numeric) => {
    if (numeric && /^-?\d+$/.test(numeric) && !Number.isSafeInteger(Number(numeric))) return JSON.stringify(numeric);
    return token;
  });
  return JSON.parse(exact);
}
