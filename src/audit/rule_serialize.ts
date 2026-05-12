// Serializes a rules array for embedding inside a <script> block.
//
// Plain JSON.stringify isn't safe inside <script> tags: if any string in
// the rules contains "</script>", "<!--", or "<script>", it breaks out of
// the script element. We escape `<` to its JSON unicode form `<` so
// the JSON parses identically but contains no literal `<` character.

export function serializeRulesForScript(rules: unknown): string {
  return JSON.stringify(rules).replace(/</g, '\\u003c');
}
