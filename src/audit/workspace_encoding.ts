// Encodes a workspace path to the form Claude Code uses for its
// `~/.claude/projects/<encoded>/` directory. CC replaces every path
// separator with `-` and keeps hyphens in path components verbatim.
//
// COLLISION CAVEAT: the encoding is many-to-one — both
// `/Users/me/arch-viewer` and `/Users/me/arch/viewer` encode to
// `-Users-me-arch-viewer`. Two distinct workspaces whose paths differ
// only in `/` vs `-` placement will share a CC transcript directory and
// their audit history will cross-contaminate. We accept this because (a)
// CC itself uses this scheme and we have to match it to find transcripts,
// and (b) the collision is rare in practice (sibling paths whose hyphen
// pattern aligns exactly). Document this in user-facing docs if it bites.
//
// Cross-platform: handles POSIX `/` and Windows `\\`, including paths
// that mix both.
export function encodeWorkspaceForCC(root: string): string {
  return root.replace(/[\\/]/g, '-');
}
