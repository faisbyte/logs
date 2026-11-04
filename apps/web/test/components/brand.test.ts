import { CLI, command, PRODUCT, SERVER_CLI } from '~/lib/brand';

// The product is "logs" everywhere in the UI; every CLI command shown comes from one constant (DECISIONS.md D93).
describe('brand', () => {
  it('names the product and builds commands from the one CLI constant', () => {
    expect(PRODUCT).toBe('logs');
    expect(command('context', 'src/auth')).toBe(`${CLI} context src/auth`);
    expect(SERVER_CLI).toBe(`${CLI}-server`);
  });
});
