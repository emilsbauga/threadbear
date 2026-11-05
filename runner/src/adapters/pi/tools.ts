// Keep native Pi names on the wire; reuse Threadbear's tool presentation.
export function displayToolName(name: string): string {
  return ({ bash: 'Bash', read: 'Read', edit: 'Edit', write: 'Write', find: 'Glob', grep: 'Grep', ls: 'LS' } as Record<string, string>)[name] ?? name;
}
