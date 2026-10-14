import { AsyncLocalStorage } from 'node:async_hooks';

// Per-company display settings (date format, account numbers) for the request or job being handled. Each request and
// each company in the daily jobs runs inside its own store, so two companies' pages, PDFs and emails can never pick up
// each other's settings while they wait on the database.
const store = new AsyncLocalStorage();
const fallback = {};
export const displaySettings = () => store.getStore() ?? fallback;
export const withDisplay = fn => store.run({}, fn);
