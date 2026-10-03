/**
 * Ollama resolves an untagged model name to its ":latest" tag. The tag is whatever follows the
 * last ":" after the final "/", so a registry port (`localhost:5000/team/model`) is not a tag.
 */
export function withDefaultTag(name: string): string {
  const lastSegment = name.slice(name.lastIndexOf("/") + 1);
  return lastSegment.includes(":") ? name : `${name}:latest`;
}
