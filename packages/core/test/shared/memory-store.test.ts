import { InMemorySummaryStore } from '../../src/shared/memory-store.js';
import { summaryStoreContract } from './store-contract.js';
import { digestStoreContract } from './digest-contract.js';
import { ticketStoreContract } from './ticket-contract.js';
import { contextStoreContract } from './context-contract.js';
import { sessionContract } from './session-contract.js';

summaryStoreContract('InMemorySummaryStore', () => new InMemorySummaryStore());
ticketStoreContract('InMemorySummaryStore', () => new InMemorySummaryStore());
digestStoreContract('InMemorySummaryStore', () => new InMemorySummaryStore());
contextStoreContract('InMemorySummaryStore', () => new InMemorySummaryStore());
sessionContract('InMemorySummaryStore', (now) => new InMemorySummaryStore({ now }));
