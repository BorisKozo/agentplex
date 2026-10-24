/** Extensions that open as read-only plain text from the workspace tree or terminal links. */
export const TEXT_EXTENSIONS = [
  'json', 'md', 'markdown', 'html', 'htm', 'csv', 'tsv', 'mmd', 'mermaid',
  'txt', 'log', 'yaml', 'yml', 'xml', 'toml',
  'ini', 'conf', 'config', 'env', 'jsonl', 'ndjson',
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
  'css', 'scss', 'py', 'rb', 'go', 'rs',
  'java', 'c', 'h', 'cpp', 'hpp', 'cs',
  'sql', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd',
  'r',
] as const;

const textExtensions = new Set<string>(TEXT_EXTENSIONS);

export function isTextFile(extension: string): boolean {
  return textExtensions.has(extension.replace(/^\./, '').toLowerCase());
}
