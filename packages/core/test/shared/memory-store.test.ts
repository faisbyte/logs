import { InMemorySummaryStore } from '../../src/shared/memory-store.js';
import { summaryStoreContract } from './store-contract.js';

summaryStoreContract('InMemorySummaryStore', () => new InMemorySummaryStore());
