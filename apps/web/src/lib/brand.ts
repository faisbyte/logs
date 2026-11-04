// The product's name in the UI, and the one place CLI commands are built from, so the binary can be renamed later in
// one line (DECISIONS.md D93).

export const PRODUCT = 'logs';
export const CLI = 'sprintdigest';
export const SERVER_CLI = `${CLI}-server`;

/** A CLI command as the UI shows it, e.g. command('context', 'src/auth'). */
export const command = (...args: string[]) => [CLI, ...args].join(' ');
