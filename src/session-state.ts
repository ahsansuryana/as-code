// Tracks which files have been read in the current session
// Used by edit_file to prevent blind edits
const sessionReadFiles = new Set<string>();

export function markFileAsRead(filePath: string): void {
  sessionReadFiles.add(filePath);
}

export function hasFileBeenRead(filePath: string): boolean {
  return sessionReadFiles.has(filePath);
}

export function getReadFiles(): string[] {
  return [...sessionReadFiles];
}
