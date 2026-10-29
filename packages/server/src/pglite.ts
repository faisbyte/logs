import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';

/** PGlite with the extensions the migrations need: btree_gist for the sprint overlap constraint (DECISIONS.md D45). */
export const openPGlite = (dataDir?: string) => new PGlite({ ...(dataDir ? { dataDir } : {}), extensions: { btree_gist } });
